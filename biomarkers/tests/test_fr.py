import json
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from ncbio.report import render
from ncbio.run import analyse_keypoints
from tests.synth import rolling

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts/biomarker-result.schema.json").read_text())


def by_id(result: dict) -> dict:
    return {b["id"]: b for b in result["biomarkers"]}


def test_known_rolling_gives_the_expected_values():
    a, f = 0.4, 2.0
    r = analyse_keypoints(rolling(right=(a, f), left=(a, f)), "FR")
    jsonschema.validate(r, SCHEMA)
    v = by_id(r)
    assert [b["id"] for b in r["biomarkers"]] == [f"FR{i}" for i in range(1, 13)]
    for bid in ("FR1", "FR2"):
        assert v[bid]["value"] == pytest.approx(a, rel=0.03) and v[bid]["unit"] == "forearm"
        assert v[bid]["cycles"] >= 27
    for bid in ("FR4", "FR5"):
        assert v[bid]["value"] == pytest.approx(1 / f, rel=0.02)
    for bid in ("FR7", "FR8"):
        assert v[bid]["value"] == pytest.approx(a * np.pi * f, rel=0.05)
    for bid in ("FR10", "FR11"):
        assert v[bid]["value"] == pytest.approx(a * 2 * np.pi**2 * f**2, rel=0.12)
    for bid in ("FR3", "FR6", "FR9", "FR12"):
        assert v[bid]["value"] == pytest.approx(0, abs=0.02)


def test_rolling_asymmetry_and_a_missing_arm():
    v = by_id(analyse_keypoints(rolling(right=(0.5, 2.0), left=(0.25, 1.5)), "FR"))
    assert v["FR3"]["value"] == pytest.approx(0.25 / 0.75, abs=0.02)
    assert v["FR6"]["value"] == pytest.approx(abs(0.5 - 1 / 1.5) / (0.5 + 1 / 1.5), abs=0.02)
    v = by_id(analyse_keypoints(rolling(left=None), "FR"))
    assert v["FR1"]["status"] == "COMPUTED"
    assert v["FR2"]["reason"] == "left hand found in 0 % of frames"
    assert v["FR3"]["reason"] == "needs both hands"


def test_noise_is_smoothed_out():
    v = by_id(analyse_keypoints(rolling(noise_px=2.0), "FR"))
    assert v["FR1"]["value"] == pytest.approx(0.4, rel=0.06)
    assert v["FR4"]["value"] == pytest.approx(0.5, rel=0.03)


def test_forearm_roll_report_uses_its_own_words():
    details: dict = {}
    result = analyse_keypoints(rolling(), "FR", details=details)
    html = render(result, details, ncid="NC-FR")
    assert "<title>Forearm Roll report</title>" in html
    assert "Rolling amplitude" in html and "Every roll" in html and "mean of" in html
    assert "Tapping" not in html and "tapping" not in html and "taps" not in html
    for b in result["biomarkers"]:
        assert b["id"] in html
