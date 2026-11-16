# M9 pilot hardening: phone tests

Use a **release** build from the Release (pilot) workflow (docs/release.md) where possible, so
the engineering tools are hidden as they will be in the pilot. Report Pass / Fail / Not tested,
with the measured value where asked.

## Acceptance (DEV_PLAN M9)

| #   | What                                                                          | Expected / measure                                                          |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P1  | Full dry-run session, all 5 tests, a trained operator, a volunteer            | **≤ 15 min** from "Start session" to "End session". Report the minutes      |
| P2  | 20 sessions in a row (any mix, include retakes, a skip, a keep, an early end) | **No crash**, no freeze. Report the count reached                           |
| P3  | 30-minute session on each Tier A phone (repeat tests to fill 30 min)          | Every take still ≥ 59 fps; M2 and M4 criteria hold. Note the thermal status |

## New behaviour to check

| #    | What to do                                              | Expected                                                                                      |
| ---- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| T1   | Run takes until the phone is warm (or in the sun)       | "The phone is warm: tracking is slowed…"; landmark overlay disappears; recording still 60 fps |
| T2   | Keep going until it is hot                              | "The phone is too hot. Let it cool…"; Record disabled until it cools                          |
| R1   | Home → tick "Practice session" → Start practice         | No patient needed; orange "Practice" badge on the camera screen                               |
| R2   | Finish the practice session                             | Summary says the takes are deleted and never uploaded; "End session" removes them             |
| A1   | Every button on the operator screens                    | Easy to tap with a thumb (≥ 48 px); Listen reads each test's instructions aloud               |
| A2   | Use the app in bright light at a clinic                 | Text and chips readable; report anything hard to read                                         |
| C1 🖥 | After a crash or freeze (if one happens), sign in again | Admin sees it in GET /diagnostics: error type and screen only, no patient data                |
| C2 🖥 | Finish a session with one skip and one keep             | Server audit has test_skipped / take_kept with reason codes (no notes)                        |

🖥 = needs a server (on hold).
