# Hospital connector — set-up guide (M11)

The connector is a small service that runs in the hospital's network, or per clinic in managed
mode (run by NeuroCapture). It is the only part of NeuroCapture that handles patient identity:

- It **reads patient records live** from FHIR R4 or from read-only SQL views, and never copies
  them.
- It keeps the **NCID ↔ MRN map** in its own database, which belongs to the hospital.
- It **sends patient invites** (e-mail with QR code, SMS, printed QR) using contact details from
  the records.
- It **writes the clinical activity log**: searched, invited, viewed history, viewed a recording.
- It **decrypts recordings** for the hospital's doctors.

The platform only ever learns NCIDs, invite channels and pass/fail health results. The API is in
`contracts/connector-api.yaml`, and decision 025 explains the security design.

## 1. Run it

```bash
docker build -t neurocapture-connector connector/
docker run -d --name nc-connector -p 8100:8100 -v nc-connector:/data --env-file connector.env neurocapture-connector
```

`connector.env` (all variables start with `NCC_`):

| Variable                                                            | Meaning                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NCC_SITE_ID`                                                       | The hospital's ID, shown in the hospital dashboard (Data connections)                                                                                                                    |
| `NCC_PLATFORM_URL`                                                  | NeuroCapture API address                                                                                                                                                                 |
| `NCC_SIGNING_KEY_PATH`                                              | This connector's Ed25519 key (step 2)                                                                                                                                                    |
| `NCC_PLATFORM_PUBLIC_KEY_PATH` or `NCC_PLATFORM_KEY_SHA256`         | **One is required.** The platform's public key file, or its SHA-256 from Data connections, to pin the key fetched from `<platform>/.well-known/neurocapture-platform-key` (decision 027) |
| `NCC_TAKE_PRIVATE_KEY_PATH`                                         | RSA private key that unwraps recordings (M12 makes this the hospital's own key)                                                                                                          |
| `NCC_DATABASE_URL`                                                  | The connector's database (Postgres or SQLite file); tables `nc_ncid_map`, `nc_activity_log`, `nc_log_spool`                                                                              |
| `NCC_RECORDS`                                                       | `fhir` or `sql`                                                                                                                                                                          |
| `NCC_FHIR_BASE_URL`, `NCC_FHIR_MRN_SYSTEM`, `NCC_FHIR_BEARER_TOKEN` | FHIR server, the identifier system that holds the MRN, and an optional token                                                                                                             |
| `NCC_RECORDS_SQL_URL`                                               | Read-only database URL with the views from `connector/sql/sample_views.sql`                                                                                                              |
| `NCC_ACTIVITY_SINK`, `NCC_ACTIVITY_HTTP_URL`                        | `db` (default) or `http` (the hospital's log server; entries are queued while it is down)                                                                                                |
| `NCC_HOSPITAL_NAME`                                                 | Name used in invite messages                                                                                                                                                             |
| `NCC_CORS_ORIGINS`                                                  | Dashboard address(es) allowed to call the connector from the browser                                                                                                                     |
| `NCC_EMAIL_PROVIDER`, `NCC_SMS_PROVIDER`                            | `dummy` for now (decision 024)                                                                                                                                                           |

The connector must be reachable over HTTPS from the doctors' browsers (hospital network, VPN or
a hospital-controlled endpoint) and from the NeuroCapture platform (for health checks).

## 2. Register it

```bash
docker exec nc-connector python -m ncconnector keygen --out /data/signing.pem
```

The command prints a public key. In the hospital dashboard → Data connections, enter the
connector's address and paste that key. The private key never leaves the connector.

### 2b. Create the hospital's take key

```bash
docker exec nc-connector python -m ncconnector rotate-take-key
docker exec nc-connector python -m ncconnector take-keys   # compare fingerprints with Data connections → Keys
```

Phones wrap every recording key with this public key, from the next session on. Run the command
again to rotate. Old keys stay in the folder so earlier recordings still open.

### 2c. Optional: store recordings in the hospital's own S3 bucket

In Data connections → Storage, the dashboard shows an ExternalId and two policies:

1. Create an IAM role that trusts the NeuroCapture principal with that ExternalId (trust policy).
2. Allow only `s3:PutObject`, `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts`
   under the chosen prefix (permissions policy). NeuroCapture can upload but not read.
3. Enter the bucket, region, prefix and role ARN. The platform tests the role before switching.
4. Give the connector read access to the same prefix, with its own AWS credentials.

## 3. Test it

In Data connections → Test, enter one sample MRN. The connector:

- looks up that patient;
- reads its NCID map;
- writes a test entry to the activity log;
- checks that the take key is present.

NeuroCapture records only pass or fail for each check.

## 4. SQL views (if not FHIR)

Hospital IT creates four views, mapped to their own tables:

- `nc_patients`
- `nc_conditions`
- `nc_medications`
- `nc_encounters`

Columns and an example are in `connector/sql/sample_views.sql`. Grant the connector's database
user `SELECT` on these views only. The connector runs SELECTs with bound parameters, nothing else.

## 5. Appointments and reminders (v3)

- **Appointments:** `GET /v1/appointments` (reception) reads booked appointments live: FHIR
  `Appointment` search by date (cancelled, no-show and entered-in-error are left out), or the
  optional SQL view `nc_appointments`
  (`sql/sample_views.sql`). An adapter without appointments answers 501; reception then adds
  them by hand.
- **Reminders:** every `NCC_REMINDER_INTERVAL_S` seconds (0 = off), or with
  `python -m ncconnector send-reminders`, the connector asks the platform which record links are
  due soon. It reads the patient's e-mail or mobile from the hospital records and sends "please
  record by …" through the hospital's provider. The texts are in `messages/en.json`
  (`reminderEmail`, `reminderSms`).

## Small clinics

Every hospital and clinic runs its own connector and keeps its own take key (decision 031).
NeuroCapture does not run connectors for clinics. A clinic without IT staff can run the same
image on any computer or server it controls, set up by a vendor or contractor it chooses:

```bash
NCC_SITE_ID=<site id> docker compose --profile connector up -d connector
```

The public key to register is in `/data/connector.pub` inside the container.
