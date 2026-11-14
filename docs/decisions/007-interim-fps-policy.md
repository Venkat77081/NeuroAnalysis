# 007 — Interim frame-rate policy (until the client confirms 60 fps)

- **Status:** accepted (interim)
- **Date:** 2026-11-13
- **Milestone:** M2 (affects M5–M7)

## Context

DEV_PLAN requires ≥ 58 effective fps and < 1 % dropped frames for FT, FTF and FR. The product owner
asked not to cut any test unless the frame rate drops below 30, until the client confirms 60 fps is
required.

## Decision (configs v1.1.0)

- FT, FTF, FR still **request 60 fps** (`targetFps: 60`) and **fall back to 30 fps** when the phone
  cannot record 60 fps at the configured resolution (`fallbackFps: 30`). SAW and FA record at 30 fps.
- **RETAKE only below 29.5 fps** effective (`minEffectiveFps: 29.5`, all tests). 29.5 rather than 30
  because a correct 30 fps recording measures ≈ 29.8 fps (first device).
- **Dropped frames are measured and logged but not enforced** (`verdict.maxDroppedFrac: null`).
- The actual recording fps is saved with every take (`meta.json`, `quality.json`), so 60 fps and
  30 fps takes can be told apart later.

## Revert when the client confirms 60 fps

Set FT/FTF/FR `minEffectiveFps: 58`, remove `fallbackFps`, set `maxDroppedFrac: 0.01`, bump the
config versions. No code change needed.

## Risk

FT/FR/FTF temporal biomarkers (tap rate, rhythm) are less precise at 30 fps; takes recorded under this
policy are identifiable by their recorded fps.
