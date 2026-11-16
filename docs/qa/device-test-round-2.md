# Phone test round 2 (everything since the level indicator)

Install the debug APK from the latest CI run on branch `claude/m8-replay-readiness` (plugin 0.9.0).
Uninstall the old app first, so no old settings or remembered orientations are carried over.

For every row, report **Pass / Fail / Not tested**, plus a screenshot or a note when it fails.
Rows marked 🖥 need a server, and the server is on hold: skip them for now.

## A. Setup and framing

| #   | What to do                                                       | Expected                                                                                   |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A1  | Start a session, open FT, FTF, FR, FA                            | Camera opens in **portrait** with the guide filling the screen; SAW opens in **landscape** |
| A2  | Tap "⟲ Landscape" on FT, go back, reopen FT                      | Switches to landscape; the choice is remembered for FT on this phone                       |
| A3  | Set the phone on the stand and level it                          | Level dial turns green at ≤ 5° roll / ≤ 10° pitch; "Level" chip ticks                      |
| A4  | Patient in position for each test                                | All chips green (In frame, Distance, Light, Level, Steady), Record enabled within ~1 s     |
| A5  | Move too close / too far / out of frame / dim the light          | One clear prompt at a time; Record disabled until fixed                                    |
| A6  | Switch "Landmarks" on while framing, recording and in the replay | Points sit on the hands, body or face in both orientations                                 |

## B. Recording and verdict (M6–M8)

| #   | What to do                                                                         | Expected                                                                                      |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| B1  | Normal take for each of the 5 tests                                                | "Capture passed"; Review timeline shows the green movement band and tick marks (taps, rolls…) |
| B2  | Stop moving halfway through (FT/FTF/FR stop at ~7 s; SAW stand still after a turn) | Retake: "Movement stopped for … s"                                                            |
| B3  | Do the task wrong (one hand only, never touch, stay seated, only smile)            | Retake: "The task was not carried out as instructed"                                          |
| B4  | Walk out of frame for > 2 s while recording                                        | Red banner + vibration during the take; Retake                                                |
| B5  | FA: cover the mouth with a hand for half the take                                  | Retake: "Key body points for this test were hidden too often…"                                |
| B6  | Press Stop early                                                                   | Retake: "Stopped early at … s"                                                                |
| B7  | "Keep this take…" on a retake → reason → Keep                                      | Summary shows "Kept · flagged"                                                                |
| B8  | Time from take end to the Review screen                                            | Under ~2 s (FA takes are the heaviest). Report the seconds                                    |

## C. Interruptions and storage (M7 §15)

| #   | What to do                                              | Expected                                                           |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| C1  | Press Home during a take, come back                     | Back at framing with "The app left the screen … Record it again"   |
| C2  | Have someone call the phone during a take and answer it | Same as C1                                                         |
| C3  | Fill the phone until < 2 GB free, open framing          | Red "Storage almost full: … GB free, 2 GB needed"; Record disabled |
| C4  | Kill the app from recent apps during a take, reopen it  | Session resumes at that test with "The last take was interrupted"  |
| C5  | End a session early (End session → reason)              | Summary: "Session ended early: …", remaining tests "Not done"      |

## D. Summary and uploads (M7)

| #    | What to do                                     | Expected                                                                             |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1   | Finish a session without registering the phone | Summary: "This phone is not registered with a server…" and a "Set up uploads" button |
| D2   | Tap the operator name on the home screen       | "Server & uploads" sheet opens (server address, enrollment code)                     |
| D3 🖥 | Register, sign in, run a session               | Each passed or kept test goes "Uploading n%" → "Uploaded"                            |
| D4 🖥 | Flight mode mid-upload, then off               | "Will retry · No connection" → resumes → "Uploaded"                                  |
| D5 🖥 | Wi-Fi only on, phone on mobile data            | "Paused · Waiting for Wi-Fi"                                                         |

## Report template

Copy this, fill it in and send it with screenshots:

```
Phone: (model, Android version)
APK: (CI run number or date)
A1 … A6:  Pass / Fail / Not tested — notes
B1 … B8:  Pass / Fail / Not tested — notes (B8: seconds per test)
C1 … C5:  Pass / Fail / Not tested — notes
D1, D2:   Pass / Fail / Not tested — notes
Anything else odd (crashes, freezes, wrong text, overlay offsets):
```
