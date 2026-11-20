"""Finger Tapping, FT1–FT12 (DNE JBHI 2024 Table A-II; Hoang et al. 2022, Table III, Sec. V-D).

d_ft = ‖thumb tip (hand 4) − index tip (hand 8)‖ per hand, divided by that side's forearm length
(pose elbow → wrist, median over frames). A cycle runs from one minimum (fingers closed) to the
next. Per hand: amplitude (max − min), period (time between minima), max speed |d′| and max
acceleration |d″|, each the mean over cycles; then Asym(R, L) = |R − L| / (R + L).
"""

from __future__ import annotations

import numpy as np

from . import signals
from .keypoints import Keypoints
from .result import Value, computed, not_computable

#: Pose elbow and wrist per side (MediaPipe pose 33).
FOREARM = {"right": (14, 16), "left": (13, 15)}
THUMB_TIP, INDEX_TIP = 4, 8

#: (right id, left id, asymmetry id, measure, unit)
LAYOUT = [
    ("FT1", "FT2", "FT3", "amplitude", "forearm"),
    ("FT4", "FT5", "FT6", "period", "s"),
    ("FT7", "FT8", "FT9", "speed", "forearm/s"),
    ("FT10", "FT11", "FT12", "acceleration", "forearm/s²"),
]


def tapping_distance(kp: Keypoints, side: str) -> np.ndarray:
    """d_ft for one hand, in forearm lengths (NaN where the hand or the forearm is missing)."""
    hand = kp.hands.get(side)
    if hand is None:
        return np.full(kp.t.size, np.nan)
    d = np.linalg.norm(hand[:, THUMB_TIP, :2] - hand[:, INDEX_TIP, :2], axis=1)
    e, w = FOREARM[side]
    ref = signals.reference_length(kp.pose[:, e], kp.pose[:, w])
    if not np.isfinite(ref) or ref <= 0:
        return np.full(kp.t.size, np.nan)
    return d / ref


def hand_measures(x: np.ndarray, t: np.ndarray, cfg: dict) -> tuple[dict[str, float], int] | str:
    """Per-hand means over cycles, or the reason they cannot be computed."""
    found = float(np.isfinite(x).mean()) if x.size else 0.0
    if found < cfg["minValidFrac"]:
        return f"found in {round(found * 100)} % of frames"
    y = signals.smooth(x, t, cfg)
    cyc = signals.cycles(y, t, cfg)
    if len(cyc) < cfg["cycles"]["minCycles"]:
        return f"only {len(cyc)} taps found"
    v = np.gradient(y, t)
    a = np.gradient(v, t)
    amp, per, spd, acc = [], [], [], []
    for i0, i1 in cyc:
        s = slice(i0, i1 + 1)
        amp.append(np.nanmax(y[s]) - np.nanmin(y[s]))
        per.append(t[i1] - t[i0])
        spd.append(np.nanmax(np.abs(v[s])))
        acc.append(np.nanmax(np.abs(a[s])))
    m = {"amplitude": amp, "period": per, "speed": spd, "acceleration": acc}
    return {k: float(np.mean(vs)) for k, vs in m.items()}, len(cyc)


def finger_tapping(kp: Keypoints, cfg: dict) -> list[Value]:
    per_side = {s: hand_measures(tapping_distance(kp, s), kp.t, cfg) for s in ("right", "left")}
    out: list[Value] = []
    for rid, lid, aid, key, unit in LAYOUT:
        vals: dict[str, float | None] = {}
        for side, bid in (("right", rid), ("left", lid)):
            r = per_side[side]
            if isinstance(r, str):
                out.append(not_computable(bid, f"{side} hand {r}"))
                vals[side] = None
            else:
                out.append(computed(bid, r[0][key], unit, r[1]))
                vals[side] = r[0][key]
        a = signals.asym(vals["right"], vals["left"])
        out.append(computed(aid, a, "ratio") if a is not None else not_computable(aid, "needs both hands"))
    return out
