# 063: Patients may start a recording with a hand sign

- **Status:** accepted. Built on `claude/new-ui-for-app` and `main` (older look). Mockups: canvas page v36.
- **Asked by the user (24 Nov 2026):** "can we have a gesture control to start recording? … check
  phones are they capable to do gesture?", then "gestures for patients only" and "build the v36
  gesture".

## The sign

| Tests                                                             | Sign                                                   | Why                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finger Tapping, Finger-to-Finger, Forearm Roll, Facial Activation | An open palm raised **above the head**, held still 1 s | The hand tests start with both hands up, open and facing the camera; a palm at that height would start the take by itself (found in testing). Above the head is used by no test. |
| Stand and Walk                                                    | One wrist above the head (body model), held still 1 s  | At 3–4 m hands are too small to read.                                                                                                                                            |

- "Above the head" = above the nose (body model) or the forehead (face mesh, for Facial
  Activation, which then also tracks hands); without either, the top quarter of the picture.
- Held still: moving more than 0.6 × the hand's (or shoulders') size restarts the hold; tracking
  gaps up to 0.3 s are bridged. It fires once per raise.
- It counts only while framing and only when the outline is green (not on an advisory gate), and
  never while storage is too low or the phone is too hot.
- It presses Record: the usual 3-2-1 countdown with beeps follows, with "Lower your hand" on screen
  and spoken. The native timer still stops the take; a sign never stops or retakes anything.

## Who gets it

- **Patients only** (home sessions). Clinic phones keep the Record button only.
- **Only on phones that passed the try-out** in the phone check: hand tracking at least
  10 updates a second and the sign seen within 6 s. The try-out is optional ("Not now"), and
  joining never waits for it.
- The patient can switch it off in Settings. The Record button is always there.

## What is kept

- On the phone: the try-out result and the Settings switch (local storage).
- On the platform, with the phone's other numbers (decision 062): `start_sign`
  (works / too_slow / not_seen / skipped) and `tracking_hz`. The Phones pages show a
  "Hand-sign start" column.

## Code

- `packages/quality-core/src/detectors/startsign.ts`: open palm, raised wrist, head height, the
  hold (pure TypeScript, tested).
- `apps/mobile/src/lib/startsign.ts` (hook, try-out), `screens/modes/SignTryout.tsx`,
  `screens/session/CameraStage.tsx` (prompt, Record, countdown cue).
- Settings in `config/session.json` (`startSign`).
