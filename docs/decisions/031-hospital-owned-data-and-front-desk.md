# 031 — Hospital-owned data only; the front desk invites patients

- **Status:** accepted (user, 16 Nov 2026)

## Decision

- **No "data managed by NeuroCapture".** Every hospital and clinic runs its own connector and
  holds its own take key. NeuroCapture never runs a hospital's connector, so it never holds a key
  that opens recordings.
  - The onboarding choice is removed; `data_mode` is always `byo` (migration 0013).
  - A small clinic without IT staff still runs the connector on a computer or server it controls,
    set up by a vendor or contractor of its choosing (`docs/connector.md`).
- **Recording storage keeps both options.** Either NeuroCapture storage (separate per hospital) or
  the hospital's own S3 bucket. In both cases the files are encrypted on the phone with the
  hospital's key, and NeuroCapture cannot open them. The dashboard now says so.
- **The hospital admin sets up; the front desk handles patients.**
  - Hospital admin menu: overview, data connections, team, phones, activity.
  - Receptionist menu: appointments, invite patients, assign patients.
  - Join invites are sent from the front desk only. "Invite patients" and the "Send join invite"
    button on Appointments both offer the same three ways: e-mail with QR code and link,
    SMS (paid by the hospital), or a printed QR handed over at the visit.

## Consequences

- The API enforces it too (user, 16 Nov 2026): a hospital admin is refused (403) for join invites,
  appointments, doctor assignments and NCID look-ups, on the platform and on the connector. A
  hospital with no front desk yet adds one under Team (several admins and front-desk staff are
  allowed, each with their own login).
- Deletion requests from phones before v3 are shown on the admin's Overview, only when there are
  any.
