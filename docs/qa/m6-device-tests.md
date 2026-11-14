# M6 on-device tests (monitoring during recording, task detectors)

Debug APK from CI. Each take now ends with a timeline on the Review screen (green band =
movement window, ticks = detected events, amber/red = alerts) and `quality.json` in the take.

| #   | What                                                                                                              | Expected                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Normal take for each test (FT, FTF, FR, SAW, FA)                                                                  | Capture passed; timeline shows the movement and plausible counts (e.g. FT "R n · L n")         |
| 2   | Stop moving halfway (FT/FTF/FR: stop at ~7 s; FA: stop after the first sequence; SAW: stand still after one turn) | Retake: "Movement stopped for … s (…–… s)"                                                     |
| 3   | Do it wrong (FT: tap with one hand only; FTF: never touch; FR: do not roll; SAW: stay seated; FA: only smile)     | Retake: "The task was not carried out as instructed."                                          |
| 4   | Walk out of the frame for > 2 s while recording                                                                   | Red banner + vibration during recording; Retake: "A serious problem happened during recording" |
| 5   | Second person enters for > 1 s                                                                                    | Red banner; Retake                                                                             |
| 6   | Shake the phone for > 1 s                                                                                         | Red banner; Retake                                                                             |
| 7   | Cover the camera for > 2 s during the movement                                                                    | Retake: "Tracking was lost for … s"                                                            |

Note: on-device analysis runs at ~7–10 fps (decision 016), so fast tapping is under-counted on
the phone; counts are quality evidence only (decision 017).

## Fixture library (needed for M6 sign-off)

At least 15 recorded takes per test (normal, slow, fast, stops halfway, wrong), each with the true
event count written down (taps per hand, rolls per hand, touches, SAW turns, FA sequences).
