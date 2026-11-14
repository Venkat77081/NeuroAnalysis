"""Takes and resumable multipart uploads with SHA-256 verification (DEV_PLAN §13.2, §15)."""

import math
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.models import Session, Take, TakeFile
from app.security import Principal, current_principal, require_role
from app.storage import Part, get_storage

router = APIRouter(prefix="/takes", tags=["takes"])

KINDS = {"video", "frames", "landmarks", "sensors", "quality", "meta"}
MAX_FILE = 4 * 1024**3


class FileIn(BaseModel):
    kind: str
    size_bytes: int = Field(ge=0, le=MAX_FILE)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class TakeIn(BaseModel):
    session_id: str
    client_take_id: str = Field(min_length=1, max_length=64)
    test_code: str = Field(pattern=r"^(FT|FTF|FR|SAW|FA)$")
    side: str | None = Field(default=None, pattern=r"^[RL]$")
    take_no: int = Field(ge=1, le=100)
    capture_verdict: str = Field(pattern=r"^(PASS|RETAKE|OVERRIDE)$")
    override_reason: str | None = Field(default=None, pattern=r"^[a-z_]+$")
    flagged_for_review: bool = False
    quality: dict
    meta: dict
    wrapped_data_key: str = Field(max_length=1024)
    key_id: str = Field(max_length=50)
    files: list[FileIn]


class PartUrl(BaseModel):
    number: int
    url: str


class UploadedPart(BaseModel):
    number: int
    etag: str


class FilePlan(BaseModel):
    kind: str
    part_size: int
    parts_total: int
    #: Parts still to upload (with fresh URLs); empty when the file is verified.
    parts: list[PartUrl]
    #: Parts already on the server with their ETags (needed to complete after a restart).
    uploaded_parts: list[UploadedPart]
    verified: bool


class TakePlan(BaseModel):
    take_id: str
    status: str
    files: list[FilePlan]


def _plan(take: Take, files: list[TakeFile]) -> TakePlan:
    st = get_storage()
    size = get_settings().part_size
    out = []
    for f in files:
        total = max(1, math.ceil(f.size_bytes / size))
        if f.uploaded_at:
            out.append(
                FilePlan(
                    kind=f.kind, part_size=size, parts_total=total, parts=[], uploaded_parts=[], verified=True
                )
            )
            continue
        have = {p.number: p.etag for p in st.list_parts(f.object_key, f.upload_id or "")}
        missing = [n for n in range(1, total + 1) if n not in have]
        out.append(
            FilePlan(
                kind=f.kind,
                part_size=size,
                parts_total=total,
                parts=[
                    PartUrl(number=n, url=st.part_url(f.object_key, f.upload_id or "", n)) for n in missing
                ],
                uploaded_parts=[UploadedPart(number=n, etag=e) for n, e in sorted(have.items())],
                verified=False,
            )
        )
    return TakePlan(take_id=take.id, status=take.status, files=out)


def _take(db: DbSession, p: Principal, take_id: str) -> Take:
    t = db.get(Take, take_id)
    s = db.get(Session, t.session_id) if t else None
    if not t or not s or s.device_id != p.device.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "take not found")
    return t


def _files(db: DbSession, take_id: str) -> list[TakeFile]:
    return list(db.scalars(select(TakeFile).where(TakeFile.take_id == take_id).order_by(TakeFile.kind)))


@router.post("", response_model=TakePlan, status_code=201)
def create_take(
    body: TakeIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> TakePlan:
    s = db.get(Session, body.session_id)
    if not s or s.device_id != p.device.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    existing = db.scalar(
        select(Take).where(Take.session_id == s.id, Take.client_take_id == body.client_take_id)
    )
    if existing:  # retry after a lost response, or resume after a restart
        return _plan(existing, _files(db, existing.id))
    kinds = [f.kind for f in body.files]
    if len(set(kinds)) != len(kinds) or not set(kinds) <= KINDS or "video" not in kinds:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "files: unique kinds from the list, video required"
        )
    take = Take(
        client_take_id=body.client_take_id,
        session_id=s.id,
        test_code=body.test_code,
        side=body.side,
        take_no=body.take_no,
        capture_verdict=body.capture_verdict,
        override_reason=body.override_reason,
        flagged_for_review=body.flagged_for_review,
        quality=body.quality,
        meta=body.meta,
        wrapped_data_key=body.wrapped_data_key,
        key_id=body.key_id,
        status="uploading",
        checksums={f.kind: f.sha256 for f in body.files},
    )
    db.add(take)
    db.flush()
    st = get_storage()
    files = []
    for f in body.files:
        key = f"{p.operator.site_id}/{s.id}/{take.id}/{f.kind}.enc"
        tf = TakeFile(
            take_id=take.id,
            kind=f.kind,
            object_key=key,
            upload_id=st.create_upload(key),
            size_bytes=f.size_bytes,
            sha256=f.sha256,
        )
        db.add(tf)
        files.append(tf)
    audit(
        db,
        "operator",
        p.operator.id,
        "take_created",
        "take",
        take.id,
        verdict=body.capture_verdict,
        flagged=body.flagged_for_review,
    )
    db.commit()
    return _plan(take, files)


@router.get("/{take_id}/upload", response_model=TakePlan)
def upload_plan(take_id: str, p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)):  # noqa: B008
    """Resume: what is already on the server and fresh URLs for the missing parts."""
    t = _take(db, p, take_id)
    return _plan(t, _files(db, t.id))


class PartIn(BaseModel):
    number: int = Field(ge=1, le=10000)
    etag: str


class CompleteFileIn(BaseModel):
    parts: list[PartIn]


@router.post("/{take_id}/files/{kind}/complete", response_model=TakePlan)
def complete_file(
    take_id: str,
    kind: str,
    body: CompleteFileIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
):
    t = _take(db, p, take_id)
    f = db.scalar(select(TakeFile).where(TakeFile.take_id == t.id, TakeFile.kind == kind))
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not found")
    if f.uploaded_at:
        return _plan(t, _files(db, t.id))
    st = get_storage()
    try:
        st.complete(f.object_key, f.upload_id or "", [Part(x.number, x.etag, 0) for x in body.parts])
    except Exception as exc:  # noqa: BLE001 - storage reports missing parts in its own way
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "parts_incomplete"}) from exc
    actual = st.sha256(f.object_key)
    if actual != f.sha256 or st.size(f.object_key) != f.size_bytes:
        # Checksum mismatch (§15): start a fresh upload of this file; the phone re-sends it.
        f.upload_id = st.create_upload(f.object_key)
        audit(db, "system", None, "checksum_mismatch", "take", t.id, kind=kind)
        db.commit()
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "checksum_mismatch", "kind": kind})
    f.uploaded_at = datetime.now(UTC)
    f.upload_id = None
    db.commit()
    return _plan(t, _files(db, t.id))


class TakeDone(BaseModel):
    take_id: str
    status: str
    confirmed_at: datetime


@router.post("/{take_id}/complete", response_model=TakeDone)
def complete_take(take_id: str, p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)):  # noqa: B008
    """All files verified → `complete`. The phone may delete its copy after the retention time."""
    t = _take(db, p, take_id)
    files = _files(db, t.id)
    if not files or any(f.uploaded_at is None for f in files):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "files_pending"})
    if t.status != "complete":
        t.status = "complete"
        t.uploaded_at = datetime.now(UTC)
        audit(db, "operator", p.operator.id, "take_uploaded", "take", t.id)
        db.commit()
    return TakeDone(take_id=t.id, status=t.status, confirmed_at=t.uploaded_at)


class TakeRow(BaseModel):
    id: str
    session_id: str
    test_code: str
    side: str | None
    take_no: int
    capture_verdict: str
    flagged_for_review: bool
    status: str


@router.get("", response_model=list[TakeRow])
def list_takes(
    session_id: str | None = None,
    flagged: bool | None = Query(default=None),  # noqa: B008
    p: Principal = Depends(require_role("reviewer", "admin")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
):
    q = select(Take).join(Session, Session.id == Take.session_id)
    q = q.where(Session.device_id.in_(_site_devices(db, p.operator.site_id)))
    if session_id:
        q = q.where(Take.session_id == session_id)
    if flagged is not None:
        q = q.where(Take.flagged_for_review == flagged)
    return [TakeRow.model_validate(t, from_attributes=True) for t in db.scalars(q.order_by(Take.created_at))]


def _site_devices(db: DbSession, site_id: str):
    from app.models import Device

    return select(Device.id).where(Device.site_id == site_id)
