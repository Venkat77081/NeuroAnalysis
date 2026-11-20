"""Analyse one take: keypoints → the test's biomarkers, in registry order, as a result document."""

from __future__ import annotations

from pathlib import Path

from .config import analysis_config, registry, registry_ids
from .ft import finger_tapping
from .keypoints import Keypoints, keypoints_from_video
from .result import Value, not_computable, not_implemented

EXTRACTORS = {"FT": finger_tapping}


def _take_checks(kp: Keypoints, test_code: str) -> dict[str, str]:
    """Registry inputs every biomarker of the test shares: frame rate and length (per biomarker)."""
    reasons = {}
    for b in registry()["biomarkers"]:
        if b["testCode"] != test_code:
            continue
        need = b["inputs"]
        if kp.fps < need.get("minEffectiveFps", 0):
            reasons[b["id"]] = f"video is {kp.fps:.1f} fps, needs {need['minEffectiveFps']}"
        elif kp.duration_s < need.get("minDurationS", 0):
            reasons[b["id"]] = f"video is {kp.duration_s:.1f} s, needs {need['minDurationS']}"
    return reasons


def analyse_keypoints(kp: Keypoints, test_code: str, cfg: dict | None = None) -> dict:
    cfg = cfg or analysis_config()
    ids = registry_ids(test_code)
    blocked = _take_checks(kp, test_code)
    got: dict[str, Value] = {}
    if test_code in EXTRACTORS and len(blocked) < len(ids):
        got = {v["id"]: v for v in EXTRACTORS[test_code](kp, cfg)}
    values: list[Value] = []
    for bid in ids:
        if bid in blocked:
            values.append(not_computable(bid, blocked[bid]))
        elif bid in got:
            values.append(got[bid])
        else:
            values.append(not_implemented(bid))
    return {
        "schemaVersion": "1.0.0",
        "analysisVersion": cfg["analysisVersion"],
        "registryVersion": registry()["registryVersion"],
        "testCode": test_code,
        "keypoints": {"library": kp.library, "version": kp.version, "models": kp.models},
        "frames": {
            "count": int(kp.t.size),
            "fps": round(kp.fps, 3),
            "durationS": round(kp.duration_s, 3),
        },
        "biomarkers": values,
    }


def analyse_video(video: Path, test_code: str, keypoints_out: Path | None = None) -> dict:
    kp = keypoints_from_video(video, test_code)
    if keypoints_out:
        kp.save(keypoints_out)
    return analyse_keypoints(kp, test_code)
