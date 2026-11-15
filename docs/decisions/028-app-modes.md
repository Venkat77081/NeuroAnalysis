# 028 — Android app modes (M13)

- **Status:** accepted (M13)
- **Milestone:** M13 (docs/PLATFORM_PLAN.md)

## Decision

- **One app, two modes, chosen once.**
  - First run shows a role chooser.
  - The mode is written by CaptureKit (`lockAppMode`) under a key JavaScript cannot write.
    Only `resetDevice` clears it.
  - A clinic phone locks at registration and a patient phone at invite acceptance. After that
    an invite link opened on a clinic phone is refused.
- **Tokens stay native.**
  - Sign-in hands the tokens to CaptureKit.
  - The app's signed-in calls go through `apiRequest`, which works only for an allow-list:
    the patient's plan, sessions, profile and consent withdrawal, and the operator's
    connector token and password change.
  - Nothing that uploads or changes takes can be called from JavaScript.
- **Take keys per session.** The phone wraps each take's data key with the hospital key that
  `POST /sessions` returns. The pre-registration platform key is never used for a session that
  has a hospital key.
- **Clinic patients by NCID.** The operator types the MRN. The app gets a 10-minute operator
  token, and the hospital connector returns the NCID (`/v1/ncid`, the token's only use). The
  MRN stays on the phone and in the hospital.
- **Screen lock checked with the server** (user, 15 Nov 2026). Unlocking signs in again with
  the server, using the operator password or the patient PIN, so every wrong attempt counts:
  - patients lock after 5 wrong PINs;
  - operators lock after 10 wrong passwords (`operators.maxFailedLogins`), and a hospital admin
    unlocks them.

  Unlocking needs a connection. The phone locks when it opens, and after the idle time in
  `config/platform.json` (operators 5 min, patients 2 min), never during a recording.

- **No recording without consent** (user, 15 Nov 2026). The session state machine refuses to
  start, and refuses to record, until consent is ticked. This includes practice sessions, and
  each home session (in addition to the consent given when accepting the invite).
- **Home walking test needs a helper.** Without one, it is skipped with the `no_helper` reason.
- **Invites:**
  - The **in-app QR scanner** (user, 15 Nov 2026) uses the camera through the WebView
    (`getUserMedia`). It uses the platform's BarcodeDetector when present, else jsQR 1.4.0
    (Apache-2.0). Frames are decoded in memory and never stored.
  - Links `neurocapture://invite?t=…` (e-mail, SMS) open the app through `@capacitor/app`.
  - Pasting the link or the SMS code also works.
