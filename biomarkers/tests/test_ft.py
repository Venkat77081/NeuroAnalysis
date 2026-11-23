import json
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from ncbio.run import analyse_keypoints
from tests.synth import tapping

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts/biomarker-result.schema.json").read_text())


def by_id(result: dict) -> dict:
    return {b["id"]: b for b in result["biomarkers"]}


def test_known_tapping_gives_the_expected_values():
    a, f = 0.5, 3.0
    r = analyse_keypoints(tapping(right=(a, f), left=(a, f)), "FT")
    jsonschema.validate(r, SCHEMA)
    v = by_id(r)
    assert [b["id"] for b in r["biomarkers"]] == [f"FT{i}" for i in range(1, 13)]
    for rid in ("FT1", "FT2"):
        assert v[rid]["value"] == pytest.approx(a, rel=0.03)
        assert v[rid]["unit"] == "forearm"
        assert v[rid]["cycles"] >= 40
    for rid in ("FT4", "FT5"):
        assert v[rid]["value"] == pytest.approx(1 / f, rel=0.02)
    for rid in ("FT7", "FT8"):
        assert v[rid]["value"] == pytest.approx(a * np.pi * f, rel=0.05)
    for rid in ("FT10", "FT11"):
        assert v[rid]["value"] == pytest.approx(a * 2 * np.pi**2 * f**2, rel=0.12)
    for rid in ("FT3", "FT6", "FT9", "FT12"):
        assert v[rid]["value"] == pytest.approx(0, abs=0.02)


def test_asymmetry_follows_the_formula():
    v = by_id(analyse_keypoints(tapping(right=(0.6, 3.0), left=(0.3, 2.0)), "FT"))
    assert v["FT3"]["value"] == pytest.approx(abs(0.6 - 0.3) / 0.9, abs=0.02)
    assert v["FT6"]["value"] == pytest.approx(abs(1 / 3 - 1 / 2) / (1 / 3 + 1 / 2), abs=0.02)


def test_noise_is_smoothed_out():
    v = by_id(analyse_keypoints(tapping(noise_px=2.0), "FT"))
    assert v["FT1"]["value"] == pytest.approx(0.5, rel=0.06)
    assert v["FT4"]["value"] == pytest.approx(1 / 3, rel=0.03)


def test_a_missing_hand_is_not_computable_and_says_why():
    r = analyse_keypoints(tapping(left=None), "FT")
    v = by_id(r)
    jsonschema.validate(r, SCHEMA)
    assert v["FT1"]["status"] == "COMPUTED"
    assert v["FT2"]["status"] == "NOT_COMPUTABLE"
    assert v["FT2"]["reason"] == "left hand found in 0 % of frames"
    assert v["FT3"] == {"id": "FT3", "status": "NOT_COMPUTABLE", "value": None, "reason": "needs both hands"}


def test_no_tapping_is_not_computable():
    v = by_id(analyse_keypoints(tapping(right=(0.0, 3.0), left=(0.0, 3.0)), "FT"))
    assert v["FT1"]["status"] == "NOT_COMPUTABLE"
    assert v["FT1"]["reason"].startswith("right hand only")


def test_low_frame_rate_and_short_videos_are_refused():
    v = by_id(analyse_keypoints(tapping(fps=30), "FT"))
    assert all(b["status"] == "NOT_COMPUTABLE" for b in v.values())
    assert v["FT1"]["reason"] == "video is 30.0 fps, needs 58"
    v = by_id(analyse_keypoints(tapping(seconds=10), "FT"))
    assert v["FT1"]["reason"] == "video is 10.0 s, needs 14.9"


def test_every_test_is_built():
    from ncbio.config import registry
    from ncbio.run import EXTRACTORS, REPORT_TESTS

    codes = {b["testCode"] for b in registry()["biomarkers"]}
    assert codes == set(EXTRACTORS) == set(REPORT_TESTS)
