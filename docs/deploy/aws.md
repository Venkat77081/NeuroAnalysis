# Deploying NeuroCapture on Amazon Web Services (AWS)

A step-by-step guide for running the **NeuroCapture platform** (API + dashboards) on AWS. It also
covers a hospital that runs its **connector** in its own AWS account.

- **Azure instead?** See [`azure.md`](azure.md).
- **Background and cloud-neutral reference:** [`../PRODUCTION.md`](../PRODUCTION.md).

Region: **ap-south-1 (Mumbai)**, which keeps data in India. Replace `example.in` with your domain.

```
                Internet
                   │  HTTPS 443
          ┌────────▼─────────┐  Elastic IP, security group: 80/443 from anywhere, 22 from your IP only
          │ EC2: Ubuntu 24.04│  Caddy (TLS) ─► API container (port 8000)
          │  + Docker        │             └─► dashboard static files
          └──┬──────────┬────┘  IAM instance role (S3, Secrets Manager, STS)
             │          │
   ┌─────────▼───┐  ┌───▼──────────────┐   ┌─────────────────────┐
   │ RDS Postgres│  │ S3 bucket        │   │ SES (SMTP)           │
   │ 16, private │  │ recordings,      │   │ staff invite e-mails │
   │ subnet      │  │ encrypted        │   └─────────────────────┘
   └─────────────┘  └──────────────────┘
```

This is a pilot-to-production layout on one API server. To scale later, run the same container on
ECS Fargate behind an Application Load Balancer. The database, bucket, SES and secrets stay the
same.

---

## Step 1: Account basics

1. Turn on MFA for the root user; work as an IAM user or role with admin rights.
2. Create a **billing alarm** (CloudWatch → Alarms → Billing).
3. Install the AWS CLI on your computer and run `aws configure` with region `ap-south-1`.

## Step 2: Network

Use the default VPC for a pilot, or create one with **2 public and 2 private subnets in 2
availability zones** (VPC console → "VPC and more").

Create two **security groups**:

| Name     | Inbound rules                                                 |
| -------- | ------------------------------------------------------------- |
| `nc-web` | TCP 443 and 80 from `0.0.0.0/0`; TCP 22 from your own IP only |
| `nc-db`  | TCP 5432 from the security group `nc-web` only                |

## Step 3: Database (Amazon RDS for PostgreSQL)

RDS console → Create database:

| Setting               | Value                                                               |
| --------------------- | ------------------------------------------------------------------- |
| Engine                | PostgreSQL 16                                                       |
| Template              | Production (Multi-AZ) — or Dev/Test for a pilot (single AZ)         |
| Identifier            | `neurocapture-db`                                                   |
| Master username       | `nc_admin`, with a strong password (or "Manage in Secrets Manager") |
| Instance              | `db.t4g.medium` (2 vCPU, 4 GB) is enough to start                   |
| Storage               | gp3, 50 GB, autoscaling on                                          |
| Public access         | **No**                                                              |
| Security group        | `nc-db`                                                             |
| Initial database name | `neurocapture`                                                      |
| Backups               | 14 days or more; encryption **on**; deletion protection **on**      |

You do **not** create tables. The API creates and upgrades all of them when it starts.

Optional: a separate application user instead of the master user. Connect from the EC2 server
(step 6) with `psql`, then:

```sql
CREATE USER neurocapture WITH PASSWORD '<long random password>';
GRANT ALL ON DATABASE neurocapture TO neurocapture;
\c neurocapture
GRANT ALL ON SCHEMA public TO neurocapture;
```

Database URL for the API (RDS requires TLS):

```
postgresql+psycopg://neurocapture:<password>@neurocapture-db.xxxx.ap-south-1.rds.amazonaws.com:5432/neurocapture?sslmode=require
```

## Step 4: Recordings bucket (Amazon S3)

```bash
aws s3api create-bucket --bucket nc-takes-prod-<unique> --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket nc-takes-prod-<unique> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket nc-takes-prod-<unique> --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket nc-takes-prod-<unique> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
# Clean up uploads that phones abandoned:
aws s3api put-bucket-lifecycle-configuration --bucket nc-takes-prod-<unique> --lifecycle-configuration \
  '{"Rules":[{"ID":"abort-incomplete","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
```

The files are already encrypted on the phone with each hospital's key; S3 encryption is a second
layer. Phones upload with presigned URLs; no bucket CORS is needed.

**Sizing (rough):** a session is about 0.3–0.5 GB of video. Measure on your own phones and set a
budget alarm.

## Step 5: E-mail (Amazon SES over SMTP)

1. SES console → **Identities → Create identity → Domain** `example.in`. Add the DKIM CNAME
   records it shows to your DNS. Add SPF (`v=spf1 include:amazonses.com ~all`) and a DMARC record
   (`_dmarc` TXT `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.in`).
2. **Request production access** (SES → Account dashboard). New accounts are in the sandbox and
   can only e-mail verified addresses.
3. **SMTP settings → Create SMTP credentials.** This creates an IAM user and shows the SMTP
   username and password **once**; store them in Secrets Manager (step 7).
4. Settings for the API:

   ```
   NC_EMAIL_PROVIDER=smtp
   NC_SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
   NC_SMTP_PORT=587
   NC_SMTP_SECURITY=starttls
   NC_SMTP_USERNAME=<SES SMTP username>
   NC_SMTP_PASSWORD=<SES SMTP password>
   NC_MAIL_FROM=no-reply@example.in
   NC_MAIL_FROM_NAME=NeuroCapture
   ```

The platform sends staff invites only. Patient e-mails and SMS come from each hospital's
connector (step 12).

## Step 6: The server (EC2)

1. EC2 → Launch instance:

   | Setting  | Value                                       |
   | -------- | ------------------------------------------- |
   | Image    | Ubuntu Server 24.04 LTS (64-bit Arm or x86) |
   | Type     | `t4g.medium` (Arm) or `t3.medium` (x86)     |
   | Network  | public subnet, security group `nc-web`      |
   | Storage  | 40 GB gp3, encrypted                        |
   | IAM role | `nc-api-role` (created below)               |

2. Allocate an **Elastic IP** and associate it with the server.
3. In DNS, point **A records** `api.example.in` and `dashboard.example.in` at the Elastic IP.
4. **IAM role `nc-api-role`** (trusted entity: EC2), with this inline policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:PutObject",
           "s3:GetObject",
           "s3:AbortMultipartUpload",
           "s3:ListMultipartUploadParts",
           "s3:ListBucket",
           "s3:ListBucketMultipartUploads"
         ],
         "Resource": [
           "arn:aws:s3:::nc-takes-prod-<unique>",
           "arn:aws:s3:::nc-takes-prod-<unique>/*"
         ]
       },
       {
         "Effect": "Allow",
         "Action": "secretsmanager:GetSecretValue",
         "Resource": "arn:aws:secretsmanager:ap-south-1:<account-id>:secret:nc/*"
       },
       { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "*" }
     ]
   }
   ```

   `sts:AssumeRole` is only needed for hospitals that keep recordings in **their own** bucket.
   They allow this role (with an ExternalId) to upload into it.

5. Connect with `ssh ubuntu@api.example.in` and install Docker, the AWS CLI and Caddy:

   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io git unzip postgresql-client
   sudo usermod -aG docker ubuntu && newgrp docker
   curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o awscli.zip && unzip -q awscli.zip && sudo ./aws/install
   sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt-get update && sudo apt-get install -y caddy
   ```

## Step 7: Keys and secrets (AWS Secrets Manager)

On **your own computer**, generate the keys (see [`../PRODUCTION.md`](../PRODUCTION.md) §3.2)
and store them:

```bash
openssl genpkey -algorithm ed25519 -out platform-signing.pem
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out server-private.pem
openssl pkey -in server-private.pem -pubout -out server-public.pem

aws secretsmanager create-secret --name nc/platform-signing-key --secret-string file://platform-signing.pem
aws secretsmanager create-secret --name nc/server-public-key   --secret-string file://server-public.pem
aws secretsmanager create-secret --name nc/jwt-secret          --secret-string "$(openssl rand -hex 32)"
aws secretsmanager create-secret --name nc/db-url              --secret-string 'postgresql+psycopg://neurocapture:<pw>@<rds-endpoint>:5432/neurocapture?sslmode=require'
aws secretsmanager create-secret --name nc/smtp-username       --secret-string '<SES SMTP username>'
aws secretsmanager create-secret --name nc/smtp-password       --secret-string '<SES SMTP password>'
```

Keep `server-private.pem` **offline** (not in AWS and not on the server). Then delete the local
copies of the other files once they are safely stored.

## Step 8: Run the API

On the server:

```bash
sudo mkdir -p /srv/nc/keys && sudo chown ubuntu /srv/nc /srv/nc/keys
git clone https://github.com/Venkat77081/NeuroAnalysis.git /srv/nc/src
cd /srv/nc/src && git checkout main            # or a release tag
docker build -t neurocapture-api:1.0.0 backend/
```

Create `/srv/nc/start-api.sh` (run it as root: `sudo`). It reads the secrets at every start, so
nothing secret sits in a file on disk except the key files, which only the container's user can
read:

```bash
#!/bin/sh
set -eu
s() { aws secretsmanager get-secret-value --region ap-south-1 --secret-id "$1" --query SecretString --output text; }
s nc/platform-signing-key > /srv/nc/keys/platform-signing.pem
s nc/server-public-key    > /srv/nc/keys/server-public.pem
chmod 600 /srv/nc/keys/*.pem && chown 10001 /srv/nc/keys/*.pem   # the container's user
docker rm -f nc-api 2>/dev/null || true
docker run -d --name nc-api --restart unless-stopped -p 127.0.0.1:8000:8000 \
  -v /srv/nc/keys:/keys:ro -v /srv/nc/src/config:/srv/config:ro \
  -e NC_DATABASE_URL="$(s nc/db-url)" \
  -e NC_JWT_SECRET="$(s nc/jwt-secret)" \
  -e NC_SMTP_USERNAME="$(s nc/smtp-username)" \
  -e NC_SMTP_PASSWORD="$(s nc/smtp-password)" \
  --env-file /srv/nc/api.env \
  neurocapture-api:1.0.0
```

And `/srv/nc/api.env` (no secrets in it):

```bash
NC_PUBLIC_BASE_URL=https://api.example.in
NC_DASHBOARD_URL=https://dashboard.example.in
NC_CORS_ORIGINS=https://dashboard.example.in,https://localhost
NC_PLATFORM_SIGNING_KEY_PATH=/keys/platform-signing.pem
NC_PLATFORM_KEY_ID=platform-1
NC_SERVER_PUBLIC_KEY_PATH=/keys/server-public.pem
NC_SERVER_KEY_ID=server-1
NC_STORAGE=s3
NC_S3_BUCKET=nc-takes-prod-<unique>
NC_S3_REGION=ap-south-1
NC_PLATFORM_AWS_PRINCIPAL=arn:aws:iam::<account-id>:role/nc-api-role
NC_REQUIRE_HOSPITAL_KEY=true
NC_ALLOW_LEGACY_REF_HASH=false
NC_EMAIL_PROVIDER=smtp
NC_SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
NC_SMTP_PORT=587
NC_SMTP_SECURITY=starttls
NC_MAIL_FROM=no-reply@example.in
NC_MAIL_FROM_NAME=NeuroCapture
NC_CONFIG_DIR=/srv/config
```

S3 access comes from the instance role, so leave `NC_S3_ACCESS_KEY` and `NC_S3_SECRET_KEY` unset.

```bash
chmod +x /srv/nc/start-api.sh && sudo /srv/nc/start-api.sh
curl -s http://127.0.0.1:8000/health      # {"status":"ok", ... "checks": {database, storage}}
```

If the container stops at once, read `docker logs nc-api`. A message starting with
`message delivery settings:` names the SMTP setting that is missing.

## Step 9: HTTPS and the dashboard

```bash
cd /srv/nc/src
# Node 22 + pnpm on the server (or build on your computer and copy dist/)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs && sudo corepack enable
pnpm install --frozen-lockfile && pnpm build:dashboard
sudo mkdir -p /srv/nc/dashboard && sudo cp -r apps/dashboard/dist/* /srv/nc/dashboard/
echo '{ "apiUrl": "https://api.example.in" }' | sudo tee /srv/nc/dashboard/config.json
```

`/etc/caddy/Caddyfile`:

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

```bash
sudo systemctl reload caddy      # Caddy fetches and renews the certificates itself
```

Open `https://dashboard.example.in`: the sign-in page should load.

## Step 10: First platform admin and a test e-mail

```bash
docker exec -it nc-api python -m app.admin create-platform-admin --email you@example.in --name "Your Name"
```

1. Open the printed link and set a password and two-step sign-in.
2. Onboard a test hospital with **your own** e-mail as its admin.
3. Check that the invite e-mail arrives. That confirms SES works.

## Step 11: Operations

| Task               | How                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start after reboot | `sudo crontab -e` → `@reboot /srv/nc/start-api.sh` (the container also restarts itself)                                                                                                                                   |
| Health             | CloudWatch Synthetics canary or Route 53 health check on `https://api.example.in/health`                                                                                                                                  |
| Logs               | `docker logs nc-api`; for CloudWatch, add `--log-driver awslogs --log-opt awslogs-group=/nc/api --log-opt awslogs-region=ap-south-1` to `docker run` (the role then needs `logs:CreateLogStream` and `logs:PutLogEvents`) |
| Backups            | RDS automated backups and snapshots; S3 versioning; AWS Backup for the EC2 volume (optional, the server holds no data)                                                                                                    |
| Update             | Snapshot RDS → `git pull` → `docker build -t neurocapture-api:<new> backend/` → edit the tag in `start-api.sh` → `sudo /srv/nc/start-api.sh`                                                                              |
| Config change      | Edit `config/*.json` in `/srv/nc/src`, run `pnpm validate`, then `sudo /srv/nc/start-api.sh`. The app needs a new APK for the same change                                                                                 |
| Patching           | `sudo unattended-upgrades` (on by default on Ubuntu); reboot monthly                                                                                                                                                      |

## Step 12: A hospital that runs its connector in AWS

Each hospital runs its **own** connector, in its own account and network ([`../connector.md`](../connector.md)).
If the hospital uses AWS:

1. **Network.** Put the connector in a private subnet of the hospital's VPC, connected to the
   hospital network (Site-to-Site VPN or Direct Connect) so it can reach the FHIR server or
   database.
   - Publish it at `https://neurocapture-connector.hospital.in` through an internal or
     internet-facing ALB, so doctors' browsers, clinic phones and the NeuroCapture platform can
     reach it.
   - Restrict who can reach it with security groups or a WAF.
2. **Database.** A small RDS PostgreSQL instance (`db.t4g.small`) or PostgreSQL on the same EC2.
   Use `NCC_DATABASE_URL=postgresql+psycopg://…?sslmode=require`. The 5 tables are created on
   start.
3. **Server.** An EC2 instance (`t4g.small`) with Docker. Build and run the connector image
   ([`../PRODUCTION.md`](../PRODUCTION.md) §5.4). Keep `/data` (signing key, **take keys**) on an
   encrypted EBS volume with **AWS Backup**.
4. **Patient e-mail:** the hospital's own SES (same steps as step 5, with the hospital's domain)
   or its mail server:

   ```
   NCC_EMAIL_PROVIDER=smtp
   NCC_SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
   NCC_SMTP_PORT=587
   NCC_SMTP_SECURITY=starttls
   NCC_SMTP_USERNAME=<hospital's SES SMTP user>
   NCC_SMTP_PASSWORD=<hospital's SES SMTP password>
   NCC_MAIL_FROM=neurocapture@hospital.in
   NCC_MAIL_FROM_NAME=Sunrise Neuro Clinic
   ```

5. **Patient SMS through Amazon SNS:**
   - **India DLT.** Register the hospital (principal entity) and a sender ID (header) on a DLT
     portal (Jio, Airtel, Vi, …). Register two **transactional templates** whose text matches
     `patientInviteSms` and `reminderSms` in `config/messages/en.json`, with the variable parts
     marked as `{#var#}`.
   - **AWS.** In End User Messaging SMS (SNS → Text messaging), leave the SMS sandbox, raise the
     monthly spend limit, and register the sender ID with the entity and template IDs.
   - **Permission.** The connector's EC2 role needs `sns:Publish`.

   ```
   NCC_SMS_PROVIDER=sns
   NCC_SMS_AWS_REGION=ap-south-1
   NCC_SMS_FROM=SNRISE                      # the DLT sender ID (header)
   NCC_SMS_DEFAULT_COUNTRY_CODE=+91
   NCC_SMS_DLT_ENTITY_ID=1201xxxxxxxxxxxxxxx
   NCC_SMS_DLT_TEMPLATE_IDS={"patientInviteSms": "1207xxxxxxxxxxxxxxx", "reminderSms": "1207xxxxxxxxxxxxxxx"}
   ```

6. **Test.** Register the connector in the dashboard, then run Data connections → **Test**.
   Invite yourself by e-mail and by SMS from "Invite patients": each row should say "Sent".
   "Not sent" means the mail or SMS settings were refused; the connector log says which (by type,
   never the address).

## Costs (rough, ap-south-1, on-demand, before tax)

| Item                               | Pilot (1 hospital)                     |
| ---------------------------------- | -------------------------------------- |
| EC2 t4g.medium + 40 GB             | ~ US$ 30 / month                       |
| RDS db.t4g.medium single-AZ, 50 GB | ~ US$ 60 / month (Multi-AZ ~2×)        |
| S3                                 | ~ US$ 0.025 per GB-month               |
| SES                                | ~ US$ 0.10 per 1,000 e-mails           |
| SNS SMS to India                   | per message; check current SNS pricing |

Prices change; check the AWS Pricing Calculator.
