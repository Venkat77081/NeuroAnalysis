# 014 — Positioning gate and guidance design

- **Status:** accepted
- **Date:** 2026-11-14
- **Milestone:** M5

## Context

DEV_PLAN §9.2–9.3 lists the checks and the rule engine; some details were left open: how to
measure subject size so portrait and landscape share thresholds, what to prompt when several
checks fail for one cause, which rules gate each test, and how to tune on real phones without
being locked out by a wrong threshold.

## Decision

- **Where:** all checks, the engine and synthetic scenarios live in `packages/quality-core`
  (pure TS). The app only decodes events and renders `GuidanceState`. Thresholds:
  `config/quality.json` (new contract `quality-config`) plus the per-test framing block.
- **Size metric:** measured against the image's **short side**, so a test can switch portrait /
  landscape (decision on orientation choice) without new thresholds. `upper_body_height` =
  4 × (shoulder midpoint − nose), about head-to-lap, independent of where the arms are.
- **One cause, one prompt:** a subject cut off on two opposite edges, or cut off while also too
  big, is prompted as "move back", not "cut off".
- **Gate rules** come from the test config: always presence, required landmarks, safe zone,
  size, brightness; plus single person, side view, face angle, face light balance, handedness
  when configured; sharpness only after the device was calibrated (Capture test); tilt and
  shake only with motion sensors (native and mock, not webcam).
- **Analysis health** (fps, delivery latency) is not a gate rule; when unhealthy, landmark checks
  become UNKNOWN so the UI shows "tracking…".
- **Engine:** 700 ms window, ≥ 3 samples, UNKNOWN when > 50 % unknown, OK→WARN above 60 % bad,
  WARN→OK below 20 %, gate after 1.0 s all-OK; prompt priority from config; each prompt spoken at
  most once per 3 s. Severities (INFO/WARN/CRITICAL with the §9.3 limits) are computed now and
  used during recording in M6. The low-fps CRITICAL limit is 29.5 fps (decision 007), not 50.
- **AE/AF/AWB** are locked when the gate opens; the countdown only locks if that did not happen.
- **Engineering "gate off"** (hidden in production builds): Record works with the gate closed and
  prompts still showing — for pilot tuning only.
- **Mock camera** plays synthetic scenarios (`?scenario=`), the same frames the unit tests use.

## Consequences

- The acceptance criteria for prompts and the gate are unit tests over every test, orientation
  and QA scenario; device QA checks the same scenarios with real people.
- Thresholds are starting values (DEV_PLAN §8.2) and will be tuned in the pilot by editing
  `config/quality.json` and the test configs only.
