# NeuroCapture platform plan (v3.2 addendum)

Agreed with the user on 15 Nov 2026 after mockup review
(canvas page "v2 · Hospital-owned data": https://claude.ai/artifact/1G8hAap1unUqHbomhA1XA1).
It extends DEV_PLAN v3.1 and replaces its milestone M10 numbering: iOS moves to M16.
Decision 023 records the reasoning.

## 1. What changes

- **The app has two modes:**
  - **Patients** record at home, after an invite from their hospital.
  - **Clinic operators** record on phones the hospital registered.
- **Three web dashboards in one web app:**
  - **Platform admin (us):** onboard hospitals, see platform logs.
  - **Hospital admin:** connect data, register phones, manage operators and doctors, invite patients.
  - **Doctor:** live patient history, recordings, review, and the biomarker report later.
- **Hospital-owned data.**
  - Patient identity, records, the NCID↔MRN map, videos, clinical activity logs and biomarker
    results live in the hospital's systems.
  - NeuroCapture stores only random patient IDs (**NCID**) and platform data: hospitals, who
    onboarded them, accounts, devices, platform activity and security logs.
- **A managed option** for clinics without IT. NeuroCapture runs the same connector for them,
  with storage and key separated per clinic in an India region, and they can move to their own
  systems later.

## 2. Roles

| Role           | Signs in with                                          | Where          | Can                                                                                   |
| -------------- | ------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------- |
| Platform admin | e-mail + password + two-step                           | Web            | Onboard, suspend and configure hospitals; read platform logs and crash reports        |
| Hospital admin | e-mail + password + two-step                           | Web            | Data connections, phones, operators, doctors, patient invites, hospital activity log  |
| Doctor         | e-mail + password + two-step                           | Web            | Their patients: live history, recordings, review, re-record requests, recording plans |
| Operator       | operator ID + password                                 | Clinic phone   | Record clinic sessions; practice mode                                                 |
| Patient        | invite (e-mail QR / SMS code / printed QR), then a PIN | Personal phone | Record the plan their doctor set; see upload status; withdraw consent                 |

## 3. The hospital connector

A small service the hospital runs in its own network or cloud account (Docker image). For
managed clinics, NeuroCapture runs one per clinic.

- **Patient records, read live, never cached:**
  - a FHIR R4 adapter (Patient, Condition, MedicationStatement, Encounter);
  - or a SQL adapter over read-only views that hospital IT defines;
  - ABDM (consent-based fetch with the patient's ABHA ID) later.
- **NCID map:** one table, `ncid ↔ mrn`, in the hospital's database. An NCID is created when a
  patient accepts an invite, or when an operator starts a clinic session for a hospital patient.
- **Doctor view:** the doctor's browser calls the connector directly (hospital network or VPN,
  or a hospital-controlled HTTPS endpoint) for names, MRNs and history. Patient identity never
  passes through NeuroCapture servers.
- **Videos:**
  - The phone uploads encrypted files straight to the hospital bucket, through upload links our
    API creates with a narrow, upload-only role the hospital grants.
  - Each take's data key is wrapped with the **hospital's** public key. Only the connector holds
    the private key (or the hospital's KMS), and it decrypts for that hospital's doctors.
- **Activity log:** clinical actions are written to the hospital's database or log server through
  the connector. Examples: viewed a recording, invited, reviewed, changed a plan.
- **Biomarker results** (later) are written back under the NCID.
- **Invites:**
  - E-mail with QR and link is the default, free, sent from the hospital's mail settings or ours.
  - SMS is optional, paid by the hospital, and needs its TRAI DLT sender ID and templates.
  - A printed QR code for visits.
  - Every invite is single-use and expires after 7 days.
- **Health checks:** the onboarding wizard tests records with one sample MRN, does a test upload
  and writes a test log entry. NeuroCapture sees pass or fail only.
- **Resilience:** if the hospital system is unreachable, the doctor view says so and recordings
  still open; uploads and log writes queue until it is back.

## 4. What the NeuroCapture platform stores

- Hospitals: type, region, modules, connector address, storage and key configuration
  references (no secrets in clear), status, who onboarded them and when.
- Accounts: platform admins, hospital admins, doctors, operators (credentials hashed), patient
  app accounts (NCID + PIN hash + device), roles.
- Phones: registrations, revocations, tier.
- Sessions and takes **by NCID**: test, timing, capture verdict, quality and readiness (no
  identity), upload state, the object key in the hospital bucket.
- Platform activity and security log: sign-ins, onboarding, admin actions, phone registrations.
  Crash reports.

## 5. Milestones (after M9 acceptance on the phone)

### M10 — Tenancy, roles and identity core

- Platform data model: hospitals (BYO / managed), accounts with roles, NCID, platform audit log.
- Dashboard sign-in with two-step (TOTP); operator ID + password (replaces operator PIN);
  patient account by NCID + PIN, bound to the phone.
- Migration of M7 data: `patients.ref_hash` → NCID; `operator_code + PIN` → ID + password.
  **Accept:**
- Every API call is scoped to one hospital; a test proves no cross-hospital read.
- No table holds a name, MRN, e-mail or phone number of a patient.

### M11 — Hospital connector

- A separate service (`connector/`, Python, Docker): FHIR and SQL-view adapters, NCID map,
  invites (e-mail QR, SMS via a provider abstraction, print), clinical activity log sink, key
  holder and decrypt/stream for doctors, health-check endpoints.
- Contract between platform and connector (`contracts/connector-api.yaml`); mutual TLS or signed
  requests.
- A managed deployment of the same image per clinic.
  **Accept:**
- Against a FHIR test server and a sample SQL schema: live lookup, invite → NCID creation,
  activity-log write, decrypt of a phone-encrypted take.
- Nothing about patient identity is written outside the connector's database.

### M12 — Per-hospital storage and keys

- Upload links into the hospital's bucket (S3 / Azure Blob / GCS) through a delegated
  upload-only role; managed buckets per clinic.
- The phone receives the hospital's public key for the session and wraps take keys with it.
  Key rotation.
  **Accept:**
- A take recorded on the phone is readable only by that hospital's connector.
- Two hospitals' takes cannot be read with each other's keys.

### M13 — Android app modes

- Role chooser; clinic phones locked to operator mode after registration.
- Patient flow:
  - accept an invite (QR, link, SMS code) → PIN → consent;
  - home with the doctor's plan (tests, how often, OFF/ON medicine);
  - home session with helper guidance for SAW and the "self-recorded" mark;
  - recordings and upload status; withdraw consent / ask for deletion.
- Operator sign-in with ID + password; auto-lock.
  **Accept:**
- A patient accepts an e-mail invite and uploads a full home session.
- A clinic phone cannot open patient mode.
- e2e for both flows in mock mode.

### M14 — Web dashboards

- One web app (React, same design tokens), deployable as static files plus the existing API.
- Platform admin: hospitals, onboarding wizard with the connector, storage and log tests,
  platform log.
- Hospital admin: data connections and health, phones (QR / code registration), operators,
  doctors, patients listed live from the connector, invites, hospital activity log.
- Doctor: my patients (live), patient history (live, never stored), recordings
  (decrypted by the connector), review (usable / not usable, note kept at the hospital),
  re-record request, plan editor.
  **Accept:**
- A doctor views a patient's live history and a recording while NeuroCapture's database and
  logs contain no name or MRN, checked by a test that scans them.

### M15 — Biomarker analysis (later)

Server keypoint extraction on the 60 fps video, then the registry formulas (REG@0.3.0). Results
are written to the hospital under the NCID. The report is labelled decision support, not a
diagnosis. Started in `biomarkers/` (decision 057, docs/biomarkers.md).

### M16 — iOS (was M10)

Unchanged.

## 6. Open items for the owner

- Mail sender for invites: the hospital's SMTP or our provider (domain verification).
- SMS provider and DLT registration per hospital that wants SMS.
- Hosting region and provider for the platform and for managed clinics.
- First pilot hospital's systems: does their HIS offer FHIR? Who is their IT contact?
