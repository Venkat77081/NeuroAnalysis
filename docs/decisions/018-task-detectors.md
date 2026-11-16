# 018 — Task detectors: signals, thresholds and synthetic fixtures

- **Status:** accepted (thresholds to be re-tuned on the recorded fixture library)
- **Date:** 2026-11-14
- **Milestone:** M6

## Decision

Detectors measure capture quality (decision 017), from the take's LandmarkFrames:

| Test | Signal (reference length = median over the take)                                | Event                                                                                                                        |
| ---- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| FT   | thumb-tip ↔ index-tip distance ÷ hand size (wrist → middle knuckle), per hand   | tap = minimum                                                                                                                |
| FR   | wrist height ÷ forearm (elbow → wrist; 2.5 hand sizes if not visible), per hand | roll = top of the wrist path                                                                                                 |
| FTF  | distance between the two index tips ÷ shoulder width                            | touch = minimum                                                                                                              |
| SAW  | hip midpoint ÷ trunk length (shoulders → hips)                                  | stand up (hip rises > 0.3 trunk), walk (horizontal speed > 0.3 trunk/s), turn (walking direction flips), walk back, sit down |
| FA   | max(brow blendshapes), mean(smile blendshapes)                                  | brow / smile peaks; complete = 2 of each, brow first                                                                         |

- Smoothing: One-Euro; Savitzky–Golay available for offline recompute. Peaks need a minimum
  prominence and spacing. All parameters: `task.detectorParams` in each test config (checked by
  nc-validate).
- **Movement** = range of the smoothed signal over a short window (not the derivative, which
  landmark noise keeps above zero). No-motion windows ≥ `noMotionTimeoutS` mean the movement
  stopped; FA allows rest once the sequence is complete.
- The reference length is the median of the take, so jitter in the reference does not create
  events.

## Fixtures

Until the recorded library exists (≥ 15 labelled takes per test, DEV_PLAN §16 M6), a synthetic
library animates the M5 synthetic bodies: normal, slow, fast, interrupted (stops halfway) and
wrong execution, 3 seeds each = 15 per test, with landmark noise. On it every §9.4 target holds
(count ±1 ≥ 90 %, MAE ≤ 0.5, precision/recall ≥ 0.9, SAW boundaries ≤ 0.3 s median) and every
"stops halfway" take is detected.

## Consequences

- On-device analysis currently runs at ~10 fps (decision 016); taps faster than ~5 per second
  cannot be counted on the phone at that rate (Nyquist). The detectors are for quality evidence;
  counts for biomarkers come from the 60 fps video on the server.
- Thresholds are starting values; re-tune on real recordings.
