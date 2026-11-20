"""Finger-to-Finger, FTF1–FTF18 (DNE JBHI 2024 Table A-II; Hoang et al. 2022, Table III, Sec. V-D).

The index finger's middle joint (hand point 6, steadier than the tip) of each hand, in forearm
lengths. A cycle runs from one top of its vertical movement to the next (top-bottom-top).

Per hand (left first, as in the registry):
- period: mean (FTF1/2) and STD (FTF3/4) of the cycle times;
- speed: distance travelled in each half cycle ÷ half period, mean (FTF5/6) and STD (FTF7/8);
- path smoothness: path length ÷ length of a fitted 2nd-order curve over the same span, per half
  cycle, mean (FTF9/10) and STD (FTF11/12); 1 = perfectly smooth, higher = more wavering;
- velocity angle symmetry: θ = atan2(dy/dt, dx/dt) per cycle, resampled to the same length; the
  Pearson CC between every pair of cycles, mean (FTF13/14) and STD (FTF15/16); 1 = every cycle
  moves the same way. θ is compared as (cos θ, sin θ), so its wrap at ±180° does not matter, and
  only where the joint moves (speed ≥ MOVING of that cycle's top speed): at the turning points θ
  is undefined.
Both hands:
- horizontal symmetry (FTF17): CC of the two joints' distances from the body midline (shoulders);
- vertical symmetry (FTF18): CC of their vertical positions; both over the right hand's cycles.

With `details`, every intermediate number is kept for the report.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np

from . import signals
from .cyclic import SIDES, HandDetail, forearm_length
from .keypoints import Keypoints
from .result import Value, computed, not_computable

JOINT = 6  # index finger, middle joint (PIP)
SHOULDERS = (11, 12)
RESAMPLE = 50  # samples per cycle for the velocity-angle comparison
MOVING = 0.2  # share of a cycle's top speed below which θ is not compared

#: (left id, right id, measure, statistic, unit)
LAYOUT = [
    ("FTF1", "FTF2", "period", "mean", "s"),
    ("FTF3", "FTF4", "period", "std", "s"),
    ("FTF5", "FTF6", "speed", "mean", "forearm/s"),
    ("FTF7", "FTF8", "speed", "std", "forearm/s"),
    ("FTF9", "FTF10", "smoothness", "mean", "ratio"),
    ("FTF11", "FTF12", "smoothness", "std", "ratio"),
    ("FTF13", "FTF14", "angle_cc", "mean", "ratio"),
    ("FTF15", "FTF16", "angle_cc", "std", "ratio"),
]
PAIRS = [("FTF17", "horizontal"), ("FTF18", "vertical")]


def joint_xy(kp: Keypoints, side: str, forearm_px: float) -> np.ndarray:
    """(T, 2) joint position in forearm lengths (NaN where not found)."""
    hand = kp.hands.get(side)
    if hand is None or not np.isfinite(forearm_px) or forearm_px <= 0:
        return np.full((kp.t.size, 2), np.nan)
    return hand[:, JOINT, :2] / forearm_px


def path_length(xy: np.ndarray) -> float:
    return float(np.nansum(np.linalg.norm(np.diff(xy, axis=0), axis=1)))


def curve_length(xy: np.ndarray) -> float:
    """Length of a 2nd-order polynomial fitted along the points' main direction, over their span."""
    pts = xy[np.isfinite(xy).all(axis=1)]
    if len(pts) < 4:
        return float("nan")
    c = pts - pts.mean(axis=0)
    _, _, vt = np.linalg.svd(c, full_matrices=False)
    u, v = c @ vt[0], c @ vt[1]
    if np.ptp(u) <= 1e-9:
        return float("nan")
    a, b, k = np.polyfit(u, v, 2)
    uu = np.linspace(u.min(), u.max(), 200)
    vv = a * uu**2 + b * uu + k
    return float(np.sum(np.hypot(np.diff(uu), np.diff(vv))))


def _cc(a: np.ndarray, b: np.ndarray) -> float | None:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3 or np.std(a[ok]) < 1e-12 or np.std(b[ok]) < 1e-12:
        return None
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def _angle_cc(a: np.ndarray, b: np.ndarray) -> float | None:
    """CC of two θ curves compared as (cos θ, sin θ), where both are defined."""
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3:
        return None
    return _cc(np.concatenate([np.cos(a[ok]), np.sin(a[ok])]), np.concatenate([np.cos(b[ok]), np.sin(b[ok])]))


def _resample(x: np.ndarray, n: int = RESAMPLE) -> np.ndarray:
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)


def hand_measures(xy: np.ndarray, t: np.ndarray, cfg: dict, d: HandDetail) -> HandDetail:
    """One hand: cycles from the vertical movement, then the per-cycle and per-half values."""
    x = signals.smooth(xy[:, 0], t, cfg)
    y = signals.smooth(xy[:, 1], t, cfg)
    found = np.isfinite(xy).all(axis=1)
    d.found_frac = float(found.mean()) if found.size else 0.0
    # The report draws the height above the lowest point (image y grows downwards).
    low = float(np.nanpercentile(y, 95)) if np.isfinite(y).any() else 0.0
    d.raw = low - xy[:, 1]
    d.smooth = low - y
    if d.found_frac < cfg["minValidFrac"]:
        d.reason = f"found in {round(d.found_frac * 100)} % of frames"
        return d
    # Tops of the vertical movement are minima of image y.
    d.cycles = signals.cycles(y, t, cfg)
    if len(d.cycles) < cfg["cycles"]["minCycles"]:
        d.reason = f"only {len(d.cycles)} cycles found"
        return d
    vx, vy = np.gradient(x, t), np.gradient(y, t)
    pc: dict[str, list[float]] = {"period": [], "speed": [], "smoothness": []}
    angles: list[np.ndarray] = []
    for i0, i1 in d.cycles:
        pc["period"].append(float(t[i1] - t[i0]))
        mid = i0 + int(np.nanargmax(y[i0 : i1 + 1]))  # the bottom between the two tops
        for a, b in ((i0, mid), (mid, i1)):
            if b - a < 3:
                continue
            seg = np.column_stack([x[a : b + 1], y[a : b + 1]])
            p = path_length(seg)
            pc["speed"].append(p / float(t[b] - t[a]))
            c = curve_length(seg)
            if np.isfinite(c) and c > 0:
                pc["smoothness"].append(p / c)
        cvx, cvy = _resample(vx[i0 : i1 + 1]), _resample(vy[i0 : i1 + 1])
        sp = np.hypot(cvx, cvy)
        th = np.arctan2(cvy, cvx)
        th[sp < MOVING * np.nanmax(sp)] = np.nan
        angles.append(th)
    ccs = [cc for a, b in combinations(angles, 2) if (cc := _angle_cc(a, b)) is not None]
    pc["angle_cc"] = ccs
    d.per_cycle = pc
    d.means = {}
    for k, vs in pc.items():
        if vs:
            d.means[f"{k}.mean"] = float(np.mean(vs))
            d.means[f"{k}.std"] = float(np.std(vs))
    return d


def midline(kp: Keypoints) -> np.ndarray:
    """Body midline x per frame (between the shoulders), px."""
    return np.nanmean(kp.pose[:, SHOULDERS, 0], axis=1)


def pair_symmetry(
    kp: Keypoints, xy: dict[str, np.ndarray], ref: dict[str, float], cycles: list[tuple[int, int]], cfg: dict
) -> dict[str, list[float]]:
    """Per right-hand cycle: CC of the two hands' distances from the midline, and of their heights."""
    t = kp.t
    mid = midline(kp)
    out: dict[str, list[float]] = {"horizontal": [], "vertical": []}
    hx = {s: signals.smooth(np.abs(xy[s][:, 0] - mid / ref[s]), t, cfg) for s in SIDES}
    vy = {s: signals.smooth(xy[s][:, 1], t, cfg) for s in SIDES}
    for i0, i1 in cycles:
        s = slice(i0, i1 + 1)
        for key, sig in (("horizontal", hx), ("vertical", vy)):
            cc = _cc(sig["left"][s], sig["right"][s])
            if cc is not None:
                out[key].append(cc)
    return out


def finger_to_finger(kp: Keypoints, cfg: dict, details: dict | None = None) -> list[Value]:
    hands: dict[str, HandDetail] = {}
    xy: dict[str, np.ndarray] = {}
    ref: dict[str, float] = {}
    for side in SIDES:
        r, n = forearm_length(kp, side)
        ref[side] = r
        xy[side] = joint_xy(kp, side, r)
        hands[side] = hand_measures(
            xy[side], kp.t, cfg, HandDetail(side=side, forearm_px=r, forearm_frames=n)
        )
    out: list[Value] = []
    units = {"period": "s", "speed": "forearm/s", "smoothness": "ratio", "angle_cc": "ratio"}
    for lid, rid, key, stat, _unit in LAYOUT:
        for side, bid in (("left", lid), ("right", rid)):
            h = hands[side]
            v = h.means.get(f"{key}.{stat}")
            if h.reason:
                out.append(not_computable(bid, f"{side} hand {h.reason}"))
            elif v is None:
                out.append(not_computable(bid, f"{side} hand: too few cycles to compare"))
            else:
                out.append(computed(bid, v, units[key], len(h.cycles)))
    pairs: dict[str, list[float]] = {}
    if hands["left"].reason or hands["right"].reason:
        for bid, _ in PAIRS:
            out.append(not_computable(bid, "needs both hands"))
    else:
        pairs = pair_symmetry(kp, xy, ref, hands["right"].cycles, cfg)
        for bid, key in PAIRS:
            vs = pairs[key]
            out.append(
                computed(bid, float(np.mean(vs)), "ratio", len(vs))
                if vs
                else not_computable(bid, "the hands were not found together")
            )
    if details is not None:
        details.update(hands=hands, t=kp.t, test="FTF", pairs=pairs)
    return out
