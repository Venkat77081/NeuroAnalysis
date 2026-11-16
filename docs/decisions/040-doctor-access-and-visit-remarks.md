# 040 — Doctor access by appointment, past-appointments period, visit remarks

- **Status:** accepted (user, 16 Nov 2026: "yes visit remarks, missed no access, old assignments
  no"; mockups "v9 · Doctor's patient page" and "v9 · Who can see a patient").
- **Supersedes:** the access rule in decision 038 and assumptions A114 and A115.

## Decision

- **A doctor sees a patient** (list, patient page, recordings, connector record) only if:
  - the patient has a **booked appointment with that doctor today or later**, or
  - **an appointment with that doctor was completed**, meaning at least one take recorded for it
    finished.
- **No access from:** a first appointment that was cancelled, moved to another doctor or missed
  (nothing recorded), or an old assignment from before v8. The assignments API is removed;
  `patient_assignments` stays in the database but gives no access.
- One rule for the platform and the connector: `app/assignments.py: doctor_patients_clause`,
  checked by the connector through the signed access endpoint.
- **Past appointments period** on the doctor's patient page: 30 / 90 / 180 days, 1 year or all
  (default 90, remembered in the browser). Upcoming appointments always show.
- **Visit remarks:**
  - One remark per appointment, written only by that appointment's doctor (403
    `not_your_appointment` otherwise).
  - Stored **at the connector** (`nc_visit_remarks`), never on the platform.
  - Clinical roles with access can read them. Clearing the text removes the remark.
  - The activity log records `visit_remark_written` / `visit_remark_cleared`, never the text.
- The connector asks the platform who the appointment's doctor is (`GET
/connector/v1/appointments/{id}`, signed, own site only).
