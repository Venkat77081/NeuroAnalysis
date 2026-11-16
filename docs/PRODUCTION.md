# Production deployment guide

This guide explains how to run NeuroCapture for real hospitals. It covers:

- the servers;
- the databases;
- the hospital connector;
- the dashboards;
- the Android app.

Read section 1 first: some features are not ready for production yet.

For what each folder and file does, see [`REPO_GUIDE.md`](REPO_GUIDE.md).

---

## 0. What runs where

```
 ┌──────────────── YOU (NeuroCapture) ────────────────┐      ┌──────── EACH HOSPITAL / CLINIC ("client") ───────┐
 │                                                     │      │                                                   │
 │  HTTPS proxy (Caddy / nginx / load balancer)        │      │  Hospital connector (Docker, port 8100, HTTPS)    │
 │    ├─ api.<your-domain>        → API container      │◄────►│    ├─ connector database (Postgres): NCID↔MRN map, │
 │    └─ dashboard.<your-domain>  → static files       │signed│    │   activity log, reviews                       │
 │                                                     │ API  │    ├─ take keys (decrypt recordings)               │
 │  PostgreSQL  (platform database: 22 tables)         │      │    └─ reads patient records LIVE from:            │
 │  S3 bucket   (encrypted recordings)                 │      │         FHIR R4 server  OR  4 read-only SQL views  │
 └─────────────────────────────────────────────────────┘      └───────────────────────────────────────────────────┘
          ▲                         ▲                                         ▲
          │ HTTPS                   │ HTTPS                                   │ HTTPS (hospital network / VPN)
   Android app (APK)         Web dashboards (browser)  ───────────────────────┘
   clinic phones + patients  platform admin, hospital admin, front desk, doctors
```

- **The platform** is yours. It knows patients only by a random **NCID**. It stores accounts,
  phones, appointments, recording requests and **encrypted** recordings. It can never decrypt
  them (decisions 023, 027).
- **The connector** belongs to the hospital and runs inside its network. It is the only part
  that sees names, MRNs, contact details and medical history, and the only part that can
  decrypt recordings.
- **The dashboard** runs in the browser. It calls the platform for accounts and workflow, and
  calls the hospital's connector directly for names, history and videos.
- **The Android app** uploads recordings to the platform. Each one is encrypted with that
  hospital's own key.

---

## 1. Is the code ready for production?

You can deploy this repository: it has Dockerfiles, database migrations, CI and a signed
release workflow. Some pieces are **not finished yet**.

### Must be done before real patients

| #   | Gap                                                                                                                                                                                              | Effect today                                                                                                                                                                                                                                     | What to do                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | **E-mail and SMS sending are stubs.** `backend/app/providers.py` and `connector/ncconnector/providers.py` only support `dummy`, which keeps messages in memory and sends nothing (decision 024). | Staff invites (hospital admins, doctors, front desk) are **never delivered**. Patient invites by e-mail or SMS and record-by reminders are not sent. **Printed QR invites work.** The first platform admin works too: the CLI prints their link. | Add a real e-mail provider (SMTP or Amazon SES) to the platform and the connector, and an SMS provider (for example MSG91 or Twilio) to the connector. A small, well-contained change behind the existing `send_email` / `send_sms` functions. Ask to have it built.           |
| B2  | **The app's default server is the test server** (`config/session.json` → `upload.defaultEndpoint` is `fake://api`).                                                                              | A release app would make every user type the server address.                                                                                                                                                                                     | Set it to `https://api.<your-domain>` before building the release (section 6.1).                                                                                                                                                                                               |
| B3  | **The release branch is not merged.** `main` only has milestones M0–M3; everything since is on `claude/v3-appointments` ([PR #3](https://github.com/Venkat77081/NeuroAnalysis/pull/3)).          | Deploying `main` would deploy an old version.                                                                                                                                                                                                    | Review and merge PR #3, then build releases from `main` (or from a tag such as `v1.0.0`).                                                                                                                                                                                      |
| B4  | **Clinical and legal approvals** (not code).                                                                                                                                                     | —                                                                                                                                                                                                                                                | Ethics approval for the study, patient consent wording (`config/session.json` → `consentVersion`), a data-processing agreement with each hospital, a privacy policy (Play Store requires one), and compliance with India's DPDP Act 2023. Check these with your legal advisor. |

### Not built yet (does not block recording)

- **Biomarker computation at the hospital:** only readiness checks exist (`backend/analysis/`).
  The formulas (DNE and the JBHI 2024 FA appendix) still need to run next to the connector.
- **https invite links:** invites open the app with the custom scheme
  `neurocapture://invite?t=…`. Some e-mail apps do not make that clickable, so patients scan
  the QR code or paste the code. Android App Links would fix this.
- **Device management for clinic phones** (MDM, kiosk mode) is not part of this repository.

---

## 2. Choose where to host the platform

Any cloud or a hospital-grade data centre works. The code defaults to AWS **ap-south-1
(Mumbai)**, which keeps data in India. A simple, sensible production layout:

| Part              | Recommended                                                                                       | Minimum for a pilot                               |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Platform database | Amazon RDS for PostgreSQL 16, Multi-AZ, automated backups, encryption on                          | PostgreSQL 16 on the same VM, nightly dump        |
| Recordings        | Amazon S3 bucket (private, encryption on, versioning on)                                          | Local disk on the API server (`NC_STORAGE=local`) |
| API               | 2 × containers (ECS Fargate or 2 VMs) behind an Application Load Balancer with an ACM certificate | 1 VM (2 vCPU, 4 GB RAM) with Docker and Caddy     |
| Dashboard         | S3 + CloudFront, or the same Caddy                                                                | Same Caddy as the API                             |
| DNS               | `api.<your-domain>`, `dashboard.<your-domain>`                                                    | Same                                              |

The rest of this guide uses the **single-VM pilot layout**. Each step is the same on the
bigger layout.

---

## 3. The platform server (yours)

### 3.1 Database: what to create

You create **one empty PostgreSQL database and one user**. You do **not** create tables by
hand: the API container runs `alembic upgrade head` on every start, which creates and upgrades
all tables (migrations `0001` to `0017` in `backend/alembic/versions/`).

```sql
-- as the Postgres admin user
CREATE USER neurocapture WITH PASSWORD '<long random password>';
CREATE DATABASE neurocapture OWNER neurocapture;
```

Tables that the migrations create (for reference). **None of them holds a patient's name, MRN,
phone number or address.** A test enforces this: `test_no_patient_identity_columns`.

| Table                                                   | Holds                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sites`                                                 | Hospitals and clinics: name, status, modules, data mode, per-hospital permissions, connector address and key |
| `staff_users`, `staff_refresh_tokens`                   | Dashboard accounts (platform admin, hospital admin, front desk, doctor) and their sign-ins                   |
| `operators`, `refresh_tokens`                           | Clinic phone operators (ID, name, password hash) and their sign-ins                                          |
| `devices`, `device_enrollments`                         | Registered phones (model, camera check fps) and one-time registration codes                                  |
| `patients`                                              | A patient per hospital, by NCID only                                                                         |
| `patient_accounts`, `patient_refresh_tokens`            | A patient's app account (PIN hash, status) and sign-ins                                                      |
| `patient_assignments`                                   | Which doctor a patient is assigned to                                                                        |
| `appointments`, `recording_requests`, `recording_plans` | Appointments (time, doctor), "please record these tests" requests (home or clinic), repeat plans             |
| `sessions`, `takes`, `take_files`                       | Recording sessions, takes (verdict, quality numbers), uploaded files (size, checksum, where stored)          |
| `site_keys`                                             | Each hospital's **public** take key; its private key never leaves the hospital                               |
| `biomarker_runs`                                        | Readiness results per take                                                                                   |
| `deletion_requests`                                     | Deletion requests from phones before v3                                                                      |
| `audit_events`                                          | Who did what, when (by person: name, e-mail and role for staff)                                              |
| `used_nonces`                                           | Replay protection for signed connector calls                                                                 |

### 3.2 Keys and secrets to generate (once)

Do this on a secure machine, then copy the files to the server's `/srv/nc/keys` (owner root,
mode `600`, readable by the container).

```bash
mkdir -p keys && cd keys
# 1. Platform signing key (Ed25519): signs connector requests and tokens. Connectors pin its fingerprint.
openssl genpkey -algorithm ed25519 -out platform-signing.pem
# 2. Server take key (RSA 3072): phones receive its public half at registration (legacy and fallback).
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out server-private.pem
openssl pkey -in server-private.pem -pubout -out server-public.pem
# 3. Token secret
openssl rand -hex 32        # → NC_JWT_SECRET
```

Store copies of these files in a password manager or secrets manager.

- **If `platform-signing.pem` is lost or changed,** every hospital must re-pin its connector.
- **Never keep `server-private.pem` on a server in production.** Leave
  `NC_SERVER_PRIVATE_KEY_PATH` empty; recordings are protected by each hospital's own key
  (decision 027).

### 3.3 Environment file: `/srv/nc/api.env`

All platform settings are environment variables starting with `NC_`. They are defined in
`backend/app/config.py`, which also lists every default.

```bash
# --- Database ---
NC_DATABASE_URL=postgresql+psycopg://neurocapture:<password>@<db-host>:5432/neurocapture

# --- Public addresses ---
NC_PUBLIC_BASE_URL=https://api.example.in
NC_DASHBOARD_URL=https://dashboard.example.in
# Dashboard origin + the Android app's WebView origin (keep https://localhost)
NC_CORS_ORIGINS=https://dashboard.example.in,https://localhost

# --- Secrets and keys ---
NC_JWT_SECRET=<output of openssl rand -hex 32>
NC_PLATFORM_SIGNING_KEY_PATH=/keys/platform-signing.pem
NC_PLATFORM_KEY_ID=platform-1
NC_SERVER_PUBLIC_KEY_PATH=/keys/server-public.pem
NC_SERVER_KEY_ID=server-1

# --- Recordings storage ---
# Pilot on one VM:
NC_STORAGE=local
NC_STORAGE_DIR=/data/storage
# Production on S3 (use the server's IAM role: leave the access keys empty):
# NC_STORAGE=s3
# NC_S3_BUCKET=neurocapture-takes-prod
# NC_S3_REGION=ap-south-1
# NC_MANAGED_BUCKET_TEMPLATE={bucket}
# NC_PLATFORM_AWS_PRINCIPAL=arn:aws:iam::<your-account-id>:role/neurocapture-api   # hospitals with their own bucket trust this

# --- Safety switches (keep these values in production) ---
NC_REQUIRE_HOSPITAL_KEY=true
NC_ALLOW_LEGACY_REF_HASH=false

# --- Messages (see section 1, B1) ---
NC_EMAIL_PROVIDER=dummy
NC_SMS_PROVIDER=dummy
NC_INVITE_LINK_BASE=neurocapture://invite?t=

# --- Rules, thresholds, texts (repo config/, mounted read-only) ---
NC_CONFIG_DIR=/srv/config
```

### 3.4 Build and run the API

On the server (Ubuntu 24.04 with Docker installed):

```bash
git clone https://github.com/Venkat77081/NeuroAnalysis.git /srv/nc/src
cd /srv/nc/src && git checkout main          # after PR #3 is merged (or a release tag)
docker build -t neurocapture-api:1.0.0 backend/

docker run -d --name nc-api --restart unless-stopped \
  --env-file /srv/nc/api.env \
  -v /srv/nc/keys:/keys:ro \
  -v /srv/nc/src/config:/srv/config:ro \
  -v nc-storage:/data/storage \
  -p 127.0.0.1:8000:8000 \
  neurocapture-api:1.0.0

curl -s http://127.0.0.1:8000/health      # → {"status":"ok", ...}
```

The container runs the migrations, then starts the API on port 8000. Only the HTTPS proxy
should reach it, which is why it binds to `127.0.0.1`.

If PostgreSQL runs on the same VM, start it with Docker too (`postgres:16-alpine`, a named
volume, a strong password), or install it from the Ubuntu packages.

### 3.5 HTTPS

Phones and browsers only talk HTTPS (release builds refuse plain http). The simplest option
is **Caddy**, which gets and renews certificates automatically. `/srv/nc/Caddyfile`:

```
api.example.in {
    reverse_proxy 127.0.0.1:8000
    request_body {
        max_size 64MB
    }
}

dashboard.example.in {
    root * /srv/nc/dashboard
    try_files {path} /index.html
    file_server
}
```

On AWS, use an Application Load Balancer with an ACM certificate instead.

### 3.6 First platform admin

```bash
docker exec -it nc-api python -m app.admin create-platform-admin --email you@yourdomain --name "Your Name"
```

The command prints a one-time invite link. Open it, choose a password and set up two-step
sign-in with an authenticator app. From then on, everything is done in the dashboard.

### 3.7 Operations

- **Backups:**
  - the PostgreSQL database daily (RDS: automatic);
  - the recordings volume or S3 bucket (S3 versioning);
  - the `keys/` folder (offline copy).
- **Monitoring:** `GET https://api.example.in/health` every minute. Read the container logs
  with `docker logs nc-api`. They never contain patient names, MRNs or tokens.
- **Updates:**
  1. `git pull`;
  2. `docker build -t neurocapture-api:<new> backend/`;
  3. stop and start the container with the new tag.

  Migrations run automatically. Take a database backup before every update.

- **Changing rules or thresholds** (`config/*.json`):
  - The **API** reads `config/` from the mounted folder, so restart it after a change.
  - The **app** has the same files built in, so it needs a new APK (section 6).
  - Run `pnpm validate` before deploying a config change.

---

## 4. The web dashboards

```bash
pnpm install
pnpm build:dashboard                          # → apps/dashboard/dist
echo '{ "apiUrl": "https://api.example.in" }' > apps/dashboard/dist/config.json
rsync -a apps/dashboard/dist/ server:/srv/nc/dashboard/
```

Requirements:

- The dashboard origin must be in the API's `NC_CORS_ORIGINS` and in every connector's
  `NCC_CORS_ORIGINS`.
- **Doctors' browsers must reach their hospital's connector** (hospital network, VPN, or a
  hospital-controlled HTTPS address). Names, history and videos come from there, not from you.

More details: [`dashboard.md`](dashboard.md).

---

## 5. The hospital connector (each hospital or clinic: the "client")

Every hospital or clinic runs **its own** connector and keeps its own take key (decision 031).
NeuroCapture does not run connectors. A clinic without IT staff can have a vendor run the same
image on a machine the clinic controls.

### 5.1 What the hospital needs

| Need                   | Detail                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server or VM         | Linux with Docker, 2 vCPU, 4 GB RAM, 50 GB disk, inside the hospital network                                                                                                                  |
| An HTTPS address       | e.g. `https://neurocapture-connector.hospital.in`, reachable by the doctors' and front desk's browsers, by clinic phones, and by the NeuroCapture platform (health checks, signed calls)      |
| Its own database       | PostgreSQL (recommended) or a SQLite file for a small clinic. **The tables are created automatically** on first start.                                                                        |
| Access to patient data | **Either** a FHIR R4 server (Patient, Condition, MedicationStatement, Encounter), **or** four read-only SQL views on the hospital database (5.2)                                              |
| Backups                | Daily: the connector database **and** the `take-keys` folder. Without the NCID map, recordings cannot be linked to patients. Without the take keys, recordings **cannot be decrypted, ever.** |

Connector database tables (created by the connector, owned by the hospital):

| Table             | Holds                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| `nc_ncid_map`     | NCID ↔ MRN, the only link between NeuroCapture and the real patient    |
| `nc_activity_log` | Clinical activity: who searched, invited, viewed history or recordings |
| `nc_reviews`      | Doctors' reviews of recordings (usable or not, with a note)            |
| `nc_log_spool`    | Activity entries waiting while the hospital's log server is down       |
| `nc_used_nonces`  | Replay protection for signed platform calls                            |

```sql
-- on the hospital's PostgreSQL
CREATE USER nc_connector WITH PASSWORD '<long random password>';
CREATE DATABASE nc_connector OWNER nc_connector;
```

### 5.2 Patient records: FHIR or SQL views

- **FHIR:** give the connector the base URL, the identifier system that holds the MRN, and a
  read-only token if the server needs one.
- **SQL:** the hospital's IT creates four **views** over their own tables:
  `nc_patients`, `nc_conditions`, `nc_medications` and `nc_encounters`. The columns and an
  example are in `connector/sql/sample_views.sql`. Create a database user that can only
  `SELECT` from these views:

  ```sql
  CREATE USER nc_reader WITH PASSWORD '<password>';
  GRANT SELECT ON nc_patients, nc_conditions, nc_medications, nc_encounters TO nc_reader;
  ```

### 5.3 Configuration: `connector.env`

All connector settings start with `NCC_`. They are defined in `connector/ncconnector/config.py`.

```bash
NCC_SITE_ID=<the hospital's site ID: platform dashboard → Hospitals>
NCC_PLATFORM_URL=https://api.example.in
NCC_PLATFORM_KEY_SHA256=<fingerprint: hospital dashboard → Data connections>
NCC_SIGNING_KEY_PATH=/data/signing.pem
NCC_TAKE_KEYS_DIR=/data/take-keys
NCC_DATABASE_URL=postgresql+psycopg://nc_connector:<password>@<db-host>:5432/nc_connector
NCC_HOSPITAL_NAME=Sunrise Neuro Clinic
# Dashboard origin + Android app WebView (clinic phones look up NCIDs)
NCC_CORS_ORIGINS=https://dashboard.example.in,https://localhost

# Patient records: FHIR …
NCC_RECORDS=fhir
NCC_FHIR_BASE_URL=https://fhir.hospital.in/fhir
NCC_FHIR_MRN_SYSTEM=urn:oid:<hospital MRN system>
# NCC_FHIR_BEARER_TOKEN=<read-only token>
# … or SQL views
# NCC_RECORDS=sql
# NCC_RECORDS_SQL_URL=postgresql+psycopg://nc_reader:<password>@<his-db>:5432/<db>

# Clinical activity log: in the connector database, or the hospital's log server
NCC_ACTIVITY_SINK=db
# NCC_ACTIVITY_SINK=http
# NCC_ACTIVITY_HTTP_URL=https://logs.hospital.in/neurocapture

# Reminders every 15 minutes (needs B1 for e-mail/SMS)
NCC_REMINDER_INTERVAL_S=900
NCC_EMAIL_PROVIDER=dummy
NCC_SMS_PROVIDER=dummy

# Only if the hospital stores recordings in its own S3 bucket (5.5):
# NCC_S3_REGION=ap-south-1     (+ AWS credentials or instance role with read access to that prefix)
```

### 5.4 Install, register, create the take key

```bash
docker build -t neurocapture-connector:1.0.0 connector/
docker volume create nc-connector
# 1. This connector's signing key: prints the PUBLIC key to paste in the dashboard
docker run --rm -v nc-connector:/data neurocapture-connector:1.0.0 \
  python -m ncconnector keygen --out /data/signing.pem
# 2. Start it (behind the hospital's HTTPS proxy)
docker run -d --name nc-connector --restart unless-stopped \
  --env-file connector.env -v nc-connector:/data -p 127.0.0.1:8100:8100 \
  neurocapture-connector:1.0.0
# 3. The hospital's take key (recordings are encrypted for it from the next session on)
docker exec nc-connector python -m ncconnector rotate-take-key
docker exec nc-connector python -m ncconnector take-keys   # compare the fingerprint with the dashboard
```

Then, in the **hospital dashboard → Data connections**:

1. Enter the connector's HTTPS address and paste the public key from step 1.
2. **Test** with one real MRN. All checks should say _pass_: reachable, records, NCID map,
   activity log, decrypt key.

### 5.5 Where recordings are stored (per hospital)

In Data connections → Storage, the hospital admin chooses one option:

- **NeuroCapture storage** (default): your S3 bucket or disk. The files are encrypted on the
  phone with the hospital's key; you cannot read them.
- **The hospital's own S3 bucket.** The dashboard shows an ExternalId and two IAM policies.
  The hospital creates a role that lets NeuroCapture **upload only**, and gives the connector
  its own read access. Full steps: [`connector.md`](connector.md) §2c.

---

## 6. The Android app (APK / AAB)

### 6.1 Before the first release build

1. In `config/session.json`, set the server:

   ```json
   "upload": { ..., "defaultEndpoint": "https://api.example.in" }
   ```

2. Check `config/platform.json`: camera check, PIN rules, invite lifetimes, permissions
   defaults.
3. Run `pnpm validate && pnpm test`.
4. Create the signing key **once** and keep it forever. If the key is lost, the app cannot be
   updated; it needs a new listing.

   ```bash
   keytool -genkeypair -v -keystore neurocapture-release.jks -alias neurocapture \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

### 6.2 Option A: build in GitHub Actions (recommended)

The workflow `.github/workflows/release.yml` (**Release (pilot)**):

1. runs every test;
2. builds the app with the engineering tools hidden (`VITE_PRODUCTION=1`);
3. signs it;
4. produces the **AAB** (for Google Play) and the **APK** (for direct install or Firebase).

5. GitHub → Settings → Secrets and variables → Actions. Add these secrets:
   - `ANDROID_KEYSTORE_BASE64`;
   - `ANDROID_KEYSTORE_PASSWORD`;
   - `ANDROID_KEY_ALIAS`;
   - `ANDROID_KEY_PASSWORD`;
   - and, optionally, the Firebase ones.

   The details are in [`release.md`](release.md).

6. Actions → **Release (pilot)** → Run workflow → version, e.g. `1.0.0`.
7. Download `app-release.apk` and `app-release.aab` from the run's artifacts.

### 6.3 Option B: build on your own computer

You need Node 22, pnpm, JDK 21 and the Android SDK (install Android Studio). From the repo root:

```bash
pnpm install
pnpm models                                   # MediaPipe models into the app
VITE_PRODUCTION=1 pnpm build:web              # Windows PowerShell: $env:VITE_PRODUCTION="1"; pnpm build:web
pnpm --filter @neurocapture/mobile exec cap sync android
cd apps/mobile/android
NC_KEYSTORE_FILE=/path/neurocapture-release.jks NC_KEYSTORE_PASSWORD=... \
NC_KEY_ALIAS=neurocapture NC_KEY_PASSWORD=... \
NC_VERSION_NAME=1.0.0 NC_VERSION_CODE=100 \
./gradlew assembleRelease bundleRelease       # Windows: gradlew.bat (set the variables with $env:NAME="...")
```

Output:

- `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`

`NC_VERSION_CODE` must go up with every release.

### 6.4 Getting the app to phones

| Who                 | How                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinic phones       | Install the APK (USB, Firebase App Distribution, or your MDM). Register each phone with a code from the hospital dashboard → Phones (camera check first). |
| Patients            | Google Play (Internal → Closed → Production track) with Play App Signing. The listing needs a privacy policy and the Data safety form.                    |
| Testers before that | Firebase App Distribution (set `firebase_groups` when running the workflow)                                                                               |

---

## 7. Bringing a hospital live (in order)

1. **Platform admin** → Hospitals → add the hospital (name, region, modules) with the hospital
   admin's e-mail. _(Until B1 is fixed, the invite e-mail is not delivered.)_
2. **Hospital IT:** set up the connector, register it, create the take key and run the test
   (section 5).
3. **Hospital admin** → Team: add front desk, doctors and clinic operators (operator ID, name,
   temporary password).
4. **Hospital admin** → Phones: create a registration code for each clinic phone. On the
   phone: camera check → code → operator sign-in.
5. **Front desk:**
   - invites patients from the hospital records (printed QR works today);
   - adds the appointments that need a movement recording;
   - assigns the doctor.
6. **Doctor** → Choose tests: home link, clinic queue, or both.
7. **Platform admin** → Hospitals → Roles and permissions: adjust what each role may do, if
   the defaults do not fit.

---

## 8. Production checklist

- [ ] PR #3 merged; release built from `main` or a tag
- [ ] E-mail and SMS providers built and configured (B1), or the hospital agrees to printed QR invites only
- [ ] `defaultEndpoint` set to the production API (B2)
- [ ] PostgreSQL with backups; S3 (or disk) with backups or versioning
- [ ] `NC_JWT_SECRET` random; keys generated and backed up offline; no `NC_SERVER_PRIVATE_KEY_PATH` on the server
- [ ] HTTPS on the API, the dashboard and every connector
- [ ] `NC_CORS_ORIGINS` and `NCC_CORS_ORIGINS` set to the dashboard origin plus `https://localhost`
- [ ] `/health` monitored
- [ ] First platform admin created; two-step sign-in set up
- [ ] For each hospital:
  - [ ] connector test all _pass_;
  - [ ] take key fingerprint matches;
  - [ ] connector database and `take-keys` backed up.
- [ ] Release keystore backed up in two places
- [ ] On one real phone of each model:
  - [ ] camera check;
  - [ ] a full session;
  - [ ] the upload completes;
  - [ ] the doctor can play the recording.

  See [`qa/testing-guide.md`](qa/testing-guide.md), level 3.

- [ ] Legal: ethics approval, consent text, data-processing agreement, privacy policy (B4)
