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
