# 009 — Fixes from the first M2 device run (OnePlus CPH2649, Android 17)

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M2

## Findings (≈ 25 takes, FT, 15 s, 60 fps)

- Every take ran at **59.26 fps** with no gaps: the camera's real frame period at "60" is 16.875 ms.
  The old "dropped" figure (1.22 %) compared against an ideal 60.000 fps, so it was not real loss.
  This also explains the M1 benchmark falling to Tier B.
- Duration was always short (−14 to −82 ms): the stop timer started at CameraX's Start event, a
  few frames before the first encoded frame.
- Some takes had one MP4 frame missing from the frame log (884 vs 883); with a single fixed offset
  every later sample was 17 ms off.
- Force-stopping via Settings first puts the app in the background, which (correctly) stops and
  encrypts the take — so there was nothing to recover. Results lived only in screen memory.

## Decisions

- **Dropped frames = real losses:** gaps in the capture timeline longer than 1.5 × the median frame
  period, plus captured frames missing from the MP4. Effective fps is reported separately.
- **Stop on recorded media time:** the take stops when CameraX's `recordedDurationNanos` reaches
  durationS − ½ frame; a native safety timer ends it at durationS + 1 s. No JavaScript involved.
- **Nearest-time matching:** the first MP4 sample is anchored at record k; every sample is matched
  to the nearest logged frame; samples with no frame within half a period are counted
  (`unmatchedSamples`). Acceptance: matched Δt ≤ 2 ms and ≤ 1 unmatched sample.
- **Stats over the video span:** frames before/after the encoded video are excluded (also in the
  benchmark).
- **Results persist:** each take's result is saved encrypted as `capture.json`; `listTakes()` lists
  stored takes after restarts.
- **Crash test from the phone:** engineering switch "Kill the app 5 s into the next take"
  (`debugArmCrash`, native timer → `Process.killProcess`).
