"""Synthetic keypoints with known movement, for checking the formulas."""

from __future__ import annotations

import numpy as np

from ncbio.keypoints import Keypoints

FOREARM_PX = 200.0


def tapping(
    seconds: float = 15.0,
    fps: float = 60.0,
    right: tuple[float, float] | None = (0.5, 3.0),
    left: tuple[float, float] | None = (0.5, 3.0),
    base: float = 0.05,
    noise_px: float = 0.0,
    seed: int = 0,
) -> Keypoints:
    """Both hands tapping: d_ft(t) = forearm × (base + A (1 − cos 2πft) / 2), (A, f) per side."""
    rng = np.random.default_rng(seed)
    n = int(round(seconds * fps))
    t = np.arange(n) / fps
    pose = np.full((n, 33, 4), np.nan)
    # Elbows 13 (L) / 14 (R) and wrists 15 (L) / 16 (R); the patient faces the camera, so their
    # right side is on the image's left.
    pose[:, 14, :2] = (300, 700)
    pose[:, 16, :2] = (300, 700 - FOREARM_PX)
    pose[:, 13, :2] = (900, 700)
    pose[:, 15, :2] = (900, 700 - FOREARM_PX)
    pose[..., 3] = 0.99
    hands = {}
    for side, spec, x0 in (("right", right, 300.0), ("left", left, 900.0)):
        h = np.full((n, 21, 3), np.nan)
        if spec is not None:
            a, f = spec
            d = FOREARM_PX * (base + a * (1 - np.cos(2 * np.pi * f * t)) / 2)
            h[:, 0, :2] = (x0, 700 - FOREARM_PX)
            h[:, 4, :2] = (x0, 400)
            h[:, 8, 0] = x0 + d
            h[:, 8, 1] = 400
            h[..., 2] = 0
            if noise_px:
                h[:, 4, :2] += rng.normal(0, noise_px, (n, 2))
                h[:, 8, :2] += rng.normal(0, noise_px, (n, 2))
        hands[side] = h
    return Keypoints(
        t=t,
        width=1920,
        height=1080,
        pose=pose,
        pose_world=np.full((n, 33, 3), np.nan),
        hands=hands,
        library="synthetic",
        version="0",
        models=[],
    )


def rolling(
    seconds: float = 15.0,
    fps: float = 60.0,
    right: tuple[float, float] | None = (0.4, 2.0),
    left: tuple[float, float] | None = (0.4, 2.0),
    noise_px: float = 0.0,
    seed: int = 0,
) -> Keypoints:
    """Forearm roll: each forearm (elbow 200 px below the wrist) moves up by
    forearm × A (1 − cos 2πft) / 2, (A, f) per side. No hand points."""
    rng = np.random.default_rng(seed)
    n = int(round(seconds * fps))
    t = np.arange(n) / fps
    pose = np.full((n, 33, 4), np.nan)
    for (elbow, wrist), x0, spec in (((14, 16), 700.0, right), ((13, 15), 1100.0, left)):
        if spec is None:
            continue
        a, f = spec
        wy = 600 - FOREARM_PX * a * (1 - np.cos(2 * np.pi * f * t)) / 2
        pose[:, wrist, 0], pose[:, wrist, 1] = x0, wy
        pose[:, elbow, 0], pose[:, elbow, 1] = x0, wy + FOREARM_PX
        if noise_px:
            pose[:, wrist, :2] += rng.normal(0, noise_px, (n, 2))
    pose[..., 3] = 0.99
    return Keypoints(
        t=t,
        width=1920,
        height=1080,
        pose=pose,
        pose_world=np.full((n, 33, 3), np.nan),
        hands={},
        library="synthetic",
        version="0",
        models=[],
    )


def finger_to_finger(
    seconds: float = 15.0,
    fps: float = 60.0,
    right: tuple[float, float, float] | None = (0.6, 0.3, 1.0),
    left: tuple[float, float, float] | None = (0.6, 0.3, 1.0),
    noise_px: float = 0.0,
    seed: int = 0,
) -> Keypoints:
    """Each index joint (hand 6) moves out and down from the middle and back: (Ax, Ay, f) per side,
    in forearm lengths and Hz. Tops (fingers together, highest) at phase 0."""
    rng = np.random.default_rng(seed)
    n = int(round(seconds * fps))
    t = np.arange(n) / fps
    pose = np.full((n, 33, 4), np.nan)
    mid = 960.0
    pose[:, 11, :2], pose[:, 12, :2] = (mid + 150, 300), (mid - 150, 300)
    hands = {}
    for side, spec, sign, (elbow, wrist) in (("right", right, -1, (14, 16)), ("left", left, 1, (13, 15))):
        pose[:, elbow, :2] = (mid + sign * 400, 700)
        pose[:, wrist, :2] = (mid + sign * 400, 700 - FOREARM_PX)
        h = np.full((n, 21, 3), np.nan)
        if spec is not None:
            ax, ay, f = spec
            g = (1 - np.cos(2 * np.pi * f * t)) / 2
            h[:, :, 0] = (mid + sign * (20 + FOREARM_PX * ax * g))[:, None]
            h[:, :, 1] = (450 + FOREARM_PX * ay * g)[:, None]
            h[..., 2] = 0
            if noise_px:
                h[:, 6, :2] += rng.normal(0, noise_px, (n, 2))
        hands[side] = h
    pose[..., 3] = 0.99
    return Keypoints(
        t=t,
        width=1920,
        height=1080,
        pose=pose,
        pose_world=np.full((n, 33, 3), np.nan),
        hands=hands,
        library="synthetic",
        version="0",
        models=[],
    )


def face_activation(
    seconds: float = 15.0,
    fps: float = 60.0,
    eye: tuple[float, float, float] = (10.0, 6.0, 0.5),
    brow: tuple[float, float, float] = (12.0, 5.0, 0.5),
    mouth: tuple[float, float, float] = (4.0, 10.0, 0.4),
    width: tuple[float, float, float] = (60.0, 12.0, 0.4),
    jaw: tuple[float, float, float] = (40.0, 8.0, 0.4),
    left_phase: float = 0.0,
    ied_px: float = 60.0,
    face_found: bool = True,
    noise_px: float = 0.0,
    seed: int = 0,
) -> Keypoints:
    """A face whose eyelids, brows, lips, mouth corners and chin move as base + A (1 − cos 2πft)/2
    px, (base, A, f) per feature; the left side lags by `left_phase` radians."""
    from ncbio.fa import GROUPS

    rng = np.random.default_rng(seed)
    n = int(round(seconds * fps))
    t = np.arange(n) / fps
    face = np.full((n, 478, 3), np.nan)
    face[..., 2] = 0

    def g(spec, phase=0.0):
        base, a, f = spec
        return base + a * (1 - np.cos(2 * np.pi * f * t - phase)) / 2

    def put(idx, x, y):
        face[:, idx, 0], face[:, idx, 1] = x, y

    face[:, 133, :2] = (-ied_px / 2, 0)
    face[:, 362, :2] = (ied_px / 2, 0)
    for side, sx, ph in (("r", -1, 0.0), ("l", 1, left_phase)):
        h = g(eye, ph)
        b = g(brow, ph)
        upper, lower = (GROUPS["eye_r"][1], GROUPS["eye_r"][0]) if side == "r" else GROUPS["eye_l"]
        brow_pts, lid_pts = GROUPS[f"brow_{side}"]
        for k, (u, lo) in enumerate(zip(upper, lower, strict=True)):
            x = sx * (ied_px / 2 + 5 + 4 * k)
            put(u, x, -h / 2)
            put(lo, x, h / 2)
        for bp, lp in zip(brow_pts, lid_pts, strict=True):
            put(bp, face[0, lp, 0], face[:, lp, 1] - b)
        m = g(mouth, ph)
        lower_m, upper_m = GROUPS[f"mouth_{side}"]
        for k, (lo, u) in enumerate(zip(lower_m, upper_m, strict=True)):
            x = sx * (4 + 6 * k)
            put(u, x, 40.0)
            put(lo, x, 40.0 + m)
    w = g(width)
    put(78, -w / 2, 40.0)
    put(308, w / 2, 40.0)
    j = g(jaw)
    top, chin = GROUPS["jaw"]
    for u, c in zip(top, chin, strict=True):
        if u == 13:
            put(13, 0.0, 40.0)
        put(c, face[0, u, 0], face[:, u, 1] + j)
    if noise_px:
        face[..., :2] += rng.normal(0, noise_px, face[..., :2].shape)
    if not face_found:
        face[:] = np.nan
    return Keypoints(
        t=t,
        width=1280,
        height=720,
        pose=np.full((n, 33, 4), np.nan),
        pose_world=np.full((n, 33, 3), np.nan),
        hands={},
        face=face,
        library="synthetic",
        version="0",
        models=[],
    )
