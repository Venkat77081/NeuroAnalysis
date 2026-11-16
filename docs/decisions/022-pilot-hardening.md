# 022 — Pilot hardening: thermal policy, practice mode, audit, crash reports, release

- **Status:** accepted
- **Date:** 2026-11-14
- **Milestone:** M9

## Decision

- **Thermal policy** (`session.json` `thermal`).
  - The plugin reports Android's thermal status as `thermal` events, and `setAnalysisFps` slows
    tracking only.
  - _moderate_: tracking at 10 fps.
  - _severe_: tracking at 5 fps, no landmark overlay, and an amber notice.
  - _critical_ and above: a red notice, and Record stays disabled until the phone cools.
  - The recording frame rate is never changed. Biomarkers come from the 60 fps video on the
    server, so slower tracking affects only guidance and the capture check.
- **Practice mode.**
  - A home-screen switch starts a session without patient, medication state or consent, and a
    badge marks it.
  - Its takes are never queued for upload; ending the session deletes them with their keys.
- **Audit to the server.**
  - The session close lists every planned test's outcome with reason codes only.
  - The server writes `test_skipped` / `take_kept` audit events and outcome counts.
  - Free-text notes (skip, keep and abort "Other" notes) stay on the phone; the abort note is no
    longer sent.
- **Crash reports.**
  - JS errors and native uncaught exceptions are turned into redacted reports: error type, a
    redacted message, file:line frames without URLs or paths, and the session screen.
  - They are queued in the persistent upload queue and sent once an operator is signed in, to
    `POST /diagnostics`. The server bounds them and keeps known fields only, as audit events.
  - Admins can read them with `GET /diagnostics`. At most 5 reports are sent per app run.
- **Accessibility.** An e2e audit holds every operator control to at least 48 × 48 px with an
  accessible name, and spoken instructions are available on each test intro.
- **Release.** A manual GitHub workflow makes signed builds; the details are in `docs/release.md`.
  - The signing key comes from secrets, and the release build is not debuggable, so the server
    must be https.
  - The build hides the engineering tools (`VITE_PRODUCTION=1`).
  - Output: an AAB for Play internal/closed testing and an APK for Firebase App Distribution.

## Consequences

- The pilot needs the owner to create the keystore, Firebase project and Play listing.
- The M9 acceptance criteria (15-minute dry run, 20 sessions without a crash, 30-minute session
  per Tier A phone) are phone tests (`docs/qa/m9-device-tests.md`).
