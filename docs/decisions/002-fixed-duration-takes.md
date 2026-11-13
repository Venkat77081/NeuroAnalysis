# 002 — Fixed-duration takes

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M0 (affects M2, M3, M6, M7)

## Context
v3 stopped each take after a target number of reps (e.g. 10 taps). In the mockup review the team decided each video is recorded for a fixed time.

## Decision
- 15 s for FT, FR, FTF, FA; 30 s for SAW (`task.durationS` in each test config).
- The **native** timer stops recording, so a frozen WebView cannot lengthen or shorten a take.
- Detectors produce events, the movement window and SAW phases; they never stop recording.
- PASS requires the full duration (± `verdict.durationToleranceS`) and movement present.

## Consequences
- Removed `targetReps`, `autoStopAfterTargetS`, `minReps` from the config schema.
- `startRecording` takes `durationS`; `recordingState` emits `completed` when the timer stops.
