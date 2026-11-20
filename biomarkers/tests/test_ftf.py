import json
from pathlib import Path

import jsonschema
import pytest

from ncbio.report import render
from ncbio.run import analyse_keypoints
from tests.synth import finger_to_finger

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts/biomarker-result.schema.json").read_text())


def by_id(result: dict) -> dict:
    return {b["id"]: b for b in result["biomarkers"]}


def test_known_movement_gives_the_expected_values():
    ax, ay, f = 0.6, 0.3, 1.0
    r = analyse_keypoints(finger_to_finger(right=(ax, ay, f), left=(ax, ay, f)), "FTF")
    jsonschema.validate(r, SCHEMA)
    v = by_id(r)
    assert [b["id"] for b in r["biomarkers"]] == [f"FTF{i}" for i in range(1, 19)]
    speed = 2 * f * (ax**2 + ay**2) ** 0.5  # straight half cycles, each in half a period
    for left, right, want in (
        ("FTF1", "FTF2", 1 / f),
        ("FTF5", "FTF6", speed),
        ("FTF9", "FTF10", 1.0),
        ("FTF13", "FTF14", 1.0),
    ):
        for bid in (left, right):
            assert v[bid]["value"] == pytest.approx(want, rel=0.03), bid
    for bid in ("FTF3", "FTF4", "FTF7", "FTF8", "FTF11", "FTF12", "FTF15", "FTF16"):
        assert v[bid]["value"] == pytest.approx(0, abs=0.03), bid
    assert v["FTF17"]["value"] == pytest.approx(1.0, abs=0.01)
    assert v["FTF18"]["value"] == pytest.approx(1.0, abs=0.01)


def test_jitter_and_mismatched_hands():
    v = by_id(analyse_keypoints(finger_to_finger(noise_px=2.0), "FTF"))
    assert v["FTF2"]["value"] == pytest.approx(1.0, rel=0.03)
    assert v["FTF14"]["value"] > 0.95
    v = by_id(analyse_keypoints(finger_to_finger(left=(0.4, 0.2, 0.8)), "FTF"))
    assert v["FTF1"]["value"] == pytest.approx(1.25, rel=0.03)  # left is slower
    assert v["FTF17"]["value"] < 0.5 and v["FTF18"]["value"] < 0.5  # the hands no longer match


def test_a_missing_hand():
    v = by_id(analyse_keypoints(finger_to_finger(left=None), "FTF"))
    assert v["FTF2"]["status"] == "COMPUTED"
    assert v["FTF1"]["reason"] == "left hand found in 0 % of frames"
    assert v["FTF17"]["reason"] == "needs both hands"


def test_report_uses_its_own_words_and_shows_the_working():
    details: dict = {}
    result = analyse_keypoints(finger_to_finger(), "FTF", details=details)
    html = render(result, details, ncid="NC-FTF")
    assert "<title>Finger-to-Finger report</title>" in html
    assert "Horizontal finger symmetry" in html and "spread (STD) of" in html and "Every cycle" in html
    assert "Tapping" not in html and "taps" not in html
    for b in result["biomarkers"]:
        assert b["id"] in html
