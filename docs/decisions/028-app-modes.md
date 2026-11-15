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
- **Offline screen lock.** After sign-in the phone keeps a salted PBKDF2 hash of the operator
  password or patient PIN, and unlocks against it without a network. It locks after the idle
  time in `config/platform.json` (operators 5 min, patients 2 min), and never during a
  recording.
- **Home walking test needs a helper.** Without one, it is skipped with the `no_helper` reason.
- **Invite links** are `neurocapture://invite?t=…` (e-mail, SMS, or the camera scanning the QR
  code), handled by `@capacitor/app`. Pasting the link or code also works. There is no in-app
  QR scanner.
