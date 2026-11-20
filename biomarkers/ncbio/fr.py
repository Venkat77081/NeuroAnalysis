"""Forearm Roll, FR1–FR12 (DNE JBHI 2024 Table A-II; Hoang et al. 2022, Sec. V-D): the wrist's
vertical position (pose 16 right / 15 left) in forearm lengths. The forearms roll around each
other, so each wrist goes up and down; a cycle (a roll) runs from one lowest point to the next
(ncbio/cyclic.py). No hand points are needed."""

from __future__ import annotations

import numpy as np

from .cyclic import FOREARM, cyclic_biomarkers, layout
from .keypoints import Keypoints
from .result import Value

LAYOUT = layout("FR")


def wrist_height(kp: Keypoints, side: str, forearm_px: float) -> np.ndarray:
    """How high the wrist is above its lowest point (95th percentile of image y), in forearm
    lengths: image y grows downwards, so height = (low − y) ÷ forearm. Never below about 0."""
    y = kp.pose[:, FOREARM[side][1], 1]
    if not np.isfinite(y).any():
        return np.full(kp.t.size, np.nan)
    low = float(np.nanpercentile(y, 95))
    return (low - y) / forearm_px


def forearm_roll(kp: Keypoints, cfg: dict, details: dict | None = None) -> list[Value]:
    return cyclic_biomarkers(kp, cfg, "FR", wrist_height, details)
