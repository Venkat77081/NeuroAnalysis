# 032 — Who did what: activity logs and appointment history by person

- **Status:** accepted (user, 16 Nov 2026; mockups "v4 · Who did what")

## Decision

- **Every activity log names the person.** Each row shows the person's name, e-mail and role:
  - the platform admin's log;
  - the hospital admin's log (platform and connector events merged into one table).
  - Filters: person, kind of activity and date. **Download CSV** exports the rows shown.
- **Staff are NeuroCapture accounts, so their names are kept.**
  - Team members must give a full name, and the Team page shows when each person last signed in.
  - Clinic-phone operators now have a name too (`operators.name`, migration 0014). Before this
    only a hash of the operator's name was kept, so logs showed just the code (OP-07).
  - Patients are still never named on the platform. Logs carry the patient's NCID, and the
    hospital's dashboard looks the name up live through the connector.
- **The connector says who acted.** Invites and new patient IDs created through the hospital
  connector are recorded with the staff member who asked, not "connector".
- **Each appointment has a history** (`GET /hospital/appointments/{id}/history`):
  - when it was added (from the hospital system or by hand, and by whom);
  - join invites;
  - doctor assigned or reassigned (with both doctors' names);
  - the record link the doctor sent (tests, due date);
  - cancellations.

  The Appointments page shows the last change on each row and opens the full history. Patient
  events from 30 days before the appointment was added are included.

- **Several hospital admins and front-desk staff** are allowed. Each person has their own login
  and two-step code, and people with the same role see the same pages.
