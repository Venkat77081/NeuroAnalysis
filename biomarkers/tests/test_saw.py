import json
from pathlib import Path

import jsonschema
import numpy as np
import pytest
from scipy.signal import find_peaks

from ncbio.report import render
from ncbio.run import analyse_keypoints
from tests.synth import TRUNK_M, walk_schedule, walking

SCHEMA = json.loads(
    (Path(__file__).parents[2] / "contracts/biomarker-result.schema.json").read_text(encoding="utf-8")
)


def by_id(result: dict) -> dict:
    return {b["id"]: b for b in result["biomarkers"]}


def true_steps(kp) -> list[float]:
    """d_saw at every step, straight from the synthetic 3-D ankles inside each known walk."""
    d = np.linalg.norm(kp.pose_world[:, 28] - kp.pose_world[:, 27], axis=1) / TRUNK_M
    out = []
    for kind, a, b in walk_schedule(45.0, 2.0, 1.5, 4.0, 1.5):
        if kind == "walk":
            m = (kp.t >= a) & (kp.t < b)
            idx, _ = find_peaks(d[m])
            out += list(d[m][idx])
    return out


def test_known_walk_gives_the_formulas_values():
    kp = walking()
    r = analyse_keypoints(kp, "SAW")
    jsonschema.validate(r, SCHEMA)
    v = by_id(r)
    assert [b["id"] for b in r["biomarkers"]] == [f"SAW{i}" for i in range(1, 16)]
    assert all(b["status"] == "COMPUTED" for b in r["biomarkers"])
    assert v["SAW10"]["value"] == pytest.approx(105.0, abs=0.5)  # cadence, steps/min
    assert v["SAW10"]["cycles"] == 7  # seven walks
    assert v["SAW15"]["value"] == pytest.approx(60 / 105, rel=0.01)  # step time
    assert v["SAW1"]["value"] < 0.02
    assert v["SAW12"]["value"] == pytest.approx(1.15 / TRUNK_M, rel=0.01)  # trunk/s
    assert v["SAW13"]["value"] == pytest.approx(1.5, abs=0.05)
    assert v["SAW13"]["cycles"] == 6
    steps = true_steps(kp)
    assert v["SAW2"]["value"] == pytest.approx(np.mean(steps), rel=0.01)
    assert v["SAW3"]["value"] == pytest.approx(np.median(steps), rel=0.01)
    for bid in ("SAW6", "SAW7", "SAW9"):
        assert v[bid]["value"] == pytest.approx(1.0, abs=0.01), bid
    assert v["SAW2"]["unit"] == "trunk" and v["SAW12"]["unit"] == "trunk/s"


def test_a_knee_that_bends_differently_lowers_symmetry():
    v = by_id(analyse_keypoints(walking(left_knee_bend=40), "SAW"))
    assert v["SAW6"]["value"] < 0.9
    assert v["SAW9"]["value"] < 0.99
    # Slower walk, faster turns: speed and turning time follow.
    v = by_id(analyse_keypoints(walking(speed=0.8, turn_s=2.5), "SAW"))
    assert v["SAW12"]["value"] == pytest.approx(0.8 / TRUNK_M, rel=0.02)
    assert v["SAW13"]["value"] == pytest.approx(2.5, abs=0.05)


def test_body_size_does_not_matter_and_jitter_is_tolerated():
    base = by_id(analyse_keypoints(walking(), "SAW"))
    kp = walking()
    kp.pose_world = kp.pose_world * 1.3
    kp.pose = kp.pose * np.array([1.3, 1.3, 1.0, 1.0])
    big = by_id(analyse_keypoints(kp, "SAW"))
    for bid in ("SAW2", "SAW4", "SAW10", "SAW12", "SAW13"):
        assert big[bid]["value"] == pytest.approx(base[bid]["value"], rel=0.01), bid
    noisy = by_id(analyse_keypoints(walking(noise_m=0.01), "SAW"))
    assert noisy["SAW10"]["value"] == pytest.approx(105.0, abs=1)
    assert noisy["SAW6"]["value"] > 0.98


def test_missing_body_no_walking_and_short_takes_say_why():
    kp = walking()
    kp.pose_world[:] = np.nan
    assert by_id(analyse_keypoints(kp, "SAW"))["SAW1"]["reason"] == "body found in 0 % of frames"
    kp = walking()
    kp.pose[..., 0] = 400.0  # the hips never move across the picture
    v = by_id(analyse_keypoints(kp, "SAW"))
    assert v["SAW1"]["reason"] == "no walking found"
    assert v["SAW13"]["reason"] == "no turn found"
    v = by_id(analyse_keypoints(walking(seconds=20), "SAW"))
    assert v["SAW1"]["reason"] == "video is 20.0 s, needs 44.9"


def test_report_uses_its_own_words_and_shows_the_working():
    details: dict = {}
    result = analyse_keypoints(walking(), "SAW", details=details)
    html = render(result, details, ncid="NC-SAW")
    assert "<title>Stand and Walk report</title>" in html
    assert "Walking and turning" in html and "Turn 6:" in html
    assert "steps ÷ its time × 60" in html
    assert "forearm" not in html and "Tapping" not in html
    for b in result["biomarkers"]:
        assert b["id"] in html
