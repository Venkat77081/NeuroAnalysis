"""Finger Tapping, FT1–FT12 (DNE JBHI 2024 Table A-II; Hoang et al. 2022, Table III, Sec. V-D).

d_ft = ‖thumb tip (hand 4) − index tip (hand 8)‖ per hand, divided by that side's forearm length
(pose elbow → wrist, median over frames). A cycle runs from one minimum (fingers closed) to the
next. Per hand: amplitude (max − min), period (time between minima), max speed |d′| and max
acceleration |d″|, each the mean over cycles; then Asym(R, L) = |R − L| / (R + L).

`finger_tapping(..., details=d)` also fills `d` with every intermediate number (signals, forearm
length, each cycle's values) so the report can show the working.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import signals
from .keypoints import Keypoints
from .result import Value, computed, not_computable

#: Pose elbow and wrist per side (MediaPipe pose 33).
FOREARM = {"right": (14, 16), "left": (13, 15)}
THUMB_TIP, INDEX_TIP = 4, 8
MEASURES = ("amplitude", "period", "speed", "acceleration")

#: (right id, left id, asymmetry id, measure, unit)
LAYOUT = [
    ("FT1", "FT2", "FT3", "amplitude", "forearm"),
    ("FT4", "FT5", "FT6", "period", "s"),
    ("FT7", "FT8", "FT9", "speed", "forearm/s"),
    ("FT10", "FT11", "FT12", "acceleration", "forearm/s²"),
]


@dataclass
class HandDetail:
    """Everything computed for one hand, for the report."""

    side: str
    found_frac: float = 0.0
    forearm_px: float = float("nan")
    forearm_frames: int = 0
    raw: np.ndarray | None = None  # d_ft in forearm lengths, before smoothing
    smooth: np.ndarray | None = None
    cycles: list[tuple[int, int]] = field(default_factory=list)
    per_cycle: dict[str, list[float]] = field(default_factory=dict)
    means: dict[str, float] = field(default_factory=dict)
    reason: str | None = None


def forearm_length(kp: Keypoints, side: str) -> tuple[float, int]:
    """Median elbow → wrist distance (px) and the number of frames it was measured in."""
    e, w = FOREARM[side]
    d = np.linalg.norm(kp.pose[:, e, :2] - kp.pose[:, w, :2], axis=1)
    n = int(np.isfinite(d).sum())
    return signals.reference_length(kp.pose[:, e], kp.pose[:, w]), n


def tapping_distance(kp: Keypoints, side: str) -> np.ndarray:
    """d_ft for one hand, in forearm lengths (NaN where the hand or the forearm is missing)."""
    hand = kp.hands.get(side)
    ref, _ = forearm_length(kp, side)
    if hand is None or not np.isfinite(ref) or ref <= 0:
        return np.full(kp.t.size, np.nan)
    return np.linalg.norm(hand[:, THUMB_TIP, :2] - hand[:, INDEX_TIP, :2], axis=1) / ref


def hand_measures(x: np.ndarray, t: np.ndarray, cfg: dict, d: HandDetail | None = None) -> HandDetail:
    """Per-hand means over cycles (or a reason), with every step kept in the detail."""
    d = d or HandDetail(side="")
    d.raw = x
    d.found_frac = float(np.isfinite(x).mean()) if x.size else 0.0
    if d.found_frac < cfg["minValidFrac"]:
        d.reason = f"found in {round(d.found_frac * 100)} % of frames"
        return d
    y = signals.smooth(x, t, cfg)
    d.smooth = y
    d.cycles = signals.cycles(y, t, cfg)
    if len(d.cycles) < cfg["cycles"]["minCycles"]:
        d.reason = f"only {len(d.cycles)} taps found"
        return d
    v = np.gradient(y, t)
    a = np.gradient(v, t)
    pc: dict[str, list[float]] = {k: [] for k in MEASURES}
    for i0, i1 in d.cycles:
        s = slice(i0, i1 + 1)
        pc["amplitude"].append(float(np.nanmax(y[s]) - np.nanmin(y[s])))
        pc["period"].append(float(t[i1] - t[i0]))
        pc["speed"].append(float(np.nanmax(np.abs(v[s]))))
        pc["acceleration"].append(float(np.nanmax(np.abs(a[s]))))
    d.per_cycle = pc
    d.means = {k: float(np.mean(vs)) for k, vs in pc.items()}
    return d


def finger_tapping(kp: Keypoints, cfg: dict, details: dict | None = None) -> list[Value]:
    hands: dict[str, HandDetail] = {}
    for side in ("right", "left"):
        ref, n = forearm_length(kp, side)
        d = HandDetail(side=side, forearm_px=ref, forearm_frames=n)
        hands[side] = hand_measures(tapping_distance(kp, side), kp.t, cfg, d)
    out: list[Value] = []
    for rid, lid, aid, key, unit in LAYOUT:
        for side, bid in (("right", rid), ("left", lid)):
            h = hands[side]
            if h.reason:
                out.append(not_computable(bid, f"{side} hand {h.reason}"))
            else:
                out.append(computed(bid, h.means[key], unit, len(h.cycles)))
        r = hands["right"].means.get(key)
        left = hands["left"].means.get(key)
        a = signals.asym(r, left)
        out.append(computed(aid, a, "ratio") if a is not None else not_computable(aid, "needs both hands"))
    if details is not None:
        details["hands"] = hands
        details["t"] = kp.t
    return out
