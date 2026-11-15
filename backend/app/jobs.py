"""Background jobs (v3): delete the recordings of patients who withdrew, once their hospital's
retention (`withdrawn_retention_days`) has passed. The appointment history and session rows stay.

    python -m app.jobs purge-withdrawn
"""

import logging
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.models import BiomarkerRun, DeletionRequest, PatientAccount, Session, Site, Take, TakeFile

log = logging.getLogger("neurocapture.jobs")


def purge_withdrawn(db: DbSession, now: datetime | None = None) -> int:
    """Returns the number of takes whose recordings were deleted."""
    from app.storage.sites import storage_of

    now = now or datetime.now(UTC)
    deleted = 0
    q = (
        select(PatientAccount, Site)
        .join(Site, Site.id == PatientAccount.site_id)
        .where(
            PatientAccount.status == "closed",
            PatientAccount.withdrawn_at.isnot(None),
            Site.withdrawn_retention_days.isnot(None),
        )
    )
    for acc, site in db.execute(q).all():
        w = acc.withdrawn_at if acc.withdrawn_at.tzinfo else acc.withdrawn_at.replace(tzinfo=UTC)
        if now < w + timedelta(days=site.withdrawn_retention_days):
            continue
        sessions = list(
            db.scalars(
                select(Session).where(
                    Session.patient_id == acc.patient_id, Session.recordings_deleted_at.is_(None)
                )
            )
        )
        hospital_bucket = False
        for s in sessions:
            for t in db.scalars(select(Take).where(Take.session_id == s.id)):
                for f in db.scalars(select(TakeFile).where(TakeFile.take_id == t.id)):
                    st = storage_of(f)
                    if getattr(st, "readable", True):
                        try:
                            _delete_object(st, f.object_key)
                        except Exception:  # noqa: BLE001 - a missing object is already gone
                            log.warning("could not delete an object of take %s", t.id)
                    else:
                        hospital_bucket = True  # upload-only role: the hospital deletes it
                    db.delete(f)
                for run in db.scalars(select(BiomarkerRun).where(BiomarkerRun.take_id == t.id)):
                    db.delete(run)
                db.delete(t)
                deleted += 1
            s.recordings_deleted_at = now
        if sessions:
            if hospital_bucket:
                db.add(DeletionRequest(site_id=site.id, patient_id=acc.patient_id))
            audit(
                db,
                "system",
                None,
                "recordings_deleted",
                "patient",
                acc.patient_id,
                site_id=site.id,
                reason="withdrawn_retention",
                sessions=len(sessions),
            )
        db.commit()
    return deleted


def _delete_object(st, key: str) -> None:
    from app.storage import LocalStorage, S3Storage

    if isinstance(st, LocalStorage):
        (st.root / "objects" / key).unlink(missing_ok=True)
    elif isinstance(st, S3Storage):
        st.s3.delete_object(Bucket=st.bucket, Key=key)


def main(argv: list[str]) -> None:
    from app.db import _factory

    if argv[:1] != ["purge-withdrawn"]:
        raise SystemExit("usage: python -m app.jobs purge-withdrawn")
    with _factory()() as db:
        print(purge_withdrawn(db))  # noqa: T201


if __name__ == "__main__":
    main(sys.argv[1:])
