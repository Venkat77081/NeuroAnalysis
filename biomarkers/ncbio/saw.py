"""Stand and Walk, SAW1–SAW15 (DNE JBHI 2024 Table A-II; Hoang et al. 2022, Table III, Sec. V-D).

The patient stands up from a chair and walks back and forth along a 15 ft (4.6 m) walkway, filmed
from the side. MediaPipe's pose model gives each body point twice: in the image (px) and as a 3-D
estimate in metres around the hips ("world" points, from the same single video).

- Trunk: pelvis (hip midpoint, 23/24) to neck (shoulder midpoint, 11/12), 3-D; its median is the
  unit for distances (and its image length for the pelvis's movement across the picture).
- d_saw = ‖right ankle − left ankle‖ (3-D, 27/28) ÷ trunk. A step is a local top of d_saw (the
  feet furthest apart); the low between two steps is where the feet pass (step width).
- Walking segments: where the pelvis moves across the picture at least `walkSpeedFrac` of its
  90th-percentile speed (and `minWalkSpeed` trunk/s), for at least `minWalkS`. A turn is the stretch
  between two walking segments that go in opposite directions. Standing up, sitting down and pauses
  are neither.

Measures (pooled over the walking segments unless noted):
- SAW1 / SAW15: STD / mean step time (time between consecutive steps);
- SAW2 / SAW3: mean / median step length (d_saw at each step);
- SAW4 / SAW5: mean / STD step width (the lowest d_saw between two steps);
- SAW6–8: per walking segment, the CC of the left and right knee angles (3-D hip–knee–ankle),
  aligned by the time shift that matches them best (within one stride); median, mean, STD;
- SAW9: per stride (two steps), the CC of the left and right ankles' forward positions (relative
  to the pelvis), aligned the same way; mean;
- SAW10 / SAW11: mean / STD cadence (steps ÷ segment duration, per minute) over the segments;
- SAW12: mean walking speed (pelvis distance ÷ segment duration, in trunk lengths per second);
- SAW13 / SAW14: mean / STD turning time.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.signal import find_peaks

from . import signals
from .keypoints import Keypoints
from .result import Value, computed, not_computable

SHOULDERS, HIPS = (11, 12), (23, 24)
KNEES = {"left": 25, "right": 26}
ANKLES = {"left": 27, "right": 28}
HIP = {"left": 23, "right": 24}

#: (id, measure, statistic, unit)
LAYOUT: list[tuple[str, str, str, str]] = [
    ("SAW1", "step_time", "std", "s"),
    ("SAW2", "step_length", "mean", "trunk"),
    ("SAW3", "step_length", "median", "trunk"),
    ("SAW4", "step_width", "mean", "trunk"),
    ("SAW5", "step_width", "std", "trunk"),
    ("SAW6", "knee_cc", "median", "ratio"),
    ("SAW7", "knee_cc", "mean", "ratio"),
    ("SAW8", "knee_cc", "std", "ratio"),
    ("SAW9", "foot_cc", "mean", "ratio"),
    ("SAW10", "cadence", "mean", "steps/min"),
    ("SAW11", "cadence", "std", "steps/min"),
    ("SAW12", "speed", "mean", "trunk/s"),
    ("SAW13", "turn_time", "mean", "s"),
    ("SAW14", "turn_time", "std", "s"),
    ("SAW15", "step_time", "mean", "s"),
]
STEP_MEASURES = {"step_time", "step_length", "step_width", "knee_cc", "foot_cc", "cadence", "speed"}


@dataclass
class Segment:
    """One walking segment [i0, i1] (frame indices, inclusive)."""

    i0: int
    i1: int
    direction: int  # +1 = towards the image's right, −1 = left
    steps: list[int] = field(default_factory=list)  # d_saw tops
    passes: list[int] = field(default_factory=list)  # lows between two steps
    cadence: float | None = None
    speed: float | None = None
    knee_cc: float | None = None


def _mid(a: np.ndarray, pair: tuple[int, int]) -> np.ndarray:
    return (a[:, pair[0]] + a[:, pair[1]]) / 2


def knee_angle(world: np.ndarray, side: str) -> np.ndarray:
    """Knee flexion in degrees: 180° − the 3-D angle hip–knee–ankle (0 = straight leg)."""
    a = world[:, HIP[side]] - world[:, KNEES[side]]
    b = world[:, ANKLES[side]] - world[:, KNEES[side]]
    cos = np.sum(a * b, axis=1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
    return 180.0 - np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def _cc(a: np.ndarray, b: np.ndarray) -> float | None:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 5 or np.std(a[ok]) < 1e-12 or np.std(b[ok]) < 1e-12:
        return None
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def aligned_cc(
    r: np.ndarray, left: np.ndarray, a: int, b: int, lo: int, hi: int, max_lag: int
) -> float | None:
    """The best CC of r[a:b] with left shifted by up to ±max_lag frames, inside [lo, hi)."""
    best: float | None = None
    for k in range(-max_lag, max_lag + 1):
        if a + k < lo or b + k > hi:
            continue
        cc = _cc(r[a:b], left[a + k : b + k])
        if cc is not None and (best is None or cc > best):
            best = cc
    return best


def walking_segments(v: np.ndarray, t: np.ndarray, c: dict) -> list[Segment]:
    """Runs where the pelvis moves across the picture fast enough, for long enough."""
    s = np.abs(v)
    if not np.isfinite(s).any():
        return []
    top = float(np.nanpercentile(s, 90))
    thr = max(c["walkSpeedFrac"] * top, c["minWalkSpeed"])
    out = []
    for a, b in signals.runs(np.nan_to_num(s, nan=0.0) >= thr):
        if t[b - 1] - t[a] >= c["minWalkS"]:
            out.append(Segment(a, b - 1, int(np.sign(np.nanmean(v[a:b])))))
    return out


def turns(segs: list[Segment]) -> list[tuple[int, int]]:
    """(end of one walk, start of the next) where the walking direction reverses."""
    return [(p.i1, n.i0) for p, n in zip(segs[:-1], segs[1:], strict=True) if p.direction != n.direction]


def find_steps(d: np.ndarray, seg: Segment, fps: float, c: dict) -> None:
    x = d[seg.i0 : seg.i1 + 1]
    if not np.isfinite(x).all() or x.size < 5:
        return
    lo, hi = np.percentile(x, [5, 95])
    if hi - lo <= 0:
        return
    tops, _ = find_peaks(
        x, prominence=c["stepProminenceFrac"] * (hi - lo), distance=max(1, int(c["minStepS"] * fps))
    )
    seg.steps = [int(i) + seg.i0 for i in tops]
    seg.passes = [
        int(a + np.argmin(d[a : b + 1])) for a, b in zip(seg.steps[:-1], seg.steps[1:], strict=True)
    ]


def _stat(vs: list[float], stat: str) -> float | None:
    need = 2 if stat == "std" else 1
    if len(vs) < need:
        return None
    return float({"mean": np.mean, "median": np.median, "std": np.std}[stat](vs))


def stand_and_walk(kp: Keypoints, cfg: dict, details: dict | None = None) -> list[Value]:
    t, c = kp.t, cfg["saw"]
    fps = kp.fps or 60.0
    w = kp.pose_world[..., :3]
    trunk_w = np.linalg.norm(_mid(w, HIPS) - _mid(w, SHOULDERS), axis=1)
    trunk_p = np.linalg.norm(_mid(kp.pose[..., :2], HIPS) - _mid(kp.pose[..., :2], SHOULDERS), axis=1)
    needed = [*SHOULDERS, *HIPS, *KNEES.values(), *ANKLES.values()]
    found = np.isfinite(w[:, needed]).all(axis=(1, 2)) & np.isfinite(trunk_p)
    found_frac = float(found.mean()) if found.size else 0.0
    trunk_m = float(np.nanmedian(trunk_w)) if np.isfinite(trunk_w).any() else float("nan")
    trunk_px = float(np.nanmedian(trunk_p)) if np.isfinite(trunk_p).any() else float("nan")

    reason = None
    if found_frac < cfg["minValidFrac"]:
        reason = f"body found in {round(found_frac * 100)} % of frames"
    elif not (trunk_m > 0 and trunk_px > 0):
        reason = "trunk not found"

    d = pelvis = v = np.full(t.size, np.nan)
    knees = {s: np.full(t.size, np.nan) for s in KNEES}
    feet = {s: np.full(t.size, np.nan) for s in ANKLES}
    segs: list[Segment] = []
    turn_list: list[tuple[int, int]] = []
    pc: dict[str, list[float]] = {
        k: []
        for k in (
            "step_time",
            "step_length",
            "step_width",
            "knee_cc",
            "foot_cc",
            "cadence",
            "speed",
            "turn_time",
        )
    }
    if reason is None:
        d = signals.smooth(
            np.linalg.norm(w[:, ANKLES["right"]] - w[:, ANKLES["left"]], axis=1) / trunk_m, t, cfg
        )
        pelvis = signals.smooth(_mid(kp.pose[..., :2], HIPS)[:, 0] / trunk_px, t, cfg)
        v = np.gradient(pelvis, t)
        hip_w = _mid(w, HIPS)
        for s in KNEES:
            knees[s] = signals.smooth(knee_angle(w, s), t, cfg)
            feet[s] = signals.smooth(w[:, ANKLES[s], 0] - hip_w[:, 0], t, cfg)
        segs = walking_segments(v, t, c)
        turn_list = turns(segs)
        for g in segs:
            find_steps(d, g, fps, c)
            dur = float(t[g.i1] - t[g.i0])
            if g.steps and dur > 0:
                g.cadence = len(g.steps) / dur * 60.0
                pc["cadence"].append(g.cadence)
            g.speed = abs(float(pelvis[g.i1] - pelvis[g.i0])) / dur if dur > 0 else None
            if g.speed is not None:
                pc["speed"].append(g.speed)
            pc["step_time"] += [float(t[b] - t[a]) for a, b in zip(g.steps[:-1], g.steps[1:], strict=True)]
            pc["step_length"] += [float(d[i]) for i in g.steps]
            pc["step_width"] += [float(d[i]) for i in g.passes]
            if len(g.steps) >= 3:
                stride = int(round(2 * np.median(np.diff(g.steps))))
                # The right knee over the segment less one stride at each end, so the left can shift.
                if g.i1 + 1 - g.i0 > 3 * stride:
                    g.knee_cc = aligned_cc(
                        knees["right"],
                        knees["left"],
                        g.i0 + stride,
                        g.i1 + 1 - stride,
                        g.i0,
                        g.i1 + 1,
                        stride,
                    )
                if g.knee_cc is not None:
                    pc["knee_cc"].append(g.knee_cc)
                for a, b in zip(g.steps[:-2], g.steps[2:], strict=True):
                    cc = aligned_cc(feet["right"], feet["left"], a, b + 1, g.i0, g.i1 + 1, b - a)
                    if cc is not None:
                        pc["foot_cc"].append(cc)
        pc["turn_time"] = [float(t[b] - t[a]) for a, b in turn_list]

    n_steps = sum(len(g.steps) for g in segs)
    out: list[Value] = []
    for bid, key, stat, unit in LAYOUT:
        if reason:
            out.append(not_computable(bid, reason))
            continue
        if key in STEP_MEASURES and not segs:
            out.append(not_computable(bid, "no walking found"))
            continue
        if key in STEP_MEASURES and n_steps < c["minSteps"]:
            out.append(not_computable(bid, f"only {n_steps} steps found"))
            continue
        if key == "turn_time" and not turn_list:
            out.append(not_computable(bid, "no turn found"))
            continue
        val = _stat(pc[key], stat)
        if val is None:
            out.append(
                not_computable(bid, "too few to compare" if stat == "std" else "could not be measured")
            )
        else:
            out.append(computed(bid, val, unit, len(pc[key])))
    if details is not None:
        details.update(
            test="SAW",
            t=t,
            d_saw=d,
            pelvis=pelvis,
            speed=v,
            knees=knees,
            feet=feet,
            segments=segs,
            turns=turn_list,
            per=pc,
            found_frac=found_frac,
            trunk_m=trunk_m,
            trunk_px=trunk_px,
            trunk_frames=int(np.isfinite(trunk_w).sum()),
        )
    return out
