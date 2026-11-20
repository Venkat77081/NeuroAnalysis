"""Biomarker analysis at the hospital (M15, decisions 057 and 059).

A doctor asks for a take's biomarkers; the connector decrypts the video (only it holds the take
key), runs the analysis package (`ncbio`, biomarkers/) in the background and keeps the result and
the report in the hospital's database. The platform never sees the video, the values or the
report. One take is analysed at a time; a take is analysed once unless the doctor asks again.

`ncbio` is an optional install (MediaPipe is large): without it the connector says so
("analysis_not_installed") and everything else works as before.
"""

from __future__ import annotations

import json
import logging
import tempfile
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ncconnector import activity, platform, takes
from ncconnector.db import BiomarkerFiles, BiomarkerRun, KeyValue, NcidMap, factory, now
from ncconnector.keys import take_private_key
from ncconnector.storage import read_object, write_object
from ncconnector.takecrypto import (
    FILE_NAMES,
    decrypt_file,
    encrypt_file,
    new_data_keyset,
    unwrap_data_key,
    wrap_data_key,
)

log = logging.getLogger("ncconnector.biomarkers")

Analyser = Callable[[Path, str, str], tuple[dict, str]]

#: Tests set this to a stand-in; None means "use ncbio if it is installed".
ANALYSER: Analyser | None = None

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="biomarkers")
_futures: list[Future] = []


def analyser() -> Analyser | None:
    if ANALYSER is not None:
        return ANALYSER
    try:
        from ncbio.run import analyse_take
    except ImportError:
        return None
    return lambda video, test, ncid: analyse_take(video, test, ncid=ncid)


def supported_tests() -> frozenset[str]:
    if ANALYSER is not None:
        return frozenset({"FT"})
    try:
        from ncbio.run import REPORT_TESTS
    except ImportError:
        return frozenset()
    return REPORT_TESTS


def run_out(r: BiomarkerRun) -> dict:
    """What the dashboard sees of a run: no values here (they are in the report)."""
    return {
        "take_id": r.take_id,
        "test_code": r.test_code,
        "status": r.status,
        "reason": r.reason,
        "requested_at": r.requested_at,
        "finished_at": r.finished_at,
    }


def start(db: DbSession, take: dict, staff_id: str, video: bytes) -> BiomarkerRun:
    """Queues the analysis of one take (`take`: the platform's record; video already decrypted)."""
    take_id = take["take_id"]
    run = db.get(BiomarkerRun, take_id) or BiomarkerRun(
        take_id=take_id, ncid=take["ncid"], test_code=take["test_code"]
    )
    run.status = "running"
    run.reason = None
    run.result = None
    run.report = None
    run.requested_by = staff_id
    run.requested_at = now()
    run.finished_at = None
    db.add(run)
    db.commit()
    fn = analyser()
    assert fn is not None  # callers check first
    tmp = tempfile.NamedTemporaryFile(prefix="nc-take-", suffix=".mp4", delete=False)  # noqa: SIM115
    try:
        tmp.write(video)
    finally:
        tmp.close()
    _futures.append(_pool.submit(_work, fn, Path(tmp.name), take))
    return run


def _store_in_cloud(take: dict, result: dict, report: str) -> dict | None:
    """Decision 060: the result and the report go next to the take in the hospital's own storage,
    encrypted with the hospital's take key (the platform can write to that storage, so it must not
    be able to read them). Returns where they are, or None when the take is in development storage
    (then they stay in the connector's database)."""
    video = next((f for f in take["files"] if f["kind"] == "video"), None)
    loc = video.get("location") if video else None
    if not loc:
        return None
    key = take_private_key(take["key_id"])
    if key is None:
        raise RuntimeError("no take key")
    keyset = new_data_keyset()
    folder = loc["key"].rsplit("/", 1)[0]
    out = {"key_id": take["key_id"], "wrapped_key": wrap_data_key(keyset, key.public_key())}
    for kind, data in (
        ("bio_result", json.dumps(result).encode()),
        ("bio_report", report.encode()),
    ):
        target = {**loc, "key": f"{folder}/{FILE_NAMES[kind]}.enc"}
        write_object(target, encrypt_file(keyset, take["take_id"], kind, data))
        out[kind] = target
    return out


def load_report(db: DbSession, run: BiomarkerRun) -> str | None:
    """The report: from the hospital's storage (decrypted here), or from this database."""
    stored = db.get(BiomarkerFiles, run.take_id)
    if stored is None:
        return run.report
    key = take_private_key(stored.key_id)
    if key is None:
        raise RuntimeError("no take key")
    keyset = unwrap_data_key(stored.wrapped_key, key)
    blob = read_object(stored.locations["bio_report"])
    return decrypt_file(keyset, run.take_id, "bio_report", blob).decode()


def _work(fn: Analyser, video: Path, take: dict) -> None:
    status, reason, result, report, stored = "failed", None, None, None, None
    try:
        result, report = fn(video, take["test_code"], take["ncid"])
        stored = _store_in_cloud(take, result, report)
        status = "done"
    except Exception as exc:  # noqa: BLE001 - the doctor sees "failed" and can try again
        reason = type(exc).__name__
        log.warning("analysis failed: %s", reason)  # never the take's data
    finally:
        video.unlink(missing_ok=True)  # the decrypted video never stays on disk
    with factory()() as db:
        run = db.get(BiomarkerRun, take["take_id"])
        if run is None:
            return
        run.status, run.reason = status, reason
        # Kept here only when the take is not in the hospital's storage (development).
        run.result, run.report = (None, None) if stored else (result, report)
        if stored:
            row = db.get(BiomarkerFiles, run.take_id) or BiomarkerFiles(take_id=run.take_id)
            row.key_id, row.wrapped_key = stored["key_id"], stored["wrapped_key"]
            row.locations = {k: stored[k] for k in ("bio_report", "bio_result")}
            row.stored_at = now()
            db.add(row)
        run.finished_at = now()
        if status == "done" and run.requested_by == AUTO:
            activity.write(db, "connector", None, "biomarkers_computed", run.ncid, take_id=run.take_id)
        db.commit()


#: requested_by of runs the connector started itself after an upload (decision 060).
AUTO = "auto"
CURSOR = "biomarkers.since"


def poll_new_takes(db: DbSession, limit: int = 50) -> int:
    """Decision 060: analyse each take whose upload completed since the last look. The first look
    starts from now (older takes are analysed when a doctor asks). Returns how many were queued."""
    if analyser() is None:
        return 0
    cur = db.get(KeyValue, CURSOR)
    if cur is None:
        db.add(KeyValue(key=CURSOR, value=now().isoformat()))
        db.commit()
        return 0
    try:
        rows = platform.call("GET", f"/connector/v1/takes?since={quote(cur.value)}&limit={limit}")
    except platform.PlatformError as exc:
        log.warning("could not list new takes: %s", exc.status_code)
        return 0
    tests = supported_tests()
    queued = 0
    for r in rows:
        cur.value = r["uploaded_at"]
        if r["test_code"] not in tests or db.get(BiomarkerRun, r["take_id"]) is not None:
            continue
        if db.get(NcidMap, r["ncid"]) is None:
            continue  # not this hospital's patient map (should not happen)
        try:
            info = takes.info(r["take_id"])
            video = takes.decrypted(info, "video")
        except Exception as exc:  # noqa: BLE001 - try the next take; a doctor can still ask
            log.warning("could not fetch a new take: %s", type(exc).__name__)
            continue
        start(db, info, AUTO, video)
        queued += 1
    db.commit()
    return queued


def wait_idle(timeout: float = 120) -> None:
    """Tests: wait until every queued analysis has finished."""
    for f in list(_futures):
        f.result(timeout=timeout)
    _futures.clear()


def fail_interrupted(db: DbSession) -> int:
    """At start-up: runs left 'running' by a restart can never finish; mark them failed."""
    rows = db.scalars(select(BiomarkerRun).where(BiomarkerRun.status == "running")).all()
    for r in rows:
        r.status, r.reason, r.finished_at = "failed", "interrupted", now()
    db.commit()
    return len(rows)


def runs_for(db: DbSession, ncid: str) -> list[BiomarkerRun]:
    return list(
        db.scalars(
            select(BiomarkerRun).where(BiomarkerRun.ncid == ncid).order_by(BiomarkerRun.requested_at)
        ).all()
    )
