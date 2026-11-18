# 045 — Appointment changes: the desk moves, patients ask, doctors by clinic hours

- **Status:** accepted (user, 18 Nov 2026: mockups "v13 · Appointment changes"; free times from
  clinic hours (option a); the desk's change is kept for hospital-system appointments; patients
  choose days and a time of day; 24-hour cut-off; settings for the phones' pass level and the
  cut-off in the hospital admin's dashboard).
- **Changes:**
  - v3: "nothing reaches the patient before the doctor sends a record link". The patient app now
    also lists the patient's upcoming booked appointments, so each can be changed.
  - Decision 035: the camera-check pass level can be raised per hospital.

## What the front desk does

- **Every appointment** has "Change date or doctor". The panel shows:
  - a calendar;
  - each doctor's free times for the chosen day, with the booked doctor first, then the same
    department;
  - a reason from a fixed list (doctor not available, patient phoned, clinic change, other);
  - "tell the patient", which sends an SMS or e-mail from the hospital connector.
- **Patients' requests** have their own tab, with a count in the menu. The desk can:
  - pick any date, doctor and time (the patient's days are highlighted, not a limit);
  - or answer without moving: "Please call us" or "Keep the booked date".
- **Changing the doctor** moves access with the appointment (decision 040): the new doctor sees
  it, and the old one no longer sees it through this appointment. The tests already chosen stay.
- **What moves with it:**
  - the appointment's open record links (their due dates shift by the same amount);
  - the clinic queue entry (the queue is read by date);
  - an open patient request, which is accepted, or closed if the desk moved it on its own.
- **Appointments booked in the hospital system (FHIR):** NeuroCapture cannot write there. The
  panel reminds the desk to move it there too. A later import with the same time keeps the desk's
  change; a new time from the hospital system replaces it (`Appointment.external_at`).

## Free times

- They come from each doctor's **clinic hours** (Team page: weekly hours, appointment length,
  leave), minus the doctor's booked appointments in NeuroCapture, in the **hospital's time zone**
  (Settings).
- NeuroCapture does not know a doctor's other patients, so the panel tells the desk to check.
- Reading free slots from the hospital system (FHIR `Slot`) can come later.

## What the patient does

- On each upcoming appointment: "Ask to change the date". The patient picks:
  - up to 3 days (the next 14, more on request);
  - morning, afternoon or any time;
  - an optional reason from a list (can't make it, unwell, travel, other).

  No free text: the platform must not hold health details.

- One open request per appointment. It can be withdrawn.
- Asking is not offered within the hospital's cut-off (default 24 hours), or when the hospital has
  turned requests off.
- The app shows the answer: "Changed" (and whether the doctor changed), "Not changed — please
  call", or "changed by the hospital".

## Hospital settings (hospital admin → Settings)

| Setting                         | Choices                      | Default            |
| ------------------------------- | ---------------------------- | ------------------ |
| Phones' camera-check pass level | 55–59 fps (stricter only)    | 55 (platform)      |
| Patients may ask to change      | on / off                     | on                 |
| Until how long before           | 2, 4, 12, 24, 48 or 72 hours | 24                 |
| Hospital time zone              | IANA zones                   | by region (IN, US) |

The choices are in `config/platform.json` (`deviceCheck.minFpsOptions`, `appointmentChanges`).
A hospital can only raise the pass level: takes need 59 fps anyway.

## Data

- **New tables:**
  - `appointment_change_requests`: days, part of day, reason code, status;
  - `appointment_notices`: what the connector should tell the patient;
  - `doctor_hours`.
- **New columns:**
  - `appointments`: `external_at`, `moved_at`, `moved_from`, `moved_from_doctor_id`,
    `moved_reason`;
  - `sites.settings`.

  Migration `0021`.

- **No patient identity is added.** Notices carry the NCID; the connector looks up the contact in
  the hospital's records and sends with the hospital's own e-mail and SMS accounts (templates
  `appointmentMoved*`, `appointmentNotChanged*`).
