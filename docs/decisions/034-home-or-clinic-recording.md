# 034 — Home or clinic recording; appointments by hand only

- **Status:** accepted (user, 16 Nov 2026; mockups "v6 · Home or clinic recording")

## Decision

- **The doctor chooses where to record**, on Choose tests:
  - **At home:** a record link in the patient's app.
  - **In the clinic:** the request goes to the clinic phones' queue for the visit day.
  - **Both.**

  For a patient who has not joined the app, only "In the clinic" is possible.
  - Each place is its own recording request (`recording_requests.place`, migration 0016). A clinic
    request is due on the visit day. Reminders and "repeat every N days" apply to home links only.

- **Clinic queue on clinic phones** (`GET /clinic/queue?from&to`, permission `clinic.record`):
  - The phone asks for its own day, in its own time zone. At most `requests.clinicQueueMaxHours`.
  - The queue shows the patient's **name and MRN, read live from the hospital connector**. The
    connector returns names to a clinic phone only for patients in its hospital's clinic queue
    (the platform checks, as it does for doctors).
  - Tapping an entry fills in the session: patient, the doctor's tests, the medicine state and the
    request. The operator still confirms consent.
  - "Not recorded" needs a reason from `requests.clinicNotDoneReasons` and is logged by name.
- **Appointments are added by hand only.** The hospital's appointment system holds every specialty
  (ortho, cardio, …), so nothing is read from it:
  - the connector's appointment reader (FHIR `Appointment`, the SQL view `nc_appointments`) and
    `GET /v1/appointments` were removed;
  - the front desk's "Add an appointment" form is at the top of the page;
  - finding a patient by name or MRN still reads the hospital's patient records live.
- **The patient's app shows a clinic request as information only**, for example "Dr. Rao will
  record your movement tests at the clinic on 21 Nov". It has no record button.
