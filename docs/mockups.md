# UI mockups

Agreed mockups (design canvas, clickable in Play mode):
https://claude.ai/artifact/QYZxafDLLUSV47nhC5a9VH

| #   | Screen                        | Notes                                                                                          |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Session home                  | Patient ref (no name), medication state, consent, device tier, 7-test plan                     |
| 2   | Test instructions             | Demo video, Listen (TTS), steps, camera setup, setup checklist                                 |
| 3   | Live framing check            | Hand outline + safe-zone corner brackets, single prompt, check chips, Record gate              |
| 4   | Recording                     | REC timer, fps/drops, time left of the fixed duration, alerts (warning / critical)             |
| 5   | Quality review                | Timeline with movement window and alerts, verdict + reasons, metrics; Retake / Keep this take… |
| 5b  | Keep this take                | Failure reasons repeated, reason required, "Keep and flag for review"                          |
| 6   | Gait framing (SAW, landscape) | Side view, start zone, walkway band, floor marks                                               |
| 7   | Session summary               | Passed / Kept · flagged / Skipped, upload status                                               |

Decisions from the mockup review are recorded in `DEV_PLAN.md` ("Changes from v3") and `docs/decisions/002-fixed-duration-takes.md`, `003-readiness-not-shown-to-operators.md`.

## Platform mockups (15 Nov 2026)

Canvas: https://claude.ai/artifact/1G8hAap1unUqHbomhA1XA1

- **v1 · First mockups:** app role chooser, patient sign-in and home, operator sign-in;
  platform admin; hospital team, devices and patients; doctor patient history and recording
  review.
- **v2 · Hospital-owned data (agreed):** data-flow diagram, onboarding data connections,
  invite patients from hospital records, patient invite acceptance with a PIN, doctor live
  history. All suggestions accepted (decision 023, docs/PLATFORM_PLAN.md).

## v3 mockups (15 Nov 2026)

Page "v3 · Appointments and consent per recording" on the platform canvas
(https://claude.ai/artifact/1G8hAap1unUqHbomhA1XA1): the journey, joining with a PIN (no
consent), my hospitals, a hospital's requests and history, consent before the camera, withdrawn,
reception appointments, the doctor's "Choose tests", and the doctor's timeline. Decision 030.

## v4–v7 mockups (16 Nov 2026)

Further pages on the same platform canvas:

- **v4 · Who did what:** the activity log by person, and appointment history (decision 032).
- **v5 · Permissions per hospital:** set by the platform admin (decision 033).
- **v6 · Home or clinic recording:** appointments added by hand, and the clinic phones' queue
  (decision 034).
- **v7 · Camera check:**
  - the clinic phone set-up check;
  - the patient join check, with "Tell my hospital";
  - the Phones list with check results.

  Agreed with a 55 fps cut-off for clinic and patient phones (decision 035). The mockups show
  59, the take minimum, which is unchanged.
