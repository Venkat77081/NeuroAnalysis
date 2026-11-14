# M3 on-device acceptance tests

Debug APK from CI. Everything else in M3 is covered by Playwright in mock mode
(`apps/mobile/e2e/session.spec.ts`: full 5-take session with one "Keep this take", reload-resume, skip).

| #   | Criterion                                                     | How                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Kill the app mid-session; reopening resumes at the right step | Start a session, finish test 1, open test 2 instructions. Swipe the app away (or Settings → Force stop). Reopen: the app opens on **Test 2 of 5**, same patient.                                                   |
| 2   | Kill during a take → Interrupted, back at framing             | Start a take, then force-stop / swipe away during the countdown or recording. Reopen: framing screen with the amber "The last take was interrupted" note; record again.                                            |
| 3   | Full session on a phone                                       | Run all 5 tests (outline shown per test, countdown beeps, REC timer, auto-stop at 15 s / 45 s, review, accept). One test: **Stop early** → RETAKE → **Keep this take…** → reason → summary shows _Kept · flagged_. |
| 4   | Listen (TTS)                                                  | On a test's instructions tap **Listen**: the steps are read aloud (English; Hindi after switching language in the engineering menu).                                                                               |
| 5   | Playback                                                      | On Review tap the video area: the take plays; Close.                                                                                                                                                               |
| 6   | Engineering menu                                              | Long-press the logo on Session home: operator ID, language, Device check.                                                                                                                                          |

## Results

| Phone           | Android | #1  | #2  | #3  | #4  | #5  | #6  |
| --------------- | ------- | --- | --- | --- | --- | --- | --- |
| OnePlus CPH2649 | 17      |     |     |     |     |     |     |
