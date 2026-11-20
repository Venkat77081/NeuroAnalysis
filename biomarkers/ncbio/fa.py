"""Facial Activation, FA1–FA18 (DNE JBHI 2024, Appendix B and Table A-III).

Distances between groups of face mesh points (MediaPipe face 478): Eq. A-I, the root of the summed
squared distances between paired points of the two groups. Each frame is divided by that frame's
distance between the inner eye corners (points 133 and 362), so head size and distance from the
camera drop out; then the shared pre-processing (gap fill, median and Savitzky–Golay filters).

- FA1–FA5: STD of eye opening (R, L), mouth opening, mouth width, jaw opening;
- FA6–FA10: STD of the speed (change per second) of eye opening (R, L), eyebrow height (R, L),
  mouth opening;
- FA11–FA14: NIQR = (P90 − P10) ÷ P90 of eye opening (R, L), mouth opening, mouth width;
- FA15–FA18: Pearson correlation of left and right: eye opening, mouth opening, and their speeds.

Mouth opening is the mean of its left and right halves. With `details`, every signal and every
intermediate number is kept for the report.
"""

from __future__ import annotations

import numpy as np

from . import signals
from .keypoints import Keypoints
from .result import Value, computed, not_computable

INNER_EYES = (133, 362)

#: Table A-III: distance → (κ, κ′), paired point by point.
GROUPS: dict[str, tuple[tuple[int, ...], tuple[int, ...]]] = {
    "eye_l": ((466, 388, 387, 386, 385, 384, 398), (249, 390, 373, 374, 380, 381, 382)),
    "eye_r": ((7, 163, 144, 145, 153, 154, 155), (246, 161, 160, 159, 158, 157, 173)),
    "brow_l": ((300, 293, 334, 296, 336), (388, 387, 386, 385, 384)),
    "brow_r": ((70, 63, 105, 66, 107), (161, 160, 159, 158, 157)),
    "mouth_l": ((88, 178, 87), (80, 81, 82)),
    "mouth_r": ((317, 402, 318), (312, 311, 310)),
    "width": ((78,), (308,)),
    "jaw": ((80, 81, 82, 13, 312, 311, 310), (170, 140, 171, 175, 396, 369, 395)),
}

#: (id, kind, signal(s), unit). Kinds: std, speed (STD of the change per second), niqr, cc, cc_speed.
LAYOUT: list[tuple[str, str, tuple[str, ...], str]] = [
    ("FA1", "std", ("eye_r",), "ied"),
    ("FA2", "std", ("eye_l",), "ied"),
    ("FA3", "std", ("mouth",), "ied"),
    ("FA4", "std", ("width",), "ied"),
    ("FA5", "std", ("jaw",), "ied"),
    ("FA6", "speed", ("eye_r",), "ied/s"),
    ("FA7", "speed", ("eye_l",), "ied/s"),
    ("FA8", "speed", ("brow_r",), "ied/s"),
    ("FA9", "speed", ("brow_l",), "ied/s"),
    ("FA10", "speed", ("mouth",), "ied/s"),
    ("FA11", "niqr", ("eye_r",), "ratio"),
    ("FA12", "niqr", ("eye_l",), "ratio"),
    ("FA13", "niqr", ("mouth",), "ratio"),
    ("FA14", "niqr", ("width",), "ratio"),
    ("FA15", "cc", ("eye_l", "eye_r"), "ratio"),
    ("FA16", "cc", ("mouth_l", "mouth_r"), "ratio"),
    ("FA17", "cc_speed", ("eye_l", "eye_r"), "ratio"),
    ("FA18", "cc_speed", ("mouth_l", "mouth_r"), "ratio"),
]


def group_distance(face: np.ndarray, a: tuple[int, ...], b: tuple[int, ...]) -> np.ndarray:
    """Eq. A-I per frame: √Σ‖p_κk − p_κ′k‖² over the paired points (2-D, px)."""
    d = face[:, list(a), :2] - face[:, list(b), :2]
    return np.sqrt(np.sum(d**2, axis=(1, 2)))


def face_signals(kp: Keypoints, cfg: dict) -> tuple[dict[str, np.ndarray], np.ndarray, float]:
    """Every distance, per frame, in inner-eye distances and smoothed; the raw IED (px); found share."""
    t = kp.t
    if kp.face is None:
        n = t.size
        return {k: np.full(n, np.nan) for k in [*GROUPS, "mouth"]}, np.full(n, np.nan), 0.0
    f = kp.face
    ied = np.linalg.norm(f[:, INNER_EYES[0], :2] - f[:, INNER_EYES[1], :2], axis=1)
    ied = np.where(ied > 0, ied, np.nan)
    out: dict[str, np.ndarray] = {}
    for name, (a, b) in GROUPS.items():
        out[name] = signals.smooth(group_distance(f, a, b) / ied, t, cfg)
    out["mouth"] = (out["mouth_l"] + out["mouth_r"]) / 2
    found = float(np.isfinite(ied).mean()) if ied.size else 0.0
    return out, ied, found


def speed(x: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Change per second between frames (the paper's diff, per second so frame rates compare)."""
    return np.diff(x) / np.diff(t)


def niqr(x: np.ndarray) -> float | None:
    v = x[np.isfinite(x)]
    if v.size < 3:
        return None
    p10, p90 = np.percentile(v, [10, 90])
    return float((p90 - p10) / p90) if p90 > 0 else None


def _cc(a: np.ndarray, b: np.ndarray) -> float | None:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3 or np.std(a[ok]) < 1e-12 or np.std(b[ok]) < 1e-12:
        return None
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def _std(x: np.ndarray) -> float | None:
    v = x[np.isfinite(x)]
    return float(np.std(v)) if v.size >= 3 else None


def facial_activation(kp: Keypoints, cfg: dict, details: dict | None = None) -> list[Value]:
    t = kp.t
    sig, ied, found = face_signals(kp, cfg)
    calc: dict[str, dict] = {}
    out: list[Value] = []
    reason = f"face found in {round(found * 100)} % of frames" if found < cfg["minValidFrac"] else None
    for bid, kind, names, unit in LAYOUT:
        if reason:
            out.append(not_computable(bid, reason))
            continue
        x = sig[names[0]]
        if kind == "std":
            v = _std(x)
            calc[bid] = {"n": int(np.isfinite(x).sum()), "mean": float(np.nanmean(x))}
        elif kind == "speed":
            s = speed(x, t)
            v = _std(s)
            calc[bid] = {"n": int(np.isfinite(s).sum()), "mean": float(np.nanmean(s))}
        elif kind == "niqr":
            v = niqr(x)
            ok = x[np.isfinite(x)]
            if ok.size:
                p10, p90 = np.percentile(ok, [10, 90])
                calc[bid] = {"p10": float(p10), "p90": float(p90)}
        else:
            a, b = sig[names[0]], sig[names[1]]
            if kind == "cc_speed":
                a, b = speed(a, t), speed(b, t)
            v = _cc(a, b)
            calc[bid] = {"n": int((np.isfinite(a) & np.isfinite(b)).sum())}
        out.append(
            computed(bid, v, unit) if v is not None else not_computable(bid, "too little movement to measure")
        )
    if details is not None:
        details.update(
            test="FA",
            t=t,
            face_signals=sig,
            found_frac=found,
            ied_px=float(np.nanmedian(ied)) if np.isfinite(ied).any() else float("nan"),
            ied_frames=int(np.isfinite(ied).sum()),
            calc=calc,
        )
    return out
