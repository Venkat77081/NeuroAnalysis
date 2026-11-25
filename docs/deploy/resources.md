# Resources to create: a checklist

Everything to create before go-live, in order, on **AWS** or **Azure**. The step-by-step commands
are in [`aws.md`](aws.md) and [`azure.md`](azure.md) (on Azure, also split into
[`azure-platform.md`](azure-platform.md) and [`azure-hospital.md`](azure-hospital.md)); the cloud-neutral reference is
[`../PRODUCTION.md`](../PRODUCTION.md).

There are two kinds of deployment:

- **The NeuroCapture platform:** run by you, one per market.
- **The hospital connector:** run by each hospital in its own network or cloud account.

**NeuroCapture keeps no recordings** (decision 044). Every hospital connects its own S3 bucket or
Azure Blob container (§5, row 7); its phones cannot record until that storage passes its test.

## 1. One platform per market

Patients and hospitals in each market use a platform in that market's region, so their data
stays there.

| Market | AWS region                 | Azure region          | Domain example       |
| ------ | -------------------------- | --------------------- | -------------------- |
| US     | `us-east-1` or `us-east-2` | `eastus` or `eastus2` | `api.us.example.com` |
| India  | `ap-south-1` (Mumbai)      | `centralindia`        | `api.in.example.com` |

**One Android build per market.** A release app has its server address built in (`VITE_SERVER_URL`,
[`../release.md`](../release.md)). Build one APK/AAB per market, for example as two Play Store
listings or tracks. A patient's app account (decision 043) lives on their market's platform.

## 2. Platform resources (per market)

| #   | What                           | AWS                                                                           | Azure                                                                  | Why                                                  |
| --- | ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Account / subscription         | AWS account, MFA on root, billing alerts                                      | Subscription + resource group `nc-prod`, budget alert                  | Isolation and cost control                           |
| 2   | Network                        | VPC: public subnet (API), private subnets (database)                          | VNet: `api` and `db` subnets, NSGs                                     | Database never on the internet                       |
| 3   | Database                       | RDS PostgreSQL 16, private, encrypted, automated backups                      | Azure Database for PostgreSQL Flexible, private access, backups        | Platform data (no patient names, see §4)             |
| 4   | Recordings storage             | **None.** Each hospital brings its own (§5)                                   | **None.** Each hospital brings its own (§5)                            | Decision 044                                         |
| 5   | E-mail                         | SES domain identity, DKIM/SPF/DMARC, production access, SMTP credentials      | Communication Services + Email, verified domain, SMTP via an Entra app | Staff invites **and patient app-account codes**      |
| 6   | Key vault                      | Secrets Manager                                                               | Key Vault (RBAC)                                                       | Holds the secrets in §3                              |
| 7   | API server                     | EC2 (t4g.medium), Ubuntu, Docker, Elastic IP, IAM role (Secrets Manager, STS) | VM (D2s_v5), Ubuntu, Docker, managed identity (Key Vault)              | Runs the API container and serves the dashboards     |
| 8   | DNS + HTTPS                    | Route 53 (or your DNS) records `api.` and `dashboard.`; Caddy for TLS         | Azure DNS (or yours); Caddy for TLS                                    | Public HTTPS endpoints                               |
| 9   | Monitoring                     | CloudWatch logs and alarms (health, 5xx, disk)                                | Azure Monitor / Log Analytics alerts                                   | Know when something breaks                           |
| 10  | Backups                        | RDS snapshots, AWS Backup                                                     | PostgreSQL backups                                                     | Recovery                                             |
| 11  | (Optional) scale-out           | ECS Fargate + ALB                                                             | Container Apps or VM scale set + Application Gateway                   | More than one API server (the server keeps no files) |
| 12  | Azure app for hospitals' Blob  | Entra multi-tenant app + client secret ([`azure.md`](azure.md) step 5b)       | same                                                                   | Lets hospitals choose Azure Blob (write-only)        |
| 13  | AWS identity for hospitals' S3 | the EC2 IAM role (`sts:AssumeRole` only)                                      | IAM user with `sts:AssumeRole` only ([`azure.md`](azure.md) step 5c)   | Lets hospitals choose S3 (upload-only role)          |

## 3. Platform secrets (put them in the key vault, never in Git)

| Secret                                               | Created with                                              | Used as                                | If lost or changed                                                      |
| ---------------------------------------------------- | --------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `platform-signing-key`                               | `openssl genpkey -algorithm ed25519`                      | `NC_PLATFORM_SIGNING_KEY_PATH`         | Every hospital connector must re-pin the platform key                   |
| `server-public-key`                                  | from an RSA-3072 key (`server-private.pem` stays offline) | `NC_SERVER_PUBLIC_KEY_PATH`            | Older phones only                                                       |
| `jwt-secret`                                         | `openssl rand -hex 32`                                    | `NC_JWT_SECRET`                        | Everyone signs in again                                                 |
| **`account-pepper`** (v11)                           | `openssl rand -hex 32`                                    | `NC_ACCOUNT_PEPPER`                    | **No patient can use their app account; every hospital must re-invite** |
| `db-url`                                             | the database user's password                              | `NC_DATABASE_URL`                      | Rotate the database password                                            |
| `smtp-username/password`                             | SES SMTP credentials / ACS Entra app secret               | `NC_SMTP_USERNAME`, `NC_SMTP_PASSWORD` | Rotate in the mail service                                              |
| `azure-client-secret`                                | Entra multi-tenant app (row 12)                           | `NC_AZURE_CLIENT_SECRET`               | Uploads to hospitals on Azure stop until rotated                        |
| (Azure-hosted) `aws-access-key-id/secret-access-key` | IAM user that may only assume roles (row 13)              | `NC_S3_ACCESS_KEY`, `NC_S3_SECRET_KEY` | Uploads to hospitals on S3 stop until rotated                           |

Settings that are **not** secret but must be right in production: `NC_DEV_STORAGE=false` (the
default; development storage is for tests only), `NC_AZURE_CLIENT_ID` (row 12) and
`NC_PLATFORM_AWS_PRINCIPAL` (the AWS identity of row 13, which hospitals' roles trust).

Back up the key vault, and restrict and log who can read `account-pepper`. A copy of the database
alone cannot be used to guess patients' PINs, but someone with both the database and the pepper
could try (decision 043).

## 4. What the platform database holds (created by migrations, not by hand)

Create **one empty database and one user**. The API runs `alembic upgrade head` on start and creates
every table (migrations `0001`–`0020`). The tables are listed in
[`../PRODUCTION.md`](../PRODUCTION.md) §3.1.

- **No patient name, MRN, phone number or address.** A test enforces this.
- **v11 additions:**
  - `app_accounts`: the e-mail as a keyed fingerprint (not the address), the PIN hash, and the
    sealed backup.
  - `app_account_codes`: the e-mail codes, hashed.
  - `app_account_tokens`: the signed-in phone.

## 5. Each hospital (connector)

| #   | What                              | AWS                                                                             | Azure                                                                                          | Notes                                                                                        |
| --- | --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Network link to hospital systems  | VPC + Site-to-Site VPN / Direct Connect                                         | VNet + VPN Gateway / ExpressRoute                                                              | Must reach the EHR/HIS (FHIR R4) or the SQL views                                            |
| 2   | Connector server                  | EC2 t4g.small + Docker, encrypted EBS for `/data`                               | VM B2s + Docker, encrypted disk for `/data`                                                    | `/data` holds the signing key and **take keys**: back it up                                  |
| 3   | Connector database                | RDS PostgreSQL (small) or Postgres on the VM                                    | PostgreSQL Flexible (Burstable) or on the VM                                                   | Holds NCID↔MRN, activity log, reviews, remarks, encrypted e-mail/SMS settings                |
| 4   | HTTPS address                     | ALB + certificate (ACM)                                                         | Application Gateway / Caddy                                                                    | Reachable by the platform (signed calls), staff browsers and clinic phones                   |
| 5   | Records access                    | FHIR client credentials or a read-only SQL user                                 | same                                                                                           | Read only                                                                                    |
| 6   | E-mail and SMS                    | SES / any SMTP; SMS: Twilio, SNS or an HTTP gateway                             | ACS Email / any SMTP; SMS: Twilio or an HTTP gateway                                           | Set by IT in `connector.env` or by the hospital admin in the dashboard (decision 042)        |
| 7   | **Recordings storage (required)** | S3 bucket + upload-only role trusting the platform ([`aws.md`](aws.md) step 12) | Blob container + write-only role for the platform's Entra app ([`azure.md`](azure.md) step 12) | Phones cannot record until its test passes; the connector reads it; the hospital backs it up |
| 8   | (Later) analysis engine           | EC2 next to the connector (CPU; GPU optional)                                   | VM next to the connector                                                                       | Biomarkers computed at the hospital (decision 027)                                           |

The connector keys (create them on the connector, never copy them off it):

- **Signing key:** `python -m ncconnector keygen`.
- **Take key:** `python -m ncconnector rotate-take-key`.
- **Platform pin:** `NCC_PLATFORM_KEY_SHA256`, from the platform admin's set-up page.

E-mail and SMS settings that the hospital admin saves in the dashboard are encrypted with a key
derived from the signing key. Changing the signing key means entering them again.

## 6. Before go-live

1. `curl https://api.<market-domain>/health` returns `ok`, with `"storage": "hospital_owned"`.
   Dashboard → **Platform settings** lists the storage kinds hospitals can choose.
2. Create the first platform admin: `python -m app.admin create-platform-admin --email you@example.org`.
3. **Patient app:**
   - Build the release APK/AAB with that market's `VITE_SERVER_URL`.
   - Sign up with a test e-mail.
   - Join a test hospital.
   - Reinstall the app and sign in again: the hospital must come back.
4. **Each hospital:**
   - Register the connector.
   - Run its health check (all pass).
   - Register its take key.
   - Connect its own S3 bucket or Blob container and **Test and save**: the dashboard says
     "Phones can record".
   - Send a test e-mail and a test SMS from Data connections.
