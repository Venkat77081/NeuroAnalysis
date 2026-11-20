from types import SimpleNamespace as Ns

import numpy as np

from ncbio.keypoints import Keypoints, assign_hands, extract
from tests.synth import tapping


def hand_at(x, y):
    h = np.zeros((21, 3))
    h[:, 0], h[:, 1] = x, y
    return h


def pose_with_wrists(left=(900, 500), right=(300, 500)):
    p = np.full((33, 4), np.nan)
    p[15, :2], p[16, :2] = left, right
    return p


def test_hands_are_named_by_the_nearest_pose_wrist():
    a, b = hand_at(310, 505), hand_at(890, 495)
    for order in ([a, b], [b, a]):
        named = assign_hands(order, pose_with_wrists())
        assert named["right"][0, 0] == 310 and named["left"][0, 0] == 890


def test_one_hand_and_no_pose():
    named = assign_hands([hand_at(880, 500)], pose_with_wrists())
    assert list(named) == ["left"]
    assert assign_hands([hand_at(1, 1)], None) == {}
    assert assign_hands([], pose_with_wrists()) == {}
    # Only one wrist known: that hand takes it.
    p = pose_with_wrists(left=(np.nan, np.nan))
    assert list(assign_hands([hand_at(100, 100), hand_at(900, 500)], p)) == ["right"]


def lm(x, y, z=0.0, vis=0.9):
    return Ns(x=x, y=y, z=z, visibility=vis)


def test_extract_with_stand_in_detectors():
    frames = [(i / 60, np.zeros((100, 200, 3), np.uint8)) for i in range(3)]
    pose_lms = [lm(0.5, 0.5) for _ in range(33)]
    pose_lms[16] = lm(0.25, 0.5)  # right wrist, image left
    pose_lms[15] = lm(0.75, 0.5)
    hand_r = [lm(0.26, 0.5) for _ in range(21)]
    hand_l = [lm(0.74, 0.5) for _ in range(21)]
    seen = []

    def pose(rgb, ms):
        seen.append(ms)
        return Ns(pose_landmarks=[pose_lms], pose_world_landmarks=[[lm(0, 0) for _ in range(33)]])

    def hand(rgb, ms):
        return Ns(hand_landmarks=[hand_l, hand_r] if ms < 30 else [])

    kp = extract(iter(frames), {"pose": pose, "hand": hand})
    assert seen == [0, 17, 33]
    assert kp.pose.shape == (3, 33, 4) and kp.width == 200 and kp.height == 100
    assert kp.pose[0, 16, 0] == 50.0
    assert kp.hands["right"][0, 0, 0] == 52.0 and kp.hands["left"][0, 0, 0] == 148.0
    assert np.isnan(kp.hands["right"][2]).all()
    assert kp.face is None


def test_save_and_load_round_trip(tmp_path):
    kp = tapping(seconds=1)
    kp.models = ["hand_landmarker.task"]
    kp.save(tmp_path / "kp.npz")
    back = Keypoints.load(tmp_path / "kp.npz")
    assert np.array_equal(back.t, kp.t)
    assert np.array_equal(back.hands["left"], kp.hands["left"], equal_nan=True)
    assert back.models == ["hand_landmarker.task"] and back.library == "synthetic"
    assert round(back.fps) == 60 and round(back.duration_s, 3) == 1.0
