# Pre-pilot test plan

Run this before the pilot release. It replaces the round 2 and M9 sheets (it includes both).
For each row, report **Pass / Fail / Not tested**, plus a short note or a screenshot when it fails.

- **Phones:** every phone planned for the pilot (Tier A). Note the model and Android version.
- **People:** one trained operator and one volunteer playing the patient. A second operator for
  section K.
- **Build:**
  - Sections A–H: the latest debug APK from CI is fine.
  - Sections J–K: use a **release** build (Release (pilot) workflow, see `docs/release.md`).
  - Uninstall the old app first.
- **Server (🖥 rows):** needs a running https server. Skip those rows while the server is on hold.

---

## A. Install and home screen

| #   | What to do                                                          | Expected                                                  |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| A1  | Install, open, allow the camera                                     | Home screen "New session"; no crash                       |
| A2  | Choose patient → New patient → reference, year of birth, sex → Save | Reference shown masked (••••1234)                         |
| A3  | Set medication ON/OFF/NA, tick consent                              | Start session becomes enabled only when all three are set |
| A4  | Language → Hindi (operator menu)                                    | All screens in Hindi; switch back to English              |

## B. Framing (do for each test: FT, FTF, FR, SAW, FA)

| #   | What to do                                                         | Expected                                                                               |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| B1  | Open the test → Set up camera                                      | FT, FTF, FR, FA open in **portrait**; SAW in **landscape**                             |
| B2  | Tap "⟲ Landscape/Portrait" (not on SAW); leave and reopen the test | Switches; the choice is remembered for that test                                       |
| B3  | Phone on the stand, level it                                       | Level dial green (≤ 5° roll, ≤ 10° pitch)                                              |
| B4  | Patient positioned correctly                                       | All chips green (In frame, Distance, Light, Level, Steady); Record enabled within ~1 s |
| B5  | Too close, too far, partly out of frame, dim light, tilt the phone | One clear prompt at a time; Record disabled until fixed                                |
| B6  | Landmarks switch on during framing and recording                   | Points sit on hands, body or face, in both orientations                                |
| B7  | Listen on the intro screen                                         | Instructions are read aloud (English and Hindi)                                        |

## C. Recording and verdict (each test)

| #   | What to do                                                                     | Expected                                                                                     |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| C1  | Normal take                                                                    | "Capture passed"; timeline shows the movement band and tick marks; replay plays the video    |
| C2  | Stop moving halfway (SAW: stand still after one turn)                          | Retake: "Movement stopped for … s"                                                           |
| C3  | Do it wrong (one hand only / never touch / no roll / stay seated / only smile) | Retake: "The task was not carried out as instructed"                                         |
| C4  | Walk out of frame for > 2 s while recording                                    | Red banner + vibration during the take; Retake                                               |
| C5  | FA: cover the mouth with a hand for half the take                              | Retake: "Key body points … were hidden too often"                                            |
| C6  | Press Stop early                                                               | Retake: "Stopped early at … s"                                                               |
| C7  | "Keep this take…" → reason → Keep                                              | Summary: "Kept · flagged"                                                                    |
| C8  | Skip a test with a reason; "Other" needs a note                                | Summary: Skipped + reason                                                                    |
| C9  | Back to a previous test and redo it                                            | Earlier result kept until the new take is accepted                                           |
| C10 | Time from the end of a take to the Review screen                               | Under ~2 s. **Report seconds per test**                                                      |
| C11 | Fast, normal tapping (FT) and fast rolling (FR) by a healthy volunteer         | Should pass. If it says "Movement stopped" or "not carried out", report it (detector tuning) |

## D. Interruptions and storage

| #   | What to do                                                           | Expected                                                      |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| D1  | Press Home during a take, come back                                  | Back at framing: "The app left the screen … Record it again"  |
| D2  | Answer a phone call during a take                                    | Same as D1                                                    |
| D3  | Kill the app from recent apps during a take, reopen                  | Session resumes at that test: "The last take was interrupted" |
| D4  | Fill the phone to < 2 GB free, open framing                          | Red "Storage almost full …"; Record disabled                  |
| D5  | End a session early (End session → reason)                           | Summary: "Session ended early …"; remaining tests "Not done"  |
| D6  | Turn the phone off and on in the middle of a session, reopen the app | Session restored where it was                                 |

## E. Heat (thermal policy)

| #   | What to do                                           | Expected                                                                                |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| E1  | Run takes until the phone gets warm (or in sunlight) | Amber "The phone is warm: tracking is slowed …"; overlay hidden; recording still 60 fps |
| E2  | Keep going until it is hot                           | Red "The phone is too hot …"; Record disabled until it cools                            |
| E3  | Let it cool                                          | Notice disappears; Record works again                                                   |

## F. Practice mode

| #   | What to do                                      | Expected                                                                  |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| F1  | Home → tick "Practice session" → Start practice | No patient needed; orange "Practice" badge on the camera screen           |
| F2  | Record, then end the practice session           | Summary: takes are deleted and never uploaded; next session starts normal |

## G. Summary and uploads

| #    | What to do                                                                        | Expected                                                           |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| G1   | Finish a session without server registration                                      | "This phone is not registered with a server …" + "Set up uploads"  |
| G2 🖥 | Operator chip → server address + enrollment code → Register; sign in (code + PIN) | "Registered with site …"; "Signed in as …"                         |
| G3 🖥 | Run a full session                                                                | Each passed or kept test: "Uploading n%" → "Uploaded"              |
| G4 🖥 | Flight mode in the middle of an upload, then off                                  | "Will retry · No connection" → continues (not from 0) → "Uploaded" |
| G5 🖥 | Wi-Fi only on, phone on mobile data                                               | "Paused · Waiting for Wi-Fi"; starts on Wi-Fi                      |
| G6 🖥 | Reboot with uploads queued, don't open the app                                    | Uploads finish in the background                                   |
| G7 🖥 | Wrong PIN; wrong enrollment code                                                  | Clear error message; nothing crashes                               |

## H. Server checks (reviewer / admin) 🖥

| #   | What to do                                             | Expected                                                                                         |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| H1  | Reviewer: `GET /sessions/{id}/readiness`               | Every test lists all its biomarkers (FT 12, FTF 18, FR 12, SAW 15, FA 18) with status and reason |
| H2  | Operator tries the same call                           | 403 (operators never see readiness)                                                              |
| H3  | Session with one skip and one keep                     | Audit has test_skipped / take_kept with reason codes, no notes                                   |
| H4  | After any crash: admin `GET /diagnostics`              | Error type and screen only; no names, references or file paths                                   |
| H5  | Export 50 takes and run `pnpm replay <folder> --check` | **50 takes: 50 match**                                                                           |

## J. Release build

| #    | What to do                                                                | Expected                                                                              |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| J1   | Install the release APK (Firebase invite) or from the Play internal track | Installs over nothing; opens normally                                                 |
| J2   | Long press on the logo                                                    | Settings only (operator, language, fps limit); no device check or engineering options |
| J3 🖥 | Enter an http:// server address                                           | Rejected; only https works                                                            |

## K. Pilot acceptance (DEV_PLAN M9)

| #   | What                                                                                    | Measure                                                                       |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| K1  | Full 5-test session with a trained operator                                             | **≤ 15 min** from Start session to End session. Report minutes for 3 sessions |
| K2  | 20 sessions in a row (mix in retakes, a skip, a keep, an early end, a practice session) | **No crash or freeze.** Report the count reached                              |
| K3  | 30-minute session on each Tier A phone (repeat tests to fill 30 min)                    | Every take ≥ 59 fps; note the highest heat level reached                      |
| K4  | Two operators, same volunteer, two different days                                       | Same tests pass; report anything inconsistent                                 |

---

## Report template

Copy, fill in, and send back with screenshots of every failure.

```
Phone: (model, Android version)        Build: (debug/release, CI run number)
Operator(s):                            Date:

A1–A4:   Pass / Fail / Not tested — notes
B1–B7:   per test (FT / FTF / FR / SAW / FA) — Pass / Fail — notes
C1–C11:  per test — Pass / Fail — notes        C10 seconds: FT _ FTF _ FR _ SAW _ FA _
D1–D6:   Pass / Fail / Not tested — notes
E1–E3:   Pass / Fail / Not tested — highest heat level reached:
F1–F2:   Pass / Fail / Not tested — notes
G1–G7:   Pass / Fail / Not tested — notes
H1–H5:   Pass / Fail / Not tested — notes
J1–J3:   Pass / Fail / Not tested — notes
K1: minutes per session: _ / _ / _
K2: sessions without a crash: _ / 20
K3: lowest take fps in 30 min: _      K4: notes
Anything else (crashes, freezes, wrong text, overlay offsets, hard to read):
```
