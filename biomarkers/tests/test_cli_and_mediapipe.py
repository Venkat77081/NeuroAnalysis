import json

import cv2
import numpy as np
import pytest

from ncbio.__main__ import main
from ncbio.keypoints import keypoints_from_video, model_path
from tests.synth import tapping


def test_cli_from_saved_keypoints(tmp_path, capsys):
    tapping().save(tmp_path / "kp.npz")
    assert main(["analyse", str(tmp_path / "kp.npz"), "--test", "FT", "--out", str(tmp_path / "r.json")]) == 0
    r = json.loads((tmp_path / "r.json").read_text())
    assert r["testCode"] == "FT" and r["biomarkers"][0]["status"] == "COMPUTED"


@pytest.mark.skipif(
    not (model_path("hand").exists() and model_path("pose").exists()),
    reason="models not downloaded (python -m ncbio models)",
)
def test_mediapipe_runs_on_a_real_video_file(tmp_path):
    """A 60 fps file without a person: MediaPipe loads, reads every frame and finds nothing."""
    path = tmp_path / "blank.mp4"
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 60, (320, 240))
    for i in range(30):
        w.write(np.full((240, 320, 3), i * 4, np.uint8))
    w.release()
    kp = keypoints_from_video(path, "FT")
    assert kp.t.size == 30 and round(kp.fps) == 60
    assert np.isnan(kp.pose).all() and np.isnan(kp.hands["right"]).all()
    assert kp.library == "mediapipe" and kp.models == ["hand_landmarker.task", "pose_landmarker_heavy.task"]


def test_cli_says_what_is_missing(tmp_path, monkeypatch):
    with pytest.raises(SystemExit, match="No file at"):
        main(["analyse", str(tmp_path / "nothing.mp4"), "--test", "FT"])
    (tmp_path / "take.mp4").write_bytes(b"x")
    monkeypatch.setenv("NCBIO_MODELS_DIR", str(tmp_path / "no-models"))
    with pytest.raises(SystemExit, match="python -m ncbio models"):
        main(["analyse", str(tmp_path / "take.mp4"), "--test", "FT"])


def test_text_files_are_read_and_written_as_utf8():
    """Windows reads files in its own encoding unless told (the "²" in forearm/s² broke there)."""
    import re
    from pathlib import Path

    for f in (Path(__file__).parents[1] / "ncbio").glob("*.py"):
        src = f.read_text(encoding="utf-8")
        calls = len(re.findall(r"\.(?:read_text|write_text)\(", src))
        assert src.count('encoding="utf-8"') >= calls, f.name
