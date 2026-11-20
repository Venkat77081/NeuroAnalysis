"""Biomarker analysis at the hospital (M15, decisions 057 and 059).

A doctor asks for a take's biomarkers; the connector decrypts the video (only it holds the take
key), runs the analysis package (`ncbio`, biomarkers/) in the background and keeps the result and
the report in the hospital's database. The platform never sees the video, the values or the
report. One take is analysed at a time; a take is analysed once unless the doctor asks again.

`ncbio` is an optional install (MediaPipe is large): without it the connector says so
("analysis_not_installed") and everything else works as before.
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ncconnector.db import BiomarkerRun, factory, now

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


def start(
    db: DbSession, take_id: str, ncid: str, test_code: str, staff_id: str, video: bytes
) -> BiomarkerRun:
    """Queues the analysis of one take (the video already decrypted by the caller)."""
    run = db.get(BiomarkerRun, take_id) or BiomarkerRun(take_id=take_id, ncid=ncid, test_code=test_code)
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
    assert fn is not None  # the endpoint checks first
    tmp = tempfile.NamedTemporaryFile(prefix="nc-take-", suffix=".mp4", delete=False)  # noqa: SIM115
    try:
        tmp.write(video)
    finally:
        tmp.close()
    _futures.append(_pool.submit(_work, fn, Path(tmp.name), take_id, test_code, ncid))
    return run


def _work(fn: Analyser, video: Path, take_id: str, test_code: str, ncid: str) -> None:
    status, reason, result, report = "failed", None, None, None
    try:
        result, report = fn(video, test_code, ncid)
        status = "done"
    except Exception as exc:  # noqa: BLE001 - the doctor sees "failed" and can try again
        reason = type(exc).__name__
        log.warning("analysis failed: %s", reason)  # never the take's data
    finally:
        video.unlink(missing_ok=True)  # the decrypted video never stays on disk
    with factory()() as db:
        run = db.get(BiomarkerRun, take_id)
        if run is None:
            return
        run.status, run.reason, run.result, run.report = status, reason, result, report
        run.finished_at = now()
        db.commit()


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
