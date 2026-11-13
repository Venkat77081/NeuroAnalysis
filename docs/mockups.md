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
