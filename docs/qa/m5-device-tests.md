# M5 on-device acceptance tests

Debug APK from CI. For each test, set up correctly, then create each failure below. Expected:
the outline turns **amber** with **one** prompt within about 1 s, the matching chip shows **!**,
and Record stays disabled. Fix it: the outline turns **green** and Record enables within 2 s.

The same scenarios already pass as unit tests on synthetic frames
(`packages/quality-core/test/scenarios.test.ts`, 132 cases) and in Playwright (mock camera).

| Test                 | Scenario (DEV_PLAN §17)                           | Expected prompt                       |
| -------------------- | ------------------------------------------------- | ------------------------------------- |
| all                  | correct setup                                     | none; green; "Ready. Press Record"    |
| all                  | too far / too close                               | "Too far…" / "Too close…"             |
| all                  | body or hands cut off left / right / top / bottom | "Cut off on the …"                    |
| all                  | nobody in view                                    | "No one in view…"                     |
| all                  | dark room / window behind the patient             | "Too dark…" / "Too bright…"           |
| all                  | phone tilted > 5°                                 | "Level the phone"                     |
| all                  | phone shaken                                      | "Hold the phone still"                |
| FT, FTF, FR          | one hand hidden                                   | "Keep both hands in view"             |
| FT, FTF, FR, SAW, FA | second person walks in                            | "Only the patient should be in view"  |
| SAW                  | front view instead of side view                   | "Turn the patient side-on…"           |
| FA                   | head turned 20° / looking down                    | "Ask the patient to look straight…"   |
| FA                   | half the face in shadow                           | "Uneven light on the face…"           |
| any                  | cover the camera briefly                          | "Tracking…", no error prompt          |
| —                    | Tracking test (M4): result card                   | "quality evaluation p95 … ms (≤ 5)" ✓ |

Notes:

- Sharpness is checked only after **Device check → Capture test → Sharpness 3 s** on this phone.
- If a correct setup never turns green on a real phone, note which chip stays **!** and its
  prompt; Engineering menu → "Record without the positioning gate" lets you continue the session
  while thresholds are tuned.

## Results

| Phone           | Android | Test | Scenarios OK | Wrong / missing prompts | Eval p95 ms |
| --------------- | ------- | ---- | ------------ | ----------------------- | ----------- |
| OnePlus CPH2649 | 17      |      |              |                         |             |
