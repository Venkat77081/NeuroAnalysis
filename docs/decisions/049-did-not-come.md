# 049 — The front desk marks that the patient did not come

- **Status:** accepted (user, 18 Nov 2026: "Have option in platform as patient did not visit
  which is enabled at the appointment time so that if patient didn't showed up front desk can
  select it which in turn cancels the appointment and notifies doctor and patient").

## What happens

- **Front desk → Appointments:** **Did not come…** appears on a booked appointment once its time
  has passed. Before that, the platform refuses it (`409 not_yet`).
- **The dialog** shows the time and doctor, and has "Tell the patient" (on by default). It says
  what follows.
- **Confirming:**
  - cancels the appointment with the reason `no_show`, by staff;
  - closes open record links and requests, the same as any cancellation; recordings already
    made stay with the hospital;
  - queues a **patient notice**, sent by SMS or e-mail from the hospital connector
    (`appointmentNoShow*` texts), and shows it in the app;
  - **e-mails the doctor** from the platform (`doctorNoShow`). The e-mail holds only the NCID and
    the time; the name stays in the hospital's records, seen in the dashboard. A failed send is
    logged without the address and does not undo the change.
- **Refused** when the clinic already recorded the patient at that visit (`recorded_at_visit`),
  because they came.
- **Shown as "Did not come"** on the desk's list and the doctor's timeline. The patient sees it in
  Appointment history, under the Cancelled filter, and in the appointment card ("you did not come
  to it").
- The activity log keeps it as `appointment_cancelled` with reason `no_show`.
- **Undo:** none. The desk books a new appointment if it was a mistake.

## API

`POST /hospital/appointments/{id}/no-show {notify?: bool}` uses the same permission as cancelling
(`appointments.add`). The patient's history returns `status: "no_show"`.
