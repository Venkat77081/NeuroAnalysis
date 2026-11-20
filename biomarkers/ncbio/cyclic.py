"""Shared by the cyclic hand tests (FT, FR; DNE JBHI 2024 Table A-II; Hoang et al. 2022 Sec. V-D).

Each test gives one signal per hand, already divided by that side's forearm length (pose elbow →
wrist, median over frames). A cycle runs from one minimum of the signal to the next. Per hand:
amplitude (max − min), period (time between minima), max speed |x′| and max acceleration |x″|,
each the mean over cycles; then Asym(R, L) = |R − L| / (R + L).

With `details`, every intermediate number (signals, forearm length, each cycle's values) is kept
so the report can show the working.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from . import signals
from .keypoints import Keypoints
from .result import Value, computed, not_computable

#: Pose elbow and wrist per side (MediaPipe pose 33).
FOREARM = {"right": (14, 16), "left": (13, 15)}
MEASURES = ("amplitude", "period", "speed", "acceleration")
SIDES = ("right", "left")

#: (right id, left id, asymmetry id, measure, unit) for each measure, in registry order.
Layout = list[tuple[str, str, str, str, str]]


def layout(prefix: str) -> Layout:
    units = {"amplitude": "forearm", "period": "s", "speed": "forearm/s", "acceleration": "forearm/s²"}
    return [
        (f"{prefix}{3 * i + 1}", f"{prefix}{3 * i + 2}", f"{prefix}{3 * i + 3}", m, units[m])
        for i, m in enumerate(MEASURES)
    ]


@dataclass
class HandDetail:
    """Everything computed for one hand, for the report."""

    side: str
    found_frac: float = 0.0
    forearm_px: float = float("nan")
    forearm_frames: int = 0
    raw: np.ndarray | None = None  # the signal in forearm lengths, before smoothing
    smooth: np.ndarray | None = None
    cycles: list[tuple[int, int]] = field(default_factory=list)
    per_cycle: dict[str, list[float]] = field(default_factory=dict)
    means: dict[str, float] = field(default_factory=dict)
    reason: str | None = None


def forearm_length(kp: Keypoints, side: str) -> tuple[float, int]:
    """Median elbow → wrist distance (px) and the number of frames it was measured in."""
    e, w = FOREARM[side]
    d = np.linalg.norm(kp.pose[:, e, :2] - kp.pose[:, w, :2], axis=1)
    return signals.reference_length(kp.pose[:, e], kp.pose[:, w]), int(np.isfinite(d).sum())


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
        d.reason = f"only {len(d.cycles)} cycles found"
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


Signal = Callable[[Keypoints, str, float], np.ndarray]


def cyclic_biomarkers(
    kp: Keypoints, cfg: dict, test: str, signal: Signal, details: dict | None = None
) -> list[Value]:
    """The test's 12 biomarkers from its signal (`signal(kp, side, forearm_px)`)."""
    rows = layout(test)
    hands: dict[str, HandDetail] = {}
    for side in SIDES:
        ref, n = forearm_length(kp, side)
        d = HandDetail(side=side, forearm_px=ref, forearm_frames=n)
        x = signal(kp, side, ref) if np.isfinite(ref) and ref > 0 else np.full(kp.t.size, np.nan)
        hands[side] = hand_measures(x, kp.t, cfg, d)
    out: list[Value] = []
    for rid, lid, aid, key, unit in rows:
        for side, bid in (("right", rid), ("left", lid)):
            h = hands[side]
            if h.reason:
                out.append(not_computable(bid, f"{side} hand {h.reason}"))
            else:
                out.append(computed(bid, h.means[key], unit, len(h.cycles)))
        a = signals.asym(hands["right"].means.get(key), hands["left"].means.get(key))
        out.append(computed(aid, a, "ratio") if a is not None else not_computable(aid, "needs both hands"))
    if details is not None:
        details.update(hands=hands, t=kp.t, test=test, layout=rows)
    return out
