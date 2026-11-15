# 030 — Appointments, record links and consent per recording (v3)

- **Status:** accepted (user, 15 Nov 2026, after the v3 mockup review)
- **Mockups:** canvas page "v3 · Appointments and consent per recording" (linked from
  `docs/mockups.md`)

## Decision

- **Joining is not consent.** A patient joins a hospital with its invite and a PIN. The join
  screen shows how recordings are used, but has no consent box.
- **Consent is given for each recording**, on its own screen just before the camera opens. If the
  box is not ticked, the camera does not open. The tick is stored with that session only
  (`consent_version`, `consent_at`).
- **Appointments come from the hospital system or are entered by hand.**
  - The connector reads them live (`GET /v1/appointments`, FHIR `Appointment` or the SQL view
    `nc_appointments`).
  - When the Appointments page opens, appointments of patients with an NCID are copied to the
    platform. Copying twice makes no duplicate: the platform matches them by SHA-256 of
    site ID + the hospital's appointment ID.
  - Reception adds the others by hand.
  - The platform keeps only the time, the NCID, the doctor and where the appointment came from.
- **Flow:**
  1. Reception assigns the doctor. The doctor is then assigned to the patient too.
  2. The appointment waits in that doctor's "Choose tests" list.
  3. The doctor picks the tests, the medicine state and the record-by date. Shortcuts: "same as
     last time", "hands only", "all 5". The medical history is shown next to the choice.
  4. Only now does the patient receive the record link (a recording request).
  - Only the assigned doctor can send the link: `POST /hospital/appointments/{id}/request` is
    doctor only, and the appointment must be theirs.
- **Appointment stages:** needs a doctor → waiting for the doctor's tests → link sent →
  recorded or missed; or cancelled. The stage is worked out on the platform.
- **Recording every N days only when the doctor asks.** There are two ways:
  - "Also repeat every N days" when sending a record link;
  - the plan's "Also record every N days" box on the patient page.
  - Otherwise the patient records only for appointments.
  - **It runs until the next appointment** (user, 15 Nov 2026): it starts when the doctor turns it
    on and ends at the patient's first booked appointment after that. The end follows a
    reschedule or a cancellation. If no appointment is booked, it runs until one is. The platform
    works out the end (`periodic_until`); the app and dashboard show it.
- **Reminders** are sent by the connector the day before the record-by date
  (`requests.reminderHoursBefore`). It asks the platform which reminders are due, then reads the
  contact details from the hospital's records. The platform still never holds contact details.
- **Many hospitals on one phone.**
  - Each hospital knows the patient under its own NCID. The platform never links them; only the
    phone lists them together.
  - CaptureKit keeps one upload profile per hospital: its own tokens, endpoint and take key. A
    take is uploaded with the profile of the hospital it was recorded for.
  - The first hospital uses the default profile, so installs from before v3 carry on.
- **Withdrawing from a hospital keeps everything at the hospital.**
  - The patient's history for that hospital stays readable on the phone (read only).
  - Only the hospital can let the patient back in, by sending a new join invite. The NCID stays
    the same, so the history continues.
  - The per-hospital retention setting from the first v3 draft was removed: "all data hospitals
    can have".

## Consequences

- Patients who have joined but have no record link have nothing to record. The app says so.
- One PIN serves every hospital on the phone. Unlocking checks it with the first hospital still
  joined; the other hospitals are signed in with the same PIN, best effort.
- A recording request is "recorded" once one take of a session for it is uploaded.
