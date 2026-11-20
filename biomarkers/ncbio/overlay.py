"""A copy of the take with the found points drawn on it, to check them by eye (M15).

Each hand is drawn in its report colour and labelled R or L (the patient's own side): the thumb
tip, the index tip and the line between them (the tapping distance), and the forearm (elbow to
wrist) used to scale it. If R sits on the patient's left hand, the sides are swapped (for example
a mirrored video).

The output shows the patient like the video itself: it stays at the hospital, with the video.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .ft import FOREARM, INDEX_TIP, THUMB_TIP
from .keypoints import Keypoints
from .report import tr

#: BGR, the report's colours: right indigo #4f46e5, left orange #d9480f.
COLOUR = {"right": (229, 70, 79), "left": (15, 72, 217)}


def _pt(p: np.ndarray) -> tuple[int, int] | None:
    return (int(round(p[0])), int(round(p[1]))) if np.all(np.isfinite(p[:2])) else None


def draw_frame(bgr: np.ndarray, kp: Keypoints, i: int) -> np.ndarray:
    """Draws frame i's points on bgr (in place) and returns it."""
    import cv2

    h = bgr.shape[0]
    scale = max(0.6, h / 900)
    thick = max(2, int(round(2 * scale)))
    font = cv2.FONT_HERSHEY_SIMPLEX
    for side in ("right", "left"):
        c = COLOUR[side]
        e, w = (_pt(kp.pose[i, j]) for j in FOREARM[side])
        if e and w:
            cv2.line(bgr, e, w, c, thick, cv2.LINE_AA)
            cv2.circle(bgr, e, 3 * thick, c, -1, cv2.LINE_AA)
        hand = kp.hands.get(side)
        anchor = (w[0], w[1] - int(30 * scale)) if w else None
        if hand is not None:
            a, b = _pt(hand[i, THUMB_TIP]), _pt(hand[i, INDEX_TIP])
            if a and b:
                cv2.line(bgr, a, b, c, thick, cv2.LINE_AA)
            for p in (a, b):
                if p:
                    cv2.circle(bgr, p, 3 * thick, c, -1, cv2.LINE_AA)
                    cv2.circle(bgr, p, 3 * thick, (255, 255, 255), 1, cv2.LINE_AA)
            tips = [p for p in (a, b) if p]
            if tips:  # just above the higher fingertip
                anchor = (min(p[0] for p in tips), min(p[1] for p in tips) - int(22 * scale))
        if anchor:
            label = tr(f"overlay.{side}")
            org = (anchor[0], max(int(60 * scale), anchor[1]))
            cv2.putText(bgr, label, org, font, 0.9 * scale, (255, 255, 255), thick + 3, cv2.LINE_AA)
            cv2.putText(bgr, label, org, font, 0.9 * scale, c, thick, cv2.LINE_AA)
    legend = tr("overlay.legend")
    org = (int(16 * scale), int(36 * scale))
    cv2.putText(bgr, legend, org, font, 0.75 * scale, (0, 0, 0), thick + 3, cv2.LINE_AA)
    cv2.putText(bgr, legend, org, font, 0.75 * scale, (255, 255, 255), thick, cv2.LINE_AA)
    return bgr


def write_overlay(video: Path, kp: Keypoints, out: Path) -> int:
    """Writes the overlay video (MP4) and returns the number of frames written."""
    import cv2

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise ValueError("cannot open the video")
    fps = cap.get(cv2.CAP_PROP_FPS) or kp.fps or 60.0
    writer = None
    n = 0
    try:
        while n < kp.t.size:
            ok, bgr = cap.read()
            if not ok:
                break
            if writer is None:
                hh, ww = bgr.shape[:2]
                writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"mp4v"), fps, (ww, hh))
            writer.write(draw_frame(bgr, kp, n))
            n += 1
    finally:
        cap.release()
        if writer is not None:
            writer.release()
    return n
