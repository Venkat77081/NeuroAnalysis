# 023 — Hospital-owned data, NCID, connector, two app modes, web dashboards

- **Status:** accepted (user, 15 Nov 2026, "keep all the suggestions")
- **Milestones:** M10–M14 (docs/PLATFORM_PLAN.md)

## Decision

- Patients are known to NeuroCapture only by a random **NCID**. The NCID↔MRN map, patient
  records, videos, clinical activity logs and biomarker results stay in the hospital's systems.
- A **hospital connector** in the hospital's network does live reads, keeps the NCID map,
  decrypts videos and writes clinical logs. This replaces direct database credentials, which
  hospitals rarely grant and which would expose their network.
  - Records are read through FHIR R4 or read-only SQL views; ABDM comes later.
  - The doctor's browser reads patient identity from the connector directly, never through our
    servers.
- **Per-hospital encryption keys.** Take keys are wrapped with the hospital's public key; only
  its connector or KMS can decrypt them.
- **Managed option:** small clinics get the same connector, run by NeuroCapture, with separate
  storage and keys.
- **Patients** join by invite only (e-mail QR by default; SMS paid by the hospital; printed QR)
  and then use a PIN. **Operators** use ID + password on hospital-registered phones locked to
  clinic use.
- **One web app** with three roles: platform admin, hospital admin, doctor. Two-step sign-in
  for every dashboard user.

## Supersedes

- §14 "patient reference hash" (phone-side salted hash of the clinic reference): replaced by
  the NCID issued by the connector.
- Operator code + PIN (M7): replaced by operator ID + password.
- DEV_PLAN M10 (iOS) moves to M16.

## Consequences

- Each hospital onboarding needs its IT to deploy the connector, bucket role and key, unless
  it chooses managed mode. The wizard's health checks make this self-service.
- If a hospital system is down, its doctors cannot see live history; recordings stay
  available, and uploads and logs queue.
