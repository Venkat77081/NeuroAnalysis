"""Finger Tapping, FT1–FT12: d_ft = ‖thumb tip (hand 4) − index tip (hand 8)‖ per hand, in forearm
lengths. A cycle (a tap) runs from one closing of the fingers to the next (ncbio/cyclic.py)."""

from __future__ import annotations

import numpy as np

from .cyclic import FOREARM, MEASURES, HandDetail, cyclic_biomarkers, layout
from .keypoints import Keypoints
from .result import Value

THUMB_TIP, INDEX_TIP = 4, 8
LAYOUT = layout("FT")
__all__ = ["FOREARM", "INDEX_TIP", "LAYOUT", "MEASURES", "THUMB_TIP", "HandDetail", "finger_tapping"]


def tapping_distance(kp: Keypoints, side: str, forearm_px: float) -> np.ndarray:
    hand = kp.hands.get(side)
    if hand is None:
        return np.full(kp.t.size, np.nan)
    return np.linalg.norm(hand[:, THUMB_TIP, :2] - hand[:, INDEX_TIP, :2], axis=1) / forearm_px


def finger_tapping(kp: Keypoints, cfg: dict, details: dict | None = None) -> list[Value]:
    return cyclic_biomarkers(kp, cfg, "FT", tapping_distance, details)
