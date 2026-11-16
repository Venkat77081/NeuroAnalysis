# 041 — Test mode in the debug APK; long-press menu cut to the frame-rate check

- **Status:** accepted (user, 16 Nov 2026: "for apk long press logo have option to bypass server
  and add fake queue and record links … for other debug tests change everything to only check the
  frame rate"; mockup "v9 · APK test mode").

## Decision

- **The long-press menu** (logo on the first screen and on the clinic home) offers:
  - language;
  - frame-rate limit;
  - **Camera frame-rate check**, the same check as at set-up, which records and sends nothing;
  - **Test mode** (debug builds on a phone only).
- The older engineering tools (operator ID, landmark overlay, record without the gate, capture and
  tracking tests, device tiers) are for developers in the browser only, with `?tools=1`.
- **Test mode:**
  - A pretend hospital ("Test Hospital") lives in the app: no server and no network.
  - Every server call (sign-in, clinic queue, invites, record links, the clinic recording notice)
    is answered by the same fake server the browser version uses, in a lenient mode. It accepts
    devices and patients it has forgotten after an app restart.
  - The camera, camera check, tracking and every quality check are the real native ones.
  - Nothing is uploaded; the session summary says so.
  - Clinic set-up offers "Use the test hospital". The patient invite screen offers "Join the test
    hospital". The Test tab adds queue patients, record links and a clinic recording notice.
  - Switching it on or off wipes the app's data first (the same as "Start again"), so test data
    never mixes with real data.
- Release builds (`VITE_PRODUCTION=1`) have no test mode and no developer tools.
