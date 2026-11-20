"""Pre-processing shared by every test (DNE paper, Sec. IV-C): fill short gaps, median and
Savitzky–Golay smoothing, normalisation by a reference length, and cycle finding."""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks, medfilt, savgol_filter

from .config import analysis_config


def fps_of(t: np.ndarray) -> float:
    d = np.diff(t)
    return float(1.0 / np.median(d)) if d.size else 0.0


def runs(valid: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of each run of True."""
    v = np.concatenate([[False], valid.astype(bool), [False]])
    edges = np.flatnonzero(np.diff(v.astype(int)))
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2], strict=True)]


def fill_gaps(x: np.ndarray, t: np.ndarray, max_gap_s: float) -> np.ndarray:
    """Linear interpolation over missing stretches of at most max_gap_s inside the signal."""
    x = np.asarray(x, dtype=float).copy()
    ok = np.isfinite(x)
    if ok.sum() < 2:
        return x
    for a, b in runs(~ok):
        if a == 0 or b == x.size:
            continue  # never extrapolate at the ends
        if t[b] - t[a - 1] <= max_gap_s + 1e-9:
            x[a:b] = np.interp(t[a:b], [t[a - 1], t[b]], [x[a - 1], x[b]])
    return x


def smooth(x: np.ndarray, t: np.ndarray, cfg: dict | None = None) -> np.ndarray:
    """Gap fill, then a median and a Savitzky–Golay filter on each run without gaps."""
    p = (cfg or analysis_config())["preprocess"]
    y = fill_gaps(x, t, p["maxGapS"])
    fps = fps_of(t)
    win = max(int(round(p["savgolWindowS"] * fps)) | 1, p["savgolOrder"] + 2 | 1)
    out = np.full_like(y, np.nan)
    for a, b in runs(np.isfinite(y)):
        seg = y[a:b]
        if seg.size >= p["medianKernel"]:
            seg = medfilt(seg, p["medianKernel"])
        if seg.size >= win:
            seg = savgol_filter(seg, win, p["savgolOrder"])
        out[a:b] = seg
    return out


def reference_length(a: np.ndarray, b: np.ndarray) -> float:
    """Median distance between two points over the frames where both are found (2-D, px)."""
    d = np.linalg.norm(a[:, :2] - b[:, :2], axis=1)
    d = d[np.isfinite(d)]
    return float(np.median(d)) if d.size else float("nan")


def minima(x: np.ndarray, t: np.ndarray, cfg: dict | None = None) -> np.ndarray:
    """Indices of the movement minima (one per cycle boundary), within runs without gaps."""
    c = (cfg or analysis_config())["cycles"]
    fps = fps_of(t)
    out: list[int] = []
    for a, b in runs(np.isfinite(x)):
        seg = x[a:b]
        if seg.size < 3:
            continue
        lo, hi = np.percentile(seg, [5, 95])
        prom = c["minProminenceFrac"] * (hi - lo)
        if prom <= 0:
            continue
        idx, _ = find_peaks(-seg, prominence=prom, distance=max(1, int(c["minPeriodS"] * fps)))
        out.extend(int(i) + a for i in idx)
    return np.asarray(out, dtype=int)


def cycles(x: np.ndarray, t: np.ndarray, cfg: dict | None = None) -> list[tuple[int, int]]:
    """Cycles as (minimum, next minimum) index pairs with no missing frame between them."""
    m = minima(x, t, cfg)
    ok = np.isfinite(x)
    return [(int(a), int(b)) for a, b in zip(m[:-1], m[1:], strict=True) if ok[a : b + 1].all()]


def asym(r: float | None, left: float | None) -> float | None:
    """Asym(R, L) = |R − L| / (R + L); None when either side is missing."""
    if r is None or left is None or not np.isfinite(r + left) or r + left == 0:
        return None
    return float(abs(r - left) / (r + left))
