"""Keypoints from the 60 fps video with MediaPipe (Apache 2.0): pose 33, hands 21 each, face 478.

Coordinates are in pixels (x, y, and MediaPipe's relative z scaled like x); pose world points are
metres. A point not found in a frame is NaN. Hands are named by the patient's side, matched to the
pose wrists (pose 15 = left wrist, 16 = right wrist), not by MediaPipe's handedness label, which
depends on whether the image was mirrored.

Landmark streams are never logged (CLAUDE.md).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from itertools import permutations
from pathlib import Path

import numpy as np

from .config import analysis_config

POSE_L_WRIST, POSE_R_WRIST = 15, 16
SIDES = ("right", "left")
_MODELS_DIR = Path(__file__).resolve().parents[1] / "models"


@dataclass
class Keypoints:
    """Per-frame keypoints of one take (T frames)."""

    t: np.ndarray  # (T,) seconds from the first frame
    width: int
    height: int
    pose: np.ndarray  # (T, 33, 4): x, y, z px and visibility
    pose_world: np.ndarray  # (T, 33, 3) metres, hip-centred
    hands: dict[str, np.ndarray] = field(default_factory=dict)  # side → (T, 21, 3) px
    face: np.ndarray | None = None  # (T, 478, 3) px
    library: str = "mediapipe"
    version: str = ""
    models: list[str] = field(default_factory=list)

    @property
    def fps(self) -> float:
        d = np.diff(self.t)
        return float(1.0 / np.median(d)) if d.size else 0.0

    @property
    def duration_s(self) -> float:
        # Last frame start minus first, plus one frame.
        return float(self.t[-1] - self.t[0] + 1.0 / self.fps) if self.t.size > 1 else 0.0

    def save(self, path: Path) -> None:
        arrays = {
            "t": self.t,
            "size": np.array([self.width, self.height]),
            "pose": self.pose,
            "pose_world": self.pose_world,
            "meta": np.array([self.library, self.version, *self.models]),
        }
        for side, a in self.hands.items():
            arrays[f"hand_{side}"] = a
        if self.face is not None:
            arrays["face"] = self.face
        np.savez_compressed(path, **arrays)

    @classmethod
    def load(cls, path: Path) -> Keypoints:
        z = np.load(path, allow_pickle=False)
        meta = [str(x) for x in z["meta"]]
        return cls(
            t=z["t"],
            width=int(z["size"][0]),
            height=int(z["size"][1]),
            pose=z["pose"],
            pose_world=z["pose_world"],
            hands={s: z[f"hand_{s}"] for s in SIDES if f"hand_{s}" in z},
            face=z["face"] if "face" in z else None,
            library=meta[0],
            version=meta[1],
            models=meta[2:],
        )


def assign_hands(hands: list[np.ndarray], pose: np.ndarray | None) -> dict[str, np.ndarray]:
    """Name each detected hand (21×3 px) by the patient's side: the nearest pose wrist wins.

    With two hands, the pairing with the smaller total wrist distance is used, so two hands are
    never given the same side. Without pose wrists the hands stay unnamed (and are dropped).
    """
    if not hands or pose is None:
        return {}
    wrists = {"left": pose[POSE_L_WRIST, :2], "right": pose[POSE_R_WRIST, :2]}
    wrists = {s: w for s, w in wrists.items() if np.all(np.isfinite(w))}
    if not wrists:
        return {}
    best: tuple[float, dict[str, np.ndarray]] | None = None
    sides = list(wrists)
    for perm in permutations(sides, min(len(hands), len(sides))):
        cost = sum(float(np.linalg.norm(h[0, :2] - wrists[s])) for h, s in zip(hands, perm, strict=False))
        if best is None or cost < best[0]:
            best = (cost, {s: h for h, s in zip(hands, perm, strict=False)})
    return best[1] if best else {}


def model_path(kind: str) -> Path:
    d = Path(os.environ.get("NCBIO_MODELS_DIR", _MODELS_DIR))
    return d / analysis_config()["models"][kind]["name"]


def video_frames(path: Path) -> Iterator[tuple[float, np.ndarray]]:
    """(seconds, RGB frame) for every frame, with the container's timestamps."""
    import cv2

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("cannot open the video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 60.0
    i = 0
    last = -1.0
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            ts = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if not np.isfinite(ts) or ts <= last:
                ts = i / fps if i / fps > last else last + 1.0 / fps
            last = ts
            i += 1
            yield ts, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    finally:
        cap.release()


Detector = Callable[[np.ndarray, int], object]


def mediapipe_detectors(kinds: set[str]) -> dict[str, Detector]:
    """VIDEO-mode MediaPipe landmarkers for the kinds asked ("pose", "hand", "face")."""
    # MediaPipe's native logs (model loading, alignment notes) are noise for the user; errors stay.
    os.environ.setdefault("GLOG_minloglevel", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    c = analysis_config()["detection"]
    mode = vision.RunningMode.VIDEO
    made: dict[str, object] = {}
    if "pose" in kinds:
        made["pose"] = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_path("pose"))),
                running_mode=mode,
                num_poses=1,
                min_pose_detection_confidence=c["minDetectionConfidence"],
                min_pose_presence_confidence=c["minPresenceConfidence"],
                min_tracking_confidence=c["minTrackingConfidence"],
            )
        )
    if "hand" in kinds:
        made["hand"] = vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_path("hand"))),
                running_mode=mode,
                num_hands=c["maxHands"],
                min_hand_detection_confidence=c["minDetectionConfidence"],
                min_hand_presence_confidence=c["minPresenceConfidence"],
                min_tracking_confidence=c["minTrackingConfidence"],
            )
        )
    if "face" in kinds:
        made["face"] = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_path("face"))),
                running_mode=mode,
                num_faces=1,
                min_face_detection_confidence=c["minDetectionConfidence"],
                min_face_presence_confidence=c["minPresenceConfidence"],
                min_tracking_confidence=c["minTrackingConfidence"],
            )
        )

    def wrap(lm: object) -> Detector:
        def run(rgb: np.ndarray, ts_ms: int) -> object:
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
            return lm.detect_for_video(img, ts_ms)  # type: ignore[attr-defined]

        run.close = lm.close  # type: ignore[attr-defined]
        return run

    return {k: wrap(v) for k, v in made.items()}


def _px(points: list, w: int, h: int, n: int) -> np.ndarray:
    a = np.full((n, 3), np.nan)
    for i, p in enumerate(points[:n]):
        a[i] = (p.x * w, p.y * h, p.z * w)
    return a


def extract(
    frames: Iterator[tuple[float, np.ndarray]],
    detectors: dict[str, Detector],
) -> Keypoints:
    """Run the detectors over every frame. Missing points are NaN."""
    ts: list[float] = []
    pose, world, face = [], [], []
    hands: dict[str, list[np.ndarray]] = {s: [] for s in SIDES}
    w = h = 0
    last_ms = -1
    for sec, rgb in frames:
        h, w = rgb.shape[:2]
        ms = max(int(round(sec * 1000)), last_ms + 1)  # MediaPipe needs increasing timestamps
        last_ms = ms
        ts.append(sec)
        p = np.full((33, 4), np.nan)
        pw = np.full((33, 3), np.nan)
        if "pose" in detectors:
            r = detectors["pose"](rgb, ms)
            if r.pose_landmarks:  # type: ignore[attr-defined]
                lms = r.pose_landmarks[0]  # type: ignore[attr-defined]
                p[:, :3] = _px(lms, w, h, 33)
                p[:, 3] = [getattr(x, "visibility", None) or 0.0 for x in lms[:33]]
            if getattr(r, "pose_world_landmarks", None):
                pw = np.array([(q.x, q.y, q.z) for q in r.pose_world_landmarks[0][:33]])  # type: ignore[attr-defined]
        pose.append(p)
        world.append(pw)
        named: dict[str, np.ndarray] = {}
        if "hand" in detectors:
            r = detectors["hand"](rgb, ms)
            found = [_px(x, w, h, 21) for x in (r.hand_landmarks or [])]  # type: ignore[attr-defined]
            wrists_found = np.isfinite(p[POSE_L_WRIST : POSE_R_WRIST + 1, :2]).any()
            named = assign_hands(found, p if wrists_found else None)
        for s in SIDES:
            hands[s].append(named.get(s, np.full((21, 3), np.nan)))
        if "face" in detectors:
            r = detectors["face"](rgb, ms)
            fl = r.face_landmarks  # type: ignore[attr-defined]
            face.append(_px(fl[0], w, h, 478) if fl else np.full((478, 3), np.nan))
    t = np.asarray(ts, dtype=float)
    t = t - t[0] if t.size else t
    n = t.size
    return Keypoints(
        t=t,
        width=w,
        height=h,
        pose=np.asarray(pose).reshape(n, 33, 4),
        pose_world=np.asarray(world).reshape(n, 33, 3),
        hands={s: np.asarray(v).reshape(n, 21, 3) for s, v in hands.items()} if "hand" in detectors else {},
        face=np.asarray(face).reshape(n, 478, 3) if "face" in detectors else None,
    )


#: Which keypoints each test needs (DNE paper: hands + body for FT/FTF/FR, body for SAW, face for FA).
TEST_KINDS: dict[str, set[str]] = {
    "FT": {"pose", "hand"},
    "FTF": {"pose", "hand"},
    "FR": {"pose"},  # the wrists of the body model only
    "SAW": {"pose"},
    "FA": {"face"},
}


def keypoints_from_video(path: Path, test_code: str) -> Keypoints:
    import mediapipe as mp

    kinds = TEST_KINDS[test_code]
    detectors = mediapipe_detectors(kinds)
    try:
        kp = extract(video_frames(path), detectors)
    finally:
        for d in detectors.values():
            d.close()  # type: ignore[attr-defined]
    kp.version = getattr(mp, "__version__", "")
    kp.models = [analysis_config()["models"][k]["name"] for k in sorted(kinds)]
    return kp
