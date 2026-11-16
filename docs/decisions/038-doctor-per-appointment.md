# 038 — Each appointment keeps its own doctor; date range; queue-only clinic phones; built-in server

- **Status:** accepted (user, 16 Nov 2026: "B, range picker…", "build with (a)"; mockups "v8").
  Replaces decision 029's "one doctor per patient" and the "reassign moves appointments" rule.

## Decision

- **A doctor per appointment.**
  - Booking with a doctor sets that appointment's doctor only. It no longer reassigns the patient
    or moves the patient's other appointments.
  - Changing the doctor changes only that appointment. It is logged as
    `appointment_doctor_changed`, with both names.
- **Who may open a patient** (`app/assignments.py`): a doctor with a (not cancelled)
  appointment with them, past or upcoming; a doctor who sent them a recording request; or a
  doctor assigned before v8.
  - **(a): such a doctor sees the whole record** (live history and every recording, whichever
    doctor's appointment it was), so Dr. Iyer can compare with Dr. Rao's clinic recording.
    Opening a recording is logged under their name at the hospital's connector.
  - The same rule applies on the platform (patient pages, the patient list) and to the
    connector's identity check.
  - Doctors list and send links for **their own** appointments only.
- **The "Assign patients" page is removed** from the dashboard. Its API stays for patients
  assigned earlier, and no longer moves appointments.
- **Date range** on Appointments: next 7, 30 or 60 days, or the past 30 days
  (`GET /hospital/appointments?days=…|past_days=…`). The choice is remembered in the browser.
- **Clinic phones record queue patients only.**
  - On a phone connected to its hospital, the "New patient (MRN)" picker is gone. The home screen
    shows the queue (with Refresh, also when empty) and a note to ask the doctor for a clinic
    recording.
  - A queue patient can be put back ("Back to queue").
  - Practice mode, and the local engineering mode without a server, keep the picker.
- **Built-in server address.**
  - Release builds (`VITE_PRODUCTION=1`) have no server field. The address is `VITE_SERVER_URL`
    at build time (the release workflow requires an `https://` `server_url`), else
    `config/session.json`.
  - Debug and browser builds keep the field, for testing against a computer on the Wi-Fi. This
    differs from the mockup's long-press, to keep testing simple.
- **Fake (browser) mode test panel.**
  - A "Test" tab plays the hospital: a patient invite, the doctor's home record link, a clinic
    queue patient, and "Start again".
  - The fake server lives in the page, so reloading forgets registered phones and changed
    passwords; "Start again" clears the stored data too.
  - It is never shown with the real camera or in release builds.

## Consequences

- Earlier appointments keep their doctors. Patients assigned before v8 stay visible to that doctor.
- A doctor who loses an appointment, and never sent the patient a request, loses access.
