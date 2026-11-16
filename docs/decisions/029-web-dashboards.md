# 029 — Web dashboards (M14)

- **Status:** accepted (M14)

## Decision

- **One React app, three roles.** It uses the same design tokens and stack as the phone app,
  and builds to static files. The API address is read at run time from `config.json`, so one
  build serves every environment.
- **Identity goes from the connector to the browser only.**
  - Lists come from the platform as NCIDs. The browser joins names from the connector
    (`POST /v1/patients/lookup`), live.
  - The doctor's patient page reads history and recordings from the connector.
  - Reviews (usable / not usable and a note) are stored at the hospital, in the connector's
    database. The platform never receives the note.
- **Re-record requests** are a platform field on the recording plan: the patient's app shows the
  request as due until the patient records again. Only doctors can make one.
- **Token handling:** the access token is kept in memory. The refresh token is kept in
  `sessionStorage`, never in `localStorage`. The API allows the dashboard origin only
  (`NC_CORS_ORIGINS`).
- **Acceptance test:** `pnpm e2e:dashboard` runs the real platform, the real connector and a FHIR
  stand-in as separate processes. A doctor views live history and plays a decrypted recording.
  Then `scan_platform.py` searches the platform's database, log file and stored objects for the
  patient's name, MRN, e-mail, phone, birth date and the review note. A positive control (the
  NCID) shows the scan does find stored values.

## Receptionist and assignments (user, 15 Nov 2026)

- **New hospital role: receptionist.** A receptionist:
  - finds patients in the hospital's records (live);
  - adds them to NeuroCapture (an NCID only);
  - assigns, reassigns or unassigns each patient's doctor.

  A receptionist cannot see medical history or recordings, nor manage the team, phones or
  settings. Hospital admins can also assign.

- **Doctors see only their assigned patients**, enforced in two places:
  - **the platform:** patient list, plan, re-record request and readiness. An unassigned
    patient answers "not found", so its existence is not revealed.
  - **the hospital connector:** names, history, recordings, decrypted videos and reviews. The
    connector asks the platform (`POST /connector/v1/access`, signed) on every request, without
    caching, so a reassignment takes effect on the very next request.
- Doctors can no longer search the hospital's records; the receptionist finds patients.
- **Clinical data is for the assigned doctor only** (user, 15 Nov 2026). Medical history,
  recordings, decrypted videos and review notes are refused for hospital admins and
  receptionists on the connector. They see names (to invite and assign) and the activity log.
- A patient has one assigned doctor at a time. Assignment changes are kept in the activity log.
- The dashboard stays English only (user, 15 Nov 2026). Doctors need network access to their
  hospital's connector, as designed.

## Consequences

- Doctors need network access to their hospital's connector. Without it, the dashboard shows the
  connector error and lists NCIDs only.
- Each doctor's "My patients" shows only the patients the receptionist assigned (A83).
