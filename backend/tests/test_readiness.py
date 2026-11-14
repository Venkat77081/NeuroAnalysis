"""M8: the server's readiness port gives exactly what quality-core gives (shared golden files)."""

import json
from pathlib import Path

import pytest

from analysis.nclm import read_landmarks
from analysis.readiness import Evidence, evidence_from_take, readiness_hint, report_rows

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "contracts/tests/readiness"
REGISTRY = json.loads((REPO / "config/biomarker-registry.json").read_text())
QUALITY = json.loads((REPO / "config/quality.json").read_text())
CASES = sorted(GOLDEN.glob("*.json"))


def test_golden_set_present():
    assert len(CASES) >= 4


@pytest.mark.parametrize("path", CASES, ids=[p.stem for p in CASES])
def test_matches_quality_core(path: Path):
    case = json.loads(path.read_text())
    header, frames = read_landmarks((GOLDEN / case["landmarksFile"]).read_bytes())
    assert header["layout"] == "NCLM-v1"
    e = case["evidence"]
    mw = e["movementWindow"]
    ev = Evidence(
        effective_fps=e["effectiveFps"],
        duration_s=e["durationS"],
        trackers=e["trackers"],
        frames=frames,
        start_ns=int(e["startNs"]),
        movement_window=(mw["tStartS"], mw["tEndS"]) if mw else None,
        phases=e["phases"],
        sensors=e["sensors"],
        hands_needed=e["handsNeeded"],
        pose_min_visibility=e["poseMinVisibility"],
        hand_min_score=e["handMinScore"],
    )
    assert readiness_hint(REGISTRY, case["testCode"], ev) == case["expected"]


def test_take_evidence_and_report_rows():
    case = json.loads((GOLDEN / "saw-phases-missing.json").read_text())
    _, frames = read_landmarks((GOLDEN / case["landmarksFile"]).read_bytes())
    test_config = json.loads((REPO / "config/tests/SAW.json").read_text())
    quality = {
        "fpsEffective": 59.9,
        "durationS": 45,
        "movementWindow": None,
        "phasesDetected": ["seated", "standing", "walk_out"],
        "replayInputs": {"firstSampleNs": case["evidence"]["startNs"], "hasSensors": True},
    }
    ev = evidence_from_take(quality, test_config, QUALITY, frames, sensors_present=True)
    assert ev.phases == ["seated", "stand_up", "walk_out"]
    hint = readiness_hint(REGISTRY, "SAW", ev)
    assert len(hint["items"]) == 15
    rows = report_rows(hint)
    assert rows[0] == {
        "id": "SAW1",
        "status": "NOT_COMPUTABLE",
        "reason": "phases not detected: turn, walk_back",
        "retakeFixable": True,
        "missing": ["phases"],
        "qualityRules": ["saw_phases"],
    }
    # Without landmarks (not decryptable here), visibility cannot be confirmed.
    no_lm = readiness_hint(REGISTRY, "SAW", evidence_from_take(quality, test_config, QUALITY, None, False))
    assert no_lm["items"]["SAW1"]["missing"] == ["landmarks", "phases"]


def test_nclm_rejects_bad_input():
    with pytest.raises(ValueError):
        read_landmarks(b"XXXX0000")
