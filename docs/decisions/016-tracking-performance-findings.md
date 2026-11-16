# 016 — Tracking performance on the first phone; analysis-health limits; delegate choice

- **Status:** accepted (limits), open (performance work)
- **Date:** 2026-11-14

## Findings (OnePlus CPH2649, Android 17, recording 1080p60, Tracking test M4)

| Test | Trackers    | Analysis fps | Latency p95 | Processing p95 | Event  | Take (M2)   | Delegate |
| ---- | ----------- | ------------ | ----------- | -------------- | ------ | ----------- | -------- |
| FA   | face        | 12.7         | 206 ms      | 123 ms         | 8.2 KB | ✓ 59.95 fps | GPU      |
| FTF  | pose + hand | 13.7         | 189 ms      | 109 ms         | 2.0 KB | ✓ 59.94 fps | GPU      |
| FT   | hand + pose | 13.2         | 197 ms      | 117 ms         | 2.0 KB | ✓ 59.94 fps | GPU      |

Quality evaluation in the WebView: p95 0.3–0.7 ms (M5 limit 5 ms ✓). Recording is unaffected by
tracking (all takes ≈ 59.9 fps). The M4 targets (≥ 20 fps, ≤ 80 ms) are **not met**; the
§9.2 analysis-health limits (≥ 15 fps, ≤ 150 ms) put every landmark check in UNKNOWN, so the
gate never opened ("Tracking…").

## Decision

- `analysis_health` limits in `config/quality.json`: **≥ 10 fps, ≤ 250 ms** (QUALITY@1.2.0).
  Positioning needs current landmarks, not high-rate ones; 12–15 fps is enough for framing.
  The latency input is the native processing time (one clock).
- Tracker delegate is selectable per device (Tracking test → "Tracker": Auto / GPU / CPU,
  stored on the device and used by sessions) to measure whether CPU (XNNPACK) is faster than the
  GPU, which also drives the 60 fps preview and the video encoder.
- Removed a 1.6 MB per-frame allocation on the analysis thread.

## Second run (FT, hand + pose)

| Delegate | Analysis fps | Latency p95 | Processing p95 | Dropped tracker results |
| -------- | ------------ | ----------- | -------------- | ----------------------- |
| GPU      | 10.3         | 184 ms      | 107 ms         | 0                       |
| CPU      | 20.8         | 423 ms      | 355 ms         | 149 of 328 frames       |

CPU keeps up with the rate but MediaPipe queues frames (latency grows, busy trackers drop).
Changes: at most **one frame in flight** (frames are skipped while the trackers are busy, so
latency ≈ inference time and no tracker drops a frame); a **mixed** delegate (pose on CPU, hands
and face on GPU, in parallel); the face light grid is one native scale instead of 3600
`getPixel` calls; events carry `prepMs` (work before MediaPipe) and the Tracking test shows it
with the analysis image size.

## Third run (FT, one frame in flight)

| Delegate | fps  | Latency p95 | Processing p95 | Preparation p95 | Dropped |
| -------- | ---- | ----------- | -------------- | --------------- | ------- |
| GPU      | 10.0 | 165 ms      | 94 ms          | 58 ms           | 0       |
| CPU      | 6.4  | 252 ms      | 183 ms         | 75 ms           | 0       |
| Mixed    | 7.4  | 252 ms      | 176 ms         | 71 ms           | 0       |

Queueing and dropped results are gone, GPU is the best delegate, and **more than half of the
per-frame time is our own preparation** (per-pixel `ByteBuffer.get` for the brightness and
sharpness statistics). Fix: one bulk copy of the frame into a reused array; statistics and the
bitmap use the copy. The overlay draws only pose points with visibility ≥ the required-landmark
limit (a pose model "finds" a body in a close-up hand).

**User instruction (14 Nov 2026):** if the benchmark cannot be resolved now, skip the remaining
device tests and continue the build. The M4 performance criteria (≥ 20 fps, ≤ 80 ms) and the
device tier stay **open**; they are re-measured with the next APK, and the M5 gate works at the
current rate (analysis-health limits ≥ 10 fps, ≤ 250 ms).

## Positioning made easier (user feedback, 14 Nov 2026)

Session at 7 fps / 177 ms: "In frame" and "Distance" stayed at "…" because analysis health
(≥ 10 fps) turned every landmark check UNKNOWN; levelling was hard with only "Level the phone".

- Analysis health now only catches a stalled tracker: **≥ 3 fps, ≤ 600 ms** (QUALITY@1.4.0).
  Framing needs fresh landmarks, not fast ones.
- Tilt: roll ±5° (keeps the frame straight), **pitch ±10°** (a phone on a stand is usually aimed
  slightly at the patient).
- Tilt prompts say which way: turn clockwise / anticlockwise, point the camera up / down.
- A live spirit level on the camera screen (bar = roll, dot = pitch, green when within limits).

## Open

M4 performance (≥ 20 fps, ≤ 80 ms) stays open until CPU vs GPU is measured on the phone.
Further options: fewer outputs for FA framing (blendshapes only while recording), a lower
analysis rate during framing, or one tracker per frame in turn for two-tracker tests.
