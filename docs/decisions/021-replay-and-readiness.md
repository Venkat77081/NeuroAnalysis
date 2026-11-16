# 021 — Replay parity and biomarker readiness

- **Status:** accepted
- **Date:** 2026-11-14
- **Milestone:** M8

## Decision

- **The phone's verdict is computed from the take's own recorded files.**
  - When a take ends, the app reads back `landmarks.bin` and `sensors.bin` (`readLandmarks`,
    `readSensors`).
  - It runs quality-core's `evaluateRecordedTake` on them. This is the live path replayed: rule
    checks → guidance engine → event log → detector → take analysis → readiness → verdict.
  - `tools/replay` runs the same function on the same files, so parity holds by construction.
  - `quality.json` gains `replayInputs`: the source, the SHA-256 of both files, the frame-rate
    limit, the sensor flag, orientation and `firstSampleNs`. Replay can therefore prove it used
    the phone's exact inputs.
  - If the files cannot be read on the phone, the frames collected live are used, and the
    source is recorded as `live`.
- **Analysis latency is not stored**, so analysis health uses frame rate only (latency 0) in
  this evaluation. Live latency still drives the on-screen "Tracking…" state.
- **Readiness.** `config/biomarker-registry.json` (REG@0.1.0) lists the 75 DNE biomarker IDs.
  - Formulas stay null until the client sends Table A-II.
  - Each entry lists what that biomarker needs:
    - frame rate ≥ 58 fps;
    - duration (the full take);
    - trackers;
    - key landmarks: reference lengths and the moving parts;
    - visibility (90 %; 80 % for SAW);
    - for SAW, the four phases.
  - `readinessHint` gives each biomarker a status — COMPUTABLE, PARTIAL (key points visible in
    at least half of the needed frames) or NOT_COMPUTABLE — with a reason, the missing inputs,
    and whether a retake can fix it.
  - Retake-fixable failures become **plain** RETAKE reasons and never name a biomarker:
    `duration_short`, the new `key_points_hidden`, or `protocol_incomplete`.
  - Frame rate is the exception: it stays with the doctor's limit (decision 015), and the hint
    still records it.
- **The server is authoritative.** `backend/analysis` is a Python port of the readiness code.
  - With the private key, it decrypts `landmarks.bin` (Tink streaming AEAD; data key unwrapped
    with RSA-OAEP) and recomputes landmark visibility.
  - The movement window and phases come from `quality.json`. The detectors run on the phone and
    in replay.
  - Without the key (production keys live in the KMS), it reports the phone's hint, marked
    `device_hint`.
  - The TypeScript and Python versions are checked against the same golden files
    (`contracts/tests/readiness/`) in both test suites.
- **Reports are for reviewers and admins only.**
  - `GET/POST /takes/{id}/readiness` and `GET /sessions/{id}/readiness` list every registered
    biomarker of the test, with status, reason, missing inputs and the quality rules to check.
  - Results are stored in `biomarker_runs`. Operators get 403.

## Consequences

- Two implementations of readiness (TypeScript, Python), kept equal by the golden files.
  Regenerate with `UPDATE_GOLDEN=1 pnpm --filter @neurocapture/replay test` after an intended
  change.
- `capture.json` is not uploaded, so replay of an exported server take uses `quality.json`
  values rounded to 3 decimals. A frame rate exactly at a limit could flip the result. Replays
  of phone takes (adb pull) use `capture.json`.
- The 50-take parity acceptance runs on mock-recorded takes in CI. The same check on 50 real
  phone takes needs the recorded library (`docs/qa/m8-device-tests.md`).
