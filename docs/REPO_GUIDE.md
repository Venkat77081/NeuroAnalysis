# Repository guide: what each folder and file does

NeuroCapture is one repository (a "monorepo") with five deliverables:

| Deliverable                | Folder                            | Language                          | Runs on                            |
| -------------------------- | --------------------------------- | --------------------------------- | ---------------------------------- |
| Android app                | `apps/mobile`                     | React + TypeScript, Kotlin plugin | Clinic phones and patients' phones |
| Web dashboards             | `apps/dashboard`                  | React + TypeScript                | Browsers (static files)            |
| Platform API               | `backend`                         | Python (FastAPI) + PostgreSQL     | Your server                        |
| Hospital connector         | `connector`                       | Python (FastAPI)                  | Each hospital's server             |
| Shared rules and contracts | `config`, `contracts`, `packages` | JSON, TypeScript                  | Built into all of the above        |

To deploy, see [`PRODUCTION.md`](PRODUCTION.md). To test locally, see
[`qa/testing-guide.md`](qa/testing-guide.md).

```
neuroanalysis/
├── apps/
│   ├── mobile/          Android app (React UI in a WebView + native Android project)
│   └── dashboard/       Web dashboards for platform admin, hospital admin, front desk, doctors
├── packages/
│   ├── capture-kit/     Camera, recording, tracking, encryption and upload (Kotlin + TS mock/webcam)
│   ├── quality-core/    Pure TypeScript quality rules and movement detectors (no DOM, no Android)
│   └── contracts-ts/    TypeScript types generated from /contracts + the validator CLI
├── backend/             Platform API (FastAPI), database models and migrations, analysis helpers
├── connector/           Hospital connector (FastAPI): patient records, NCID map, decryption
├── config/              Every protocol value, threshold, rule and message text (JSON)
├── contracts/           JSON Schemas and the connector OpenAPI: the agreed data formats
├── tools/               Developer tools: model download, replay, device qualification
├── docs/                Plans, decisions, assumptions, QA guides, deployment
├── .github/workflows/   CI (every push) and the signed Android release
└── (root files)         Workspace, lint, format and Docker set-up
```

---

## Root files

| File                                                      | Purpose                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE.md`                                               | Working rules for this project, agreed product decisions, common commands                                                |
| `DEV_PLAN.md`                                             | The full development plan (milestones M0–M10, requirements, acceptance criteria)                                         |
| `package.json`                                            | Workspace scripts: `pnpm test`, `lint`, `typecheck`, `validate`, `e2e`, `build:web`, `build:dashboard`, `models`, …      |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml`                   | Which folders are JavaScript packages; exact dependency versions                                                         |
| `tsconfig.base.json`                                      | Shared TypeScript settings                                                                                               |
| `eslint.config.js`, `.prettierrc.json`, `.prettierignore` | Lint and formatting rules                                                                                                |
| `.nvmrc`                                                  | Node version (22)                                                                                                        |
| `docker-compose.yml`                                      | **Local development only:** API + PostgreSQL (+ optional storage and connector). Dev passwords; never use in production. |
| `.gitignore`                                              | Files kept out of git (builds, keys, databases)                                                                          |

## `.github/workflows/`

| File          | Purpose                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | On every push or PR: contracts, lint, format, typecheck, unit tests, app e2e, Android debug build and Kotlin tests, backend tests and migrations on PostgreSQL, connector tests and Docker image, dashboard e2e against the real platform and connector |
| `release.yml` | Manual **Release (pilot)**: tests, production web build, signed AAB and APK, optional Firebase distribution (`docs/release.md`)                                                                                                                         |

---

## `config/`: rules, thresholds and texts (no code)

Everything a clinician or product owner may want to change lives here, never in code.

- **The app** has these files built in, so a change needs a new APK.
- **The API** reads them from a mounted folder, so a change needs a restart.
- `pnpm validate` checks every file against its schema in `contracts/`.

| File                                                          | Contents                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.json`                                                | Session flow: test order, skip, abort and keep reasons, medicine states, consent version, fps limit options, **upload settings (`defaultEndpoint` = production API address)**, storage limits, thermal policy    |
| `tests/FT.json`, `FTF.json`, `FR.json`, `SAW.json`, `FA.json` | One file per test (finger tapping, finger-to-finger, fist open/close, walking, foot agility): duration, camera, positioning, detector parameters, instructions                                                   |
| `quality.json`                                                | Live and recorded quality checks: what makes a take PASS or RETAKE                                                                                                                                               |
| `platform.json`                                               | Platform rules: invite lifetimes, PIN and password rules, **role permission defaults**, request windows, clinic queue, not-recorded reasons, **camera check (55 fps, borderline below 59, 30-day takes column)** |
| `biomarker-registry.json`                                     | Which biomarkers exist and what each needs from a take (readiness)                                                                                                                                               |
| `device-tiers.json`                                           | Device qualification tiers (A, B, C) from the benchmark                                                                                                                                                          |
| `messages/en.json`                                            | Server-side message texts (staff invites, role names)                                                                                                                                                            |

## `contracts/`: agreed data formats

| File                                                                                | Describes                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `session-config`, `test-config`, `quality-config`, `platform-config` `.schema.json` | The files in `config/`                                                                          |
| `quality.schema.json`, `meta.schema.json`                                           | `quality.json` and `meta.json` written with every take                                          |
| `stream-header`, `landmarks-header` `.schema.json`                                  | Binary sensor and landmark streams recorded with a take                                         |
| `benchmark-report.schema.json`, `device-tiers.schema.json`                          | Phone qualification benchmark and tiers                                                         |
| `biomarker-registry.schema.json`                                                    | The biomarker registry                                                                          |
| `connector-api.yaml`                                                                | OpenAPI of the hospital connector (generated: `cd connector && python -m scripts.gen_contract`) |
| `tests/valid/…`, `tests/invalid/…`                                                  | Sample files that must pass or fail validation                                                  |

---

## `apps/mobile/`: the Android app

A React app (Vite) shown in a WebView by **Capacitor**. Camera, recording, encryption and
upload run natively in `packages/capture-kit`, so recordings keep going even if the web part is
slow or reloads.

| Path                           | Purpose                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capacitor.config.ts`          | App ID `com.neurocapture.app`, name, WebView settings                                                                                                                                                        |
| `vite.config.ts`, `index.html` | Web build                                                                                                                                                                                                    |
| `android/`                     | The native Android project (Gradle). `app/build.gradle` holds the version and release signing (from environment variables); `AndroidManifest.xml` holds the permissions and the `neurocapture://invite` link |
| `e2e/`                         | Playwright tests in mock mode (operator, patient, QR, camera check, clinic queue, …)                                                                                                                         |
| `test/`                        | Unit tests (Vitest)                                                                                                                                                                                          |

`apps/mobile/src/`:

| Path                                                                                | Purpose                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tsx`, `App.tsx`                                                               | Start-up and top-level screens (role chooser → clinic or patient mode)                                                                |
| `app/AppContext.tsx`                                                                | App-wide state: config, settings, session, starting sessions (including clinic-queue ones)                                            |
| `app/Gate.tsx`                                                                      | Lock screen and sign-in gate                                                                                                          |
| `session/machine.ts`                                                                | The recording session state machine (XState): plan → consent → each test → take → review → summary                                    |
| `session/persist.ts`, `useSession.ts`                                               | Saves the session (encrypted) after every step; React hook                                                                            |
| `data/store.ts`, `repo.ts`                                                          | Encrypted key–value store on the phone; patients, settings                                                                            |
| `lib/config.ts`                                                                     | Loads and validates all `config/` files at start-up                                                                                   |
| `lib/capture.ts`, `camera-owner.ts`                                                 | Chooses the capture implementation (native, webcam, mock) and owns the camera                                                         |
| `lib/uploads.ts`                                                                    | Phone registration, operator sign-in, session, take and close bodies for the server, queueing uploads                                 |
| `lib/accounts.ts`                                                                   | Operator passwords, the connector NCID lookup, patient invites, PIN, "Tell my hospital"                                               |
| `lib/devicecheck.ts`                                                                | Camera check before a phone is added (decision 035)                                                                                   |
| `lib/hospitals.ts`                                                                  | A patient's hospitals (one sign-in and upload profile per hospital)                                                                   |
| `lib/clinic.ts`                                                                     | The clinic phones' daily queue (names and MRNs read live from the connector)                                                          |
| `lib/evidence.ts`, `take-analysis.ts`                                               | `quality.json` and `meta.json` for each take; quality evaluation of a recorded take                                                   |
| `lib/thermal.ts`, `device-tier.ts`                                                  | Thermal policy (lower analysis rate, never recording fps); device tier                                                                |
| `lib/logger.ts`, `crash.ts`                                                         | Logging with PII redaction; privacy-safe crash reports                                                                                |
| `lib/deeplink.ts`, `qr.ts`                                                          | Invite links and QR codes                                                                                                             |
| `lib/debug-flags.ts`, `m2-acceptance.ts`, `m4-acceptance.ts`, `orientation-pref.ts` | Engineering switches and milestone acceptance helpers; UI preferences                                                                 |
| `screens/modes/`                                                                    | Role chooser, clinic phone set-up (camera check → code), operator sign-in, password change, shared form parts                         |
| `screens/patient/`                                                                  | Patient app: join with an invite (camera check → PIN), my hospitals, requests, history, QR scanner                                    |
| `screens/session/`                                                                  | Recording flow: session home, clinic queue, test intro, camera stage (live checks), review (Keep this take…), timeline, skip, summary |
| `screens/*.tsx` (top level)                                                         | Engineering tools hidden in production: camera test, capture test, tracking test, device qualification, server set-up                 |
| `overlays/`                                                                         | Drawing on the camera view: landmarks, hand and body outlines, level indicator, replay overlay                                        |
| `guidance/`                                                                         | Spoken instructions (text to speech)                                                                                                  |
| `i18n/en.json`, `hi.json`                                                           | All app texts in English and Hindi                                                                                                    |
| `ui/kit.tsx`                                                                        | Buttons, cards and other large-touch-target UI parts                                                                                  |

## `apps/dashboard/`: the web dashboards

One web app; what each person sees depends on their role and their hospital's permissions.

| Path                              | Purpose                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/config.json`              | **The API address** (`apiUrl`). Edit it in `dist/` after building for production                                                                         |
| `src/App.tsx`, `main.tsx`         | Start-up, menu by role                                                                                                                                   |
| `src/auth.tsx`                    | Sign-in: invite link → password → two-step code                                                                                                          |
| `src/api.ts`                      | Calls to the platform API and, with a short-lived token, to the hospital connector                                                                       |
| `src/perms.ts`, `permissions.tsx` | What the signed-in person may do; the platform admin's per-hospital permissions page                                                                     |
| `src/platform.tsx`                | Platform admin: onboard and suspend hospitals, set-up status, platform activity log                                                                      |
| `src/hospital.tsx`                | Hospital admin: overview, data connections (connector, keys, storage), team, **phones (camera check, takes in use)**                                     |
| `src/activity.tsx`                | Activity log by person (name, e-mail, role), filters, CSV                                                                                                |
| `src/invites.tsx`                 | Front desk: search the hospital records, send join invites (e-mail, SMS, printed QR)                                                                     |
| `src/appointments.tsx`            | Front desk: add appointments by hand, assign doctors, history of each appointment, "phone not suitable"                                                  |
| `src/assign.tsx`                  | Front desk: assign and reassign patients to doctors                                                                                                      |
| `src/choose.tsx`                  | Doctor: choose tests and where to record (home link, clinic queue, both)                                                                                 |
| `src/doctor.tsx`                  | Doctor: my patients, live history, recordings (decrypted by the connector), reviews, plans                                                               |
| `src/config.ts`                   | Values shared with `config/platform.json`                                                                                                                |
| `src/ui.tsx`, `i18n/`             | UI parts; English texts                                                                                                                                  |
| `e2e/`                            | Playwright tests against a real platform + connector + FHIR stand-in (`e2e/stack/run_stack.py`), then a scan that the platform holds no patient identity |

---

## `packages/`: shared libraries

### `packages/capture-kit/`: camera, recording and upload

A Capacitor plugin with three implementations behind one interface (`src/definitions.ts`):

- **native:** Kotlin, for real phones;
- **webcam:** the browser camera, for development;
- **mock:** a replayed fixture plus a fake server, for tests.

| Path                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/definitions.ts`                         | The plugin API: open camera, record, tracking, benchmark, evidence, uploads, app mode, secure store                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/index.ts`                               | Picks the implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/mock.ts`, `fixture.ts`                  | Mock camera for tests and e2e (speed-up, scenarios, simulated benchmark fps)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/webcam.ts`, `frame-math.ts`             | Browser webcam implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/upload/protocol.ts`                     | The upload protocol shared with Kotlin (allowed API paths, steps)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/upload/fake-server.ts`                  | In-memory imitation of the platform and connector for mock mode and tests                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/landmarks.ts`, `codec.ts`, `streams.ts` | Landmark and sensor stream formats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `android/…/capturekit/`                      | Native Android code. Main files: `CaptureKitPlugin.kt` (bridge), `CameraSession.kt` (Camera2 at 60 fps), `Tracking.kt` (MediaPipe), `TakeFinalizer.kt` / `TakeVault.kt` (finish and keep takes), `KeyWrap.kt` (encrypt each take for the hospital's key), `UploadQueue.kt` / `Uploads.kt` / `UploadProtocol.kt` (WorkManager uploads that survive app restarts), `Benchmark.kt` (camera check and qualification), `SecureStore.kt`, `AppMode.kt` (clinic or patient lock), `SensorCapture.kt`, `CrashReporter.kt`, … |
| `ios/README.md`                              | iOS is not built (placeholder)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `fixtures/`, `scripts/`, `test/`             | Recorded sample takes, helper scripts, tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### `packages/quality-core/`: quality rules (pure TypeScript)

No DOM, no Android, no Node-only APIs, so the same code runs in the app, in tests and in
`tools/replay`. All public functions have unit tests.

| Path                | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `src/checks/`       | Individual quality checks (framing, distance, lighting, landmarks present, fps, …)   |
| `src/engine/`       | Rule engine: runs the checks from `config/quality.json`, prompts and the record gate |
| `src/detectors/`    | Movement detectors per test (taps, fist cycles, steps, …) and signal helpers         |
| `src/verdict/`      | PASS or RETAKE with reasons for a finished take; readiness from recorded evidence    |
| `src/device/`       | Device qualification assessment (tiers)                                              |
| `src/synthetic*.ts` | Synthetic takes for tests                                                            |

### `packages/contracts-ts/`: types and validator

| Path                                                     | Purpose                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/gen.ts`                                         | Generates `src/generated/*.ts` from `contracts/*.schema.json` (`pnpm contracts:gen`) |
| `src/generated/`                                         | Generated TypeScript types; do not edit by hand                                      |
| `src/validate.ts`, `semantic.ts`, `schemas.ts`, `cli.ts` | Schema and cross-field validation; `pnpm validate`                                   |

---

## `backend/`: the platform API

FastAPI + SQLAlchemy + Alembic. Docker image: `backend/Dockerfile`, which runs the migrations,
then serves on port 8000. Settings: `NC_*` environment variables (`app/config.py`).

| Path                                                   | Purpose                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `app/main.py`                                          | Creates the API, CORS, routers                                                                                                |
| `app/config.py`                                        | **Every setting** with its default (database, storage, keys, CORS, providers, …)                                              |
| `app/db.py`                                            | Database connection                                                                                                           |
| `app/models/__init__.py`                               | **All database tables** (see `PRODUCTION.md` §3.1)                                                                            |
| `alembic/versions/0001…0017`                           | Database migrations; applied automatically on start                                                                           |
| `app/security.py`                                      | Passwords, PINs, two-step codes, tokens, roles                                                                                |
| `app/permissions.py`                                   | Per-hospital role permissions (defaults from `config/platform.json`)                                                          |
| `app/signing.py`                                       | Signed requests and tokens between the platform and connectors (Ed25519)                                                      |
| `app/keys.py`, `hospital_keys.py`                      | Server take key (legacy and fallback); hospitals' public take keys                                                            |
| `app/storage/`                                         | Recording storage: local disk or S3 (presigned multipart), per-hospital buckets                                               |
| `app/audit.py`, `people.py`                            | Audit events; the person (name, e-mail, role) behind each event                                                               |
| `app/policy.py`                                        | Reads `config/platform.json` and `config/messages/`                                                                           |
| `app/providers.py`                                     | E-mail and SMS sending (**dummy only for now**; see `PRODUCTION.md` B1)                                                       |
| `app/camera_check.py`                                  | Camera check rules for adding phones                                                                                          |
| `app/assignments.py`                                   | Doctor ↔ patient access checks                                                                                                |
| `app/readiness.py`                                     | Biomarker readiness for stored takes                                                                                          |
| `app/admin.py`                                         | Command line: `python -m app.admin create-platform-admin --email …` (first admin), plus dev helpers                           |
| `app/api/health.py`                                    | `GET /health`                                                                                                                 |
| `app/api/auth.py`                                      | Phone registration (with camera check), operator sign-in, token refresh, connector tokens                                     |
| `app/api/staff.py`                                     | Dashboard sign-in: invite, password, two-step                                                                                 |
| `app/api/platform.py`                                  | Platform admin: hospitals, permissions, platform log                                                                          |
| `app/api/hospital.py`                                  | Hospital admin: team, phones (with check and takes in use), patients, invites, activity                                       |
| `app/api/hospital_storage.py`                          | Where a hospital's recordings are stored                                                                                      |
| `app/api/connector_link.py`                            | Everything the connector calls (signed): NCIDs, invites, health checks, reminders                                             |
| `app/api/patient.py`                                   | Patient app: invite, PIN, join, phone not suitable, withdraw                                                                  |
| `app/api/requests.py`                                  | Appointments and recording requests (home and clinic)                                                                         |
| `app/api/clinic.py`                                    | The clinic phones' daily queue; "not recorded" reasons                                                                        |
| `app/api/assignments.py`, `plans.py`                   | Doctor assignment; recording plans and patient history                                                                        |
| `app/api/sessions.py`, `takes.py`, `storage_local.py`  | Sessions, takes, resumable uploads with SHA-256 checks                                                                        |
| `app/api/readiness.py`, `diagnostics.py`, `devices.py` | Readiness reports, privacy-safe crash reports, device info                                                                    |
| `analysis/`                                            | Server-side helpers: decrypt a take (development keys), landmark reader, readiness. **Biomarker formulas are not built yet.** |
| `tests/`                                               | Pytest suites (tenancy, patient app, uploads, connector link, readiness, …)                                                   |
| `neurocapture_backend.egg-info/`                       | Packaging leftovers committed by mistake; safe to delete                                                                      |

## `connector/`: the hospital connector

Runs at each hospital. It is the only part that sees patient identity. Settings: `NCC_*`
environment variables (`ncconnector/config.py`). Set-up: [`connector.md`](connector.md).

| Path                                               | Purpose                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                                       | Image, port 8100                                                                                                      |
| `ncconnector/main.py`                              | The connector API: patient search, lookup, history, invites, recordings (decrypt), reviews, activity log, health      |
| `ncconnector/config.py`                            | **Every setting** with its default                                                                                    |
| `ncconnector/db.py`                                | Its own database: `nc_ncid_map`, `nc_activity_log`, `nc_reviews`, `nc_log_spool`, `nc_used_nonces` (created on start) |
| `ncconnector/records/fhir.py`, `sql.py`            | Read patient records live from FHIR R4 or from the SQL views                                                          |
| `ncconnector/auth.py`                              | Who may call: tokens from the platform, with role and permissions                                                     |
| `ncconnector/platform.py`, `signing.py`, `keys.py` | Signed calls to the platform, key pinning, its signing key and the hospital take keys                                 |
| `ncconnector/takecrypto.py`, `storage.py`          | Decrypt recordings; read them from the hospital's own S3 bucket                                                       |
| `ncconnector/activity.py`                          | Clinical activity log (database or the hospital's log server, with a spool)                                           |
| `ncconnector/providers.py`, `messages/`            | Invite and reminder delivery (**dummy only for now**) and texts                                                       |
| `ncconnector/reminders.py`                         | Sends "please record by …" reminders                                                                                  |
| `ncconnector/__main__.py`                          | Command line: `keygen`, `rotate-take-key`, `take-keys`, `send-reminders`, `flush-log`, `openapi`                      |
| `sql/sample_views.sql`                             | The four views a hospital creates if it has no FHIR server                                                            |
| `scripts/gen_contract.py`                          | Regenerates `contracts/connector-api.yaml`                                                                            |
| `tests/`                                           | Pytest suites, including end-to-end tests against the platform in one process and a fake FHIR server                  |

---

## `tools/`

| Folder                  | Purpose                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `models/`               | `fetch-models.mjs` downloads the MediaPipe models into the app (`pnpm models`); `models.json` pins versions and checksums |
| `replay/`               | Re-runs quality checks on a recorded take (`pnpm replay`), to compare phone and server results                            |
| `device_qualification/` | Reads benchmark reports and assigns device tiers; `reports/` holds measured phones                                        |

## `docs/`

| Path                                                 | Contents                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `PRODUCTION.md`                                      | How to deploy: servers, databases, connector, dashboard, APK                                |
| `REPO_GUIDE.md`                                      | This file                                                                                   |
| `PLATFORM_PLAN.md`                                   | The platform plan: hospital-owned data, roles, milestones M10–M14                           |
| `connector.md`, `dashboard.md`, `release.md`         | Set-up of the connector, the dashboards and Android releases                                |
| `decisions/NNN-*.md`                                 | One file per significant decision (000 is the template, 001–037 so far)                     |
| `assumptions.md`                                     | Every assumption made where the requirements were unclear (A1–A109), with who should review |
| `mockups.md`                                         | Links to the agreed UI mockups                                                              |
| `protocols/`, `dne-coverage.md`                      | The DNE clinical protocol and biomarker definitions; how the app covers them                |
| `qa/testing-guide.md`                                | How to test everything locally and on a phone, with the full test list                      |
| `qa/pre-pilot-test-plan.md`, `qa/m*-device-tests.md` | Device test plans and results per milestone                                                 |
| `traceability/matrix.md`                             | Requirement → code → test mapping                                                           |
