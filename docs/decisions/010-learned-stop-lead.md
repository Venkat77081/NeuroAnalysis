# 010 — Learned stop lead for exact take durations

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M2

## Context

After decision 009 (stop on recorded media time), every take on the first device was **+104 or
+121 ms** long: 6–7 frames at 16.875 ms. CameraX's `recordedDurationNanos` lags what ends up in the
file because the encoder still writes the frames in its pipeline after `stop()`. The lag depends on
the device (encoder, resolution, frame rate).

## Decision

- Call `stop()` when the recorded media time reaches `durationS − stopLead`.
- `stopLead` starts at **110 ms** and is learned per device: after every complete take,
  `stopLead += 0.7 × measured duration error`, clamped to 0–400 ms, persisted in app preferences.
- Each take records the lead it used (`stopLeadMs` in the result / `capture.json`).
- The native safety timer (durationS + 1 s) is unchanged. Nothing depends on JavaScript.

## Consequences

The first take on a new device may miss ±50 ms; it converges within 1–3 takes. The value also
gives a per-device record of encoder latency.
