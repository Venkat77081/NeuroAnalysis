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

## Open

M4 performance (≥ 20 fps, ≤ 80 ms) stays open until CPU vs GPU is measured on the phone.
Further options: fewer outputs for FA framing (blendshapes only while recording), a lower
analysis rate during framing, or one tracker per frame in turn for two-tracker tests.
