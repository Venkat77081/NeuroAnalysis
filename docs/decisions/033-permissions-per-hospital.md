# 033 — Roles and permissions per hospital

- **Status:** accepted (user, 16 Nov 2026; mockups "v5 · Roles and permissions")

## Decision

- **What each role may do is a per-hospital setting**, changed by the platform admin only
  (Hospitals → Roles and permissions). A change needs a short reason. It is logged with the
  person's name in the platform log and in that hospital's log.
- **Defaults** are in `config/platform.json` (`permissions`, PLATFORM@1.4.0) and match how the
  product worked before. A hospital stores only where it differs (`sites.permissions`, migration
  0015). "Reset to defaults" clears it.
- **Permissions:**

  | Permission                                                           | Default            |
  | -------------------------------------------------------------------- | ------------------ |
  | `patients.search` (find patients in the records)                     | front desk         |
  | `invites.send`                                                       | front desk         |
  | `appointments.view`                                                  | front desk, doctor |
  | `appointments.add` (also the live list from the hospital system)     | front desk         |
  | `appointments.assign`                                                | front desk         |
  | `requests.send` (choose tests, send the record link)                 | doctor             |
  | `requests.rerecord` (record again, "repeat every N days", home plan) | doctor             |
  | `clinic.record` (clinic-phone sign-in and the MRN → NCID lookup)     | operator           |
  | `setup.team`, `setup.phones`, `setup.connections`, `setup.activity`  | hospital admin     |

  Each permission also lists the roles it may be given to. For example, record links can only
  ever go to doctors.

- **Fixed rules are not permissions.** They stay in code and are shown locked:
  - medical history, recordings and reviews are visible only to the assigned doctor;
  - NeuroCapture never stores patient identity;
  - nothing is recorded without consent;
  - every action is logged by name.
- **Enforced everywhere:**
  - the platform API (`app/permissions.py`);
  - the hospital connector: the platform puts the person's permissions in the 10-minute connector
    token, so a change reaches the connector within 10 minutes;
  - clinic-phone sign-in (`clinic.record`);
  - the dashboard menus and buttons (from `/staff/me`).
- The hospital admin sees the table read only on the Team page.

## Consequences

- A doctor given `appointments.add` or `appointments.assign` may book for any patient of the
  hospital. That is booking work, not clinical data. Their clinical view is still limited to
  assigned patients.
- The connector's live appointment list (names of all patients) needs `appointments.add`, not
  just `appointments.view`.
