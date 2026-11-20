import re

from ncbio.__main__ import main
from ncbio.demo import demo_take
from ncbio.report import render
from ncbio.run import analyse_keypoints
from tests.synth import tapping


def report_for(kp, **kw):
    details: dict = {}
    result = analyse_keypoints(kp, "FT", details=details)
    return result, render(result, details, **kw)


def test_report_shows_every_value_and_its_working():
    result, html = report_for(demo_take(), ncid="NC-TEST-1", demo=True)
    assert html.startswith("<!doctype html>")
    for b in result["biomarkers"]:
        assert b["id"] in html
    v = {b["id"]: b["value"] for b in result["biomarkers"]}
    assert f"= {v['FT1']:.3f}</code>" in html  # mean worked out to the result's value
    assert re.search(r"mean of \d+ taps = \(", html)
    assert f"{v['FT3']:.3f}</code>" in html  # asymmetry with the numbers put in
    assert "NC-TEST-1" in html and "Synthetic demo" in html
    assert "nan" not in html.lower().replace("nanosec", "")
    assert html.count("<svg") == 4  # two signals, one tap, amplitude per tap


def test_report_without_a_hand_says_why_and_shows_no_working_for_it():
    _, html = report_for(tapping(left=None))
    assert "left hand found in 0 % of frames" in html
    assert "needs both hands" in html
    assert "Synthetic demo" not in html


def test_fragment_has_no_document_shell():
    _, html = report_for(tapping(), standalone=False)
    assert html.startswith("<title>") and "<body" not in html


def test_cli_writes_the_report(tmp_path):
    tapping().save(tmp_path / "kp.npz")
    out = tmp_path / "r.html"
    assert (
        main(["analyse", str(tmp_path / "kp.npz"), "--test", "FT", "--report", str(out), "--ncid", "NC-X"])
        == 0
    )
    assert "NC-X" in out.read_text()
    assert main(["demo-report", str(tmp_path / "d.html")]) == 0
    assert "Synthetic demo" in (tmp_path / "d.html").read_text()
