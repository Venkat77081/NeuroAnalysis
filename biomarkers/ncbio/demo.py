"""A synthetic Finger Tapping take for showing the report (no patient, no video).

The right hand taps at about 3.2 Hz and slowly gets smaller (a decrement); the left hand taps more
slowly and less widely, with one hesitation. Points jitter by a pixel or two and the left hand is
lost for a moment, as in real recordings.
"""

from __future__ import annotations

import numpy as np

from .keypoints import Keypoints

FOREARM_PX = (204.0, 198.0)  # right, left


def _hand(t, f, amp, x0, y0, base, rng, noise, freeze=None, drop=None):
    fr = np.full_like(t, f) * (1 + 0.04 * np.sin(2 * np.pi * 0.21 * t))
    if freeze:
        a, b = freeze
        fr[(t >= a) & (t < b)] = 0.0
    phase = 2 * np.pi * np.cumsum(fr) / 60.0
    d = base + amp(t) * (1 - np.cos(phase)) / 2
    h = np.full((t.size, 21, 3), np.nan)
    h[:, 0, :2] = (x0, y0)
    h[:, 4, 0], h[:, 4, 1] = x0, y0 - 300
    h[:, 8, 0], h[:, 8, 1] = x0 + d, y0 - 300
    h[..., 2] = 0
    h[:, (4, 8), :2] += rng.normal(0, noise, (t.size, 2, 2))
    if drop:
        h[(t >= drop[0]) & (t < drop[1])] = np.nan
    return h


def demo_take(seed: int = 7) -> Keypoints:
    rng = np.random.default_rng(seed)
    t = np.arange(900) / 60.0
    fr, fl = FOREARM_PX
    pose = np.full((t.size, 33, 4), np.nan)
    pose[:, 14, :2], pose[:, 16, :2] = (420, 820), (420, 820 - fr)
    pose[:, 13, :2], pose[:, 15, :2] = (1500, 820), (1500, 820 - fl)
    pose[:, (13, 14, 15, 16), :2] += rng.normal(0, 1.5, (t.size, 4, 2))
    pose[..., 3] = 0.98
    right = _hand(t, 3.2, lambda x: fr * (0.50 - 0.008 * x), 420, 820 - fr, fr * 0.04, rng, 1.2)
    left = _hand(
        t, 2.4, lambda x: fl * 0.34, 1500, 820 - fl, fl * 0.05, rng, 1.6, freeze=(8.2, 8.9), drop=(11.0, 11.1)
    )
    return Keypoints(
        t=t,
        width=1920,
        height=1080,
        pose=pose,
        pose_world=np.full((t.size, 33, 3), np.nan),
        hands={"right": right, "left": left},
        library="synthetic demo",
        version="",
        models=[],
    )
