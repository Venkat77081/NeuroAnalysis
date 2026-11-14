"""Biomarker readiness on the server (DEV_PLAN §10, M8). Authoritative; never shown to operators.

A Python port of packages/quality-core/src/verdict/readiness.ts. Both implementations are checked
against the same golden files (contracts/tests/readiness/), so a change to one without the other
fails CI. The server recomputes landmark visibility from the decrypted landmarks.bin; the movement
window and detected phases come from the take's quality.json (the detectors run on the phone and
in tools/replay).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from analysis.nclm import Frame

RETAKE_FIXABLE = ("fps", "duration", "landmarks", "phases")

#: Quality rules whose evidence explains a missing input (mapping back to the capture checks).
QUALITY_RULES_FOR: dict[str, list[str]] = {
    "fps": ["frame_drops", "analysis_health"],
    "duration": ["duration"],
    "tracker": [],
    "landmarks": ["required_landmarks_visible", "in_safe_zone", "subject_present"],
    "phases": ["saw_phases"],
    "sensors": ["tilt", "shake"],
}

#: quality.json phase names → detector event kinds used by the registry.
PHASE_EVENTS = {"standing": "stand_up", "seated_end": "sit_down"}

_WORSE = {"COMPUTABLE": 0, "PARTIAL": 1, "NOT_COMPUTABLE": 2}


def _r1(n: float) -> float:
    """Math.round(n * 10) / 10 (JavaScript rounds .5 up; Python's round() does not)."""
    return math.floor(n * 10 + 0.5) / 10


def _num(n: float) -> str:
    """Number formatted like JavaScript's String(n) for the values used in reasons."""
    if float(n).is_integer():
        return str(int(n))
    return repr(float(n))


@dataclass
class Evidence:
    effective_fps: float
    duration_s: float
    trackers: list[str]
    frames: list[Frame]
    #: Canonical time of video sample 0; frame times are measured from it.
    start_ns: int
    #: (tStartS, tEndS) in video seconds, or None for the whole take.
    movement_window: tuple[float, float] | None
    phases: list[str]
    sensors: bool
    hands_needed: int
    pose_min_visibility: float
    hand_min_score: float
    _vis_cache: dict = field(default_factory=dict, repr=False)


def _in_image(p) -> bool:
    return p is not None and 0 <= p.x <= 1 and 0 <= p.y <= 1


def landmark_visible_frac(frames: list[Frame], landmarks: dict[str, list[int]], ev: Evidence) -> float:
    w = ev.movement_window
    in_window = [f for f in frames if w is None or w[0] <= (f.t_ns - ev.start_ns) / 1e9 <= w[1]]
    if not in_window:
        return 0.0
    ok = 0
    for f in in_window:
        visible = True
        pose_idx = landmarks.get("pose") or []
        if pose_idx:
            visible = visible and all(
                f.pose is not None
                and i < len(f.pose)
                and (f.pose[i].v or 0) >= ev.pose_min_visibility
                and _in_image(f.pose[i])
                for i in pose_idx
            )
        hand_idx = landmarks.get("hand") or []
        if hand_idx:
            good = sum(
                1
                for h in f.hands
                if h.score >= ev.hand_min_score
                and all(i < len(h.pts) and _in_image(h.pts[i]) for i in hand_idx)
            )
            visible = visible and good >= ev.hands_needed
        face_idx = landmarks.get("face") or []
        if face_idx:
            visible = (
                visible
                and f.face is not None
                and all(i < len(f.face) and _in_image(f.face[i]) for i in face_idx)
            )
        if visible:
            ok += 1
    return ok / len(in_window)


def readiness_hint(registry: dict, test_code: str, ev: Evidence) -> dict:
    """{registryVersion, items: {id: {status, reason?, retakeFixable?, missing?}}}."""
    items: dict[str, dict] = {}
    for b in (x for x in registry["biomarkers"] if x["testCode"] == test_code):
        inp = b["inputs"]
        #: (status, missing input, reason) for each unmet requirement, in check order
        fails: list[tuple[str, str, str]] = []
        if "minEffectiveFps" in inp and ev.effective_fps < inp["minEffectiveFps"]:
            need_fps, got_fps = _num(inp["minEffectiveFps"]), _num(_r1(ev.effective_fps))
            fails.append(("NOT_COMPUTABLE", "fps", f"requires >= {need_fps} fps; effective {got_fps} fps"))
        if "minDurationS" in inp and ev.duration_s < inp["minDurationS"]:
            need_s, got_s = _num(inp["minDurationS"]), _num(_r1(ev.duration_s))
            fails.append(("NOT_COMPUTABLE", "duration", f"requires >= {need_s} s; recorded {got_s} s"))
        absent = [t for t in inp.get("trackers", []) if t not in ev.trackers]
        if absent:
            fails.append(("NOT_COMPUTABLE", "tracker", f"not recorded: {', '.join(absent)}"))
        elif inp.get("landmarks"):
            key = repr(sorted(inp["landmarks"].items()))
            if key not in ev._vis_cache:
                ev._vis_cache[key] = landmark_visible_frac(ev.frames, inp["landmarks"], ev)
            frac = ev._vis_cache[key]
            need = inp.get("minLandmarkVisibleFrac", 0.9)
            if frac < need:
                pct, need_pct = _num(_r1(frac * 100)), _num(_r1(need * 100))
                fails.append(
                    (
                        "PARTIAL" if frac >= need / 2 else "NOT_COMPUTABLE",
                        "landmarks",
                        f"required landmarks visible in {pct}% of frames; needs {need_pct}%",
                    )
                )
        phases_missing = [p for p in inp.get("requiresPhases", []) if p not in ev.phases]
        if phases_missing:
            fails.append(("NOT_COMPUTABLE", "phases", f"phases not detected: {', '.join(phases_missing)}"))
        if inp.get("requiresSensors") and not ev.sensors:
            fails.append(("NOT_COMPUTABLE", "sensors", "no sensor data"))
        status = max((f[0] for f in fails), key=_WORSE.__getitem__, default="COMPUTABLE")
        missing = [f[1] for f in fails]
        reasons = [f[2] for f in fails]
        if status == "COMPUTABLE":
            items[b["id"]] = {"status": status}
        else:
            items[b["id"]] = {
                "status": status,
                "reason": "; ".join(reasons),
                "retakeFixable": all(m in RETAKE_FIXABLE for m in missing),
                "missing": missing,
            }
    return {"registryVersion": registry["registryVersion"], "items": items}


def evidence_from_take(
    quality: dict,
    test_config: dict,
    quality_config: dict,
    frames: list[Frame] | None,
    sensors_present: bool,
) -> Evidence:
    """Evidence for a stored take: its quality.json plus decrypted landmarks (None = not available)."""
    inputs = quality.get("replayInputs") or {}
    first = inputs.get("firstSampleNs")
    frames = frames or []
    start_ns = int(first) if first else (frames[0].t_ns if frames else 0)
    mw = quality.get("movementWindow")
    phases = [PHASE_EVENTS.get(p, p) for p in quality.get("phasesDetected") or []]
    req = quality_config["checks"]["required_landmarks_visible"]
    return Evidence(
        effective_fps=quality["fpsEffective"],
        duration_s=quality["durationS"],
        trackers=list(test_config["trackers"]),
        frames=frames,
        start_ns=start_ns,
        movement_window=(mw["tStartS"], mw["tEndS"]) if mw else None,
        phases=phases,
        sensors=bool(inputs.get("hasSensors")) and sensors_present,
        hands_needed=2 if test_config["framing"].get("bothHandsRequired") else 1,
        pose_min_visibility=req["poseMinVisibility"],
        hand_min_score=req["handMinScore"],
    )


def report_rows(hint: dict) -> list[dict]:
    """Reviewer report rows: every biomarker with status, reason and the quality rules to check."""
    rows = []
    for bid, item in hint["items"].items():
        missing = item.get("missing", [])
        rows.append(
            {
                "id": bid,
                "status": item["status"],
                "reason": item.get("reason"),
                "retakeFixable": item.get("retakeFixable"),
                "missing": missing,
                "qualityRules": sorted({r for m in missing for r in QUALITY_RULES_FOR[m]}),
            }
        )
    return rows
