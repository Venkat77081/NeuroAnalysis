# 015 — 60 fps for every test; below 59 fps fails; doctor can change the limit

- **Status:** accepted (user, 14 Nov 2026). Supersedes decision 007 (interim 30 fps floor).
- **Date:** 2026-11-14

## Context

The DNE protocol records at 60 fps (decision 013). On the first phone the real camera rate at
"60 fps" is 59.2–59.3 fps (decision 009), so a limit of exactly 60 would fail every take.

## Decision

- Every test targets **60 fps**; there is **no 30 fps fallback** (`fallbackFps` removed).
- A take whose effective frame rate is **below 59 fps** gets RETAKE (`minEffectiveFps: 59`);
  during recording, below 59 fps for more than 1 s is CRITICAL (`quality.json`).
- A doctor can choose another limit in the settings sheet (long-press the logo → "Fail a take
  below (frame rate)"), from `session.json → minFpsOptions`. The limit used is written to each
  take's `meta.json` (`camera.minEffectiveFps`).
- All tests now need a Tier A (60 fps) phone (`minTier: "A"`).

## Consequences

- Phones that cannot record 60 fps cannot run any test (they would have used 30 fps before).
- Lowering the limit in settings changes only the verdict; the camera still asks for 60 fps.
