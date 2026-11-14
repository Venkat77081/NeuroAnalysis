# M4 on-device acceptance tests

Debug APK from CI. Engineering menu (long-press the logo) → **Device check** → **Tracking test (M4)**.
The M4 numbers are only binding on a Tier A phone at 60 fps (DEV_PLAN §16 M4); on other phones
record them anyway.

| #   | Criterion                                             | How                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Analysis ≥ 20 fps, latency p95 ≤ 80 ms, event ≤ 20 KB | Tracking test → each of **FT, FR, FTF, SAW, FA** with "Record one take" on. Point the camera at a person doing the task. Each result card shows ✓/✗ for fps, latency and size.                                                                |
| 2   | Recording still meets M2 while tracking               | Same runs: the "take" line must be ✓ (duration error ≤ 50 ms, fps, frame count, timestamps, encrypted) and show a non-zero number of landmark frames.                                                                                         |
| 3   | Overlay within 2 % of the frame (printed target)      | Engineering menu → tick **Show landmark overlay (debug)**, start a session. Hold a printed hand photo (FT, back camera) and a printed full-body photo (SAW). Dots should sit on the knuckles / joints, within about a finger width on screen. |
| 4   | Mirroring and left/right                              | With the overlay on, hold up your **right** hand: the label next to the wrist must read **R** (orange). Try a front-camera test (FA) and a back-camera test (FT): moving your hand right must move the dots the same way on screen.           |
| 5   | Both orientations                                     | Repeat #4 on a landscape test (SAW) and a portrait test (FT).                                                                                                                                                                                 |
| 6   | GPU / CPU                                             | Result card ends with GPU or CPU. Note which.                                                                                                                                                                                                 |

Browser demo (optional): `pnpm --filter @neurocapture/mobile dev`, open `/?impl=webcam` on a laptop,
Device check → Tracking test.

## Results

| Phone           | Android | Test | Analysis fps | Latency p95 ms | Max KB | Take M2 | GPU/CPU | Overlay #3–5 |
| --------------- | ------- | ---- | ------------ | -------------- | ------ | ------- | ------- | ------------ |
| OnePlus CPH2649 | 17      |      |              |                |        |         |         |              |
