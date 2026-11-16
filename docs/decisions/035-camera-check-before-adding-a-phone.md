# 035 — Camera check before a phone is added

- **Status:** accepted (user, 16 Nov 2026: "Have 55 as cut off and notify hospital if patient
  cant add phone patient phone also 55"; mockups "v7 · Camera check")

## Decision

- **Every phone runs a camera check before it is added.** This covers clinic phones (before the
  registration code is sent) and patients' phones (after the invite is found, before the PIN).
  - The check is a short CaptureKit qualification benchmark:
    - back camera, 1080p, 60 fps target;
    - `deviceCheck.durationS` (20 s);
    - no thermal phase;
    - nothing is saved or uploaded.
- **Cut-off: 55 fps** (`deviceCheck.minFps`), the same for clinic and patient phones.
  - From 55 to below 59 (`deviceCheck.warnBelowFps`) the phone is **borderline**: it can be added,
    and the phone and the Phones list warn that some takes may need repeating.
  - **Takes still fail below 59 fps** (decision 015, doctor-adjustable). The check does not change
    that.
- **The server enforces it.**
  - `POST /auth/device-register` and `POST /patient/invite/accept` require
    `camera_check: {effective_fps, ran_at?}` and refuse with 422:
    - `camera_check_required` when it is missing;
    - `camera_check_failed` (with `min_fps` and `fps`) when it is below the cut-off.
  - The fps is stored with the device (`devices.check_fps`, `checked_at`; migration 0017) and shown
    on the hospital admin's Phones list.
- **A failed check uses nothing up.**
  - The registration code or invite stays valid until it expires, so another phone can use it.
  - The phone shows "Run the check again".
- **"Tell my hospital"** is an optional button for a patient whose phone fails.
  - It calls `POST /patient/invite/phone-not-suitable` with the invite, the phone model and the fps.
  - The platform stores only the fps and time on the patient account
    (`patient_accounts.camera_failed_fps`, `camera_failed_at`) and logs `phone_not_suitable`.
  - Reception sees "Phone not suitable · N fps" in Appointments. The doctor sees it in Choose tests,
    where clinic recording is already the only choice for a patient who has not joined.
  - Joining later with a phone that passes clears it.

- **Phones list: "In use (last 30 days)"** (`deviceCheck.usageDays`; user, 16 Nov 2026: "build
  the takes column too").
  - Shows the takes recorded on each clinic phone, and how many were below 59 fps
    (`warnBelowFps`). Retakes are included.
  - When a session closes, the app sends `attempt_fps`, the measured fps of every take recorded
    (numbers only, stored as `sessions.attempt_fps`, migration 0017). Retaken takes are never
    uploaded, so this is the only way to count them.
  - Sessions from apps that do not send `attempt_fps` count their uploaded takes instead
    (`fpsEffective` in each take's quality report).
  - The borderline band stays (user: "keep borderline").

## Why

A phone that cannot reach 55 fps would fail almost every take. Checking before the code or invite
is used saves a wasted visit or a frustrated patient, and it points the doctor to clinic recording
early.

## Consequences

- Phones registered before this change show "Not checked" on the Phones list. They are not
  re-checked automatically.
- Mock mode: `?benchFps=48` makes the simulated check measure 48 fps (e2e).
