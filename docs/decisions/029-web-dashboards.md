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

## Consequences

- Doctors need network access to their hospital's connector. Without it, the dashboard shows the
  connector error and lists NCIDs only.
- **No doctor ↔ patient assignment yet:** "My patients" lists every patient of the doctor's
  hospital (assumption A83).
