import json
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from ncbio.report import render
from ncbio.run import analyse_keypoints
from tests.synth import face_activation

SCHEMA = json.loads((Path(__file__).parents[2] / "contracts/biomarker-result.schema.json").read_text())
T = np.arange(900) / 60
IED = 60.0


def wave(base, a, f, ph=0.0):
    return base + a * (1 - np.cos(2 * np.pi * f * T - ph)) / 2


def by_id(result: dict) -> dict:
    return {b["id"]: b for b in result["biomarkers"]}


def test_known_movement_gives_the_formulas_values():
    r = analyse_keypoints(face_activation(), "FA")
    jsonschema.validate(r, SCHEMA)
    v = by_id(r)
    assert [b["id"] for b in r["biomarkers"]] == [f"FA{i}" for i in range(1, 19)]
    eye = np.sqrt(7) * wave(10, 6, 0.5) / IED  # 7 paired points, Eq. A-I
    brow = np.sqrt(5) * wave(12, 5, 0.5) / IED
    mouth = np.sqrt(3) * wave(4, 10, 0.4) / IED
    width = wave(60, 12, 0.4) / IED
    jaw = np.sqrt(7) * wave(40, 8, 0.4) / IED

    def niqr(x):
        p10, p90 = np.percentile(x, [10, 90])
        return (p90 - p10) / p90

    want = {
        "FA1": eye.std(),
        "FA2": eye.std(),
        "FA3": mouth.std(),
        "FA4": width.std(),
        "FA5": jaw.std(),
        "FA6": (np.diff(eye) * 60).std(),
        "FA8": (np.diff(brow) * 60).std(),
        "FA10": (np.diff(mouth) * 60).std(),
        "FA11": niqr(eye),
        "FA13": niqr(mouth),
        "FA14": niqr(width),
    }
    for bid, x in want.items():
        assert v[bid]["value"] == pytest.approx(x, rel=0.02), bid
    for bid in ("FA15", "FA16", "FA17", "FA18"):
        assert v[bid]["value"] == pytest.approx(1.0, abs=0.01)
    assert v["FA1"]["unit"] == "ied" and v["FA6"]["unit"] == "ied/s"


def test_left_out_of_step_lowers_symmetry():
    v = by_id(analyse_keypoints(face_activation(left_phase=np.pi / 2), "FA"))
    for bid in ("FA15", "FA16", "FA17", "FA18"):
        assert v[bid]["value"] == pytest.approx(0.0, abs=0.05)
    v = by_id(analyse_keypoints(face_activation(left_phase=np.pi), "FA"))
    assert v["FA15"]["value"] == pytest.approx(-1.0, abs=0.02)


def test_head_size_does_not_matter_and_no_face_is_not_computable():
    near = by_id(analyse_keypoints(face_activation(ied_px=90), "FA"))
    far = by_id(analyse_keypoints(face_activation(ied_px=60), "FA"))
    # The synthetic features keep their pixel sizes, so a bigger IED shrinks them by 60/90.
    assert near["FA4"]["value"] == pytest.approx(far["FA4"]["value"] * 60 / 90, rel=0.01)
    assert near["FA15"]["value"] == pytest.approx(far["FA15"]["value"], abs=0.01)
    v = by_id(analyse_keypoints(face_activation(face_found=False), "FA"))
    assert v["FA1"]["reason"] == "face found in 0 % of frames"


def test_report_uses_its_own_words_and_shows_the_working():
    details: dict = {}
    result = analyse_keypoints(face_activation(), "FA", details=details)
    html = render(result, details, ncid="NC-FA")
    assert "<title>Facial Activation report</title>" in html
    assert "Eyes opening symmetry" in html and "(90th percentile − 10th percentile)" in html
    assert "forearm" not in html and "Tapping" not in html
    for b in result["biomarkers"]:
        assert b["id"] in html
