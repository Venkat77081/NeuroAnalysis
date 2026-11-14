"""Server biomarker readiness for stored takes (DEV_PLAN §10, M8). Reviewers only.

With the server's private key (dev/pilot), the take's landmarks.bin is decrypted and readiness is
recomputed (source "server", authoritative). Without it (production keys live in the KMS until the
analysis worker is deployed), the phone's hint from quality.json is reported (source "device_hint").
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from analysis.nclm import read_landmarks
from analysis.readiness import evidence_from_take, readiness_hint, report_rows
from analysis.takecrypto import decrypt_file, unwrap_data_key
from app.audit import audit
from app.config import get_settings
from app.keys import server_private_key
from app.models import BiomarkerRun, Take, TakeFile
from app.storage import get_storage

log = logging.getLogger("neurocapture.readiness")


@lru_cache
def configs(config_dir: str | None = None) -> tuple[dict, dict, dict[str, dict]]:
    """(registry, quality config, test configs by code) from the repo config directory."""
    d = Path(config_dir or get_settings().config_dir)
    registry = json.loads((d / "biomarker-registry.json").read_text())
    quality = json.loads((d / "quality.json").read_text())
    tests = {}
    for f in sorted((d / "tests").glob("*.json")):
        t = json.loads(f.read_text())
        tests[t["code"]] = t
    return registry, quality, tests


def compute(db: DbSession, take: Take, actor_id: str | None) -> BiomarkerRun:
    registry, quality_cfg, tests = configs()
    files = {f.kind: f for f in db.scalars(select(TakeFile).where(TakeFile.take_id == take.id))}
    key = server_private_key(take.key_id)
    status, source = "ready", "server"
    try:
        if key is None:
            source = "device_hint"
            device = dict(take.quality.get("biomarkerReadinessHint") or {})
            version = device.pop("registryVersion", "REG@0.0.0")
            hint = {"registryVersion": version, "items": device}
        else:
            frames = None
            if "landmarks" in files:
                keyset = unwrap_data_key(take.wrapped_data_key, key)
                raw = get_storage().read(files["landmarks"].object_key)
                _, frames = read_landmarks(decrypt_file(keyset, take.client_take_id, "landmarks", raw))
            ev = evidence_from_take(
                take.quality, tests[take.test_code], quality_cfg, frames, sensors_present="sensors" in files
            )
            hint = readiness_hint(registry, take.test_code, ev)
        readiness = hint
    except Exception as exc:  # noqa: BLE001 - a broken take must not break the report
        log.warning("readiness failed for take %s: %s", take.id, type(exc).__name__)
        status, readiness = (
            "error",
            {"registryVersion": registry["registryVersion"], "error": type(exc).__name__},
        )
    run = BiomarkerRun(
        take_id=take.id,
        registry_version=readiness["registryVersion"],
        source=source,
        status=status,
        readiness=readiness,
        results=None,
    )
    db.add(run)
    audit(db, "operator", actor_id, "readiness_computed", "take", take.id, source=source, status=status)
    db.commit()
    return run


def latest(db: DbSession, take: Take) -> BiomarkerRun | None:
    return db.scalar(
        select(BiomarkerRun)
        .where(BiomarkerRun.take_id == take.id)
        .order_by(BiomarkerRun.created_at.desc(), BiomarkerRun.id.desc())
    )


def take_report(take: Take, run: BiomarkerRun) -> dict:
    """Every registered biomarker of the take's test, with status and reason."""
    registry, _, _ = configs()
    ids = [b["id"] for b in registry["biomarkers"] if b["testCode"] == take.test_code]
    items = run.readiness.get("items", {})
    rows = {r["id"]: r for r in report_rows({"items": items})} if run.status == "ready" else {}
    out = []
    for bid in ids:
        if bid in rows:
            out.append(rows[bid])
        else:
            reason = (
                f"readiness failed: {run.readiness.get('error')}"
                if run.status == "error"
                else f"not assessed (registry {run.registry_version})"
            )
            out.append(
                {
                    "id": bid,
                    "status": "NOT_COMPUTABLE",
                    "reason": reason,
                    "retakeFixable": False,
                    "missing": [],
                    "qualityRules": [],
                }
            )
    return {
        "takeId": take.id,
        "clientTakeId": take.client_take_id,
        "testCode": take.test_code,
        "side": take.side,
        "takeNo": take.take_no,
        "captureVerdict": take.capture_verdict,
        "flaggedForReview": take.flagged_for_review,
        "source": run.source,
        "status": run.status,
        "registryVersion": run.registry_version,
        "serverRegistryVersion": registry["registryVersion"],
        "computedAt": run.created_at.isoformat(),
        "summary": dict(Counter(r["status"] for r in out)),
        "biomarkers": out,
    }
