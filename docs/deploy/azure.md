# Deploying NeuroCapture on Microsoft Azure

A step-by-step guide for running the **NeuroCapture platform** (API + dashboards) on Azure. It also
covers a hospital that runs its **connector** in its own Azure subscription.

- **Separate guides:** [`azure-platform.md`](azure-platform.md) (the platform, for NeuroCapture) and
  [`azure-hospital.md`](azure-hospital.md) (connector, recordings and biomarkers, for each hospital).
- **AWS instead?** See [`aws.md`](aws.md).
- **Background and cloud-neutral reference:** [`../PRODUCTION.md`](../PRODUCTION.md).

Region: deploy **one platform per market** so data stays in that market: **East US / East US 2**
(`eastus`, `eastus2`) for US hospitals, **Central India** (`centralindia`) for India. The commands
below use `centralindia`; replace it (and `example.in`, `<unique>`) with your own. Every resource to
create is listed in [`resources.md`](resources.md).

```
                Internet
                   │  HTTPS 443
          ┌────────▼─────────┐  public IP, NSG: 80/443 from anywhere, 22 from your IP only
          │ VM: Ubuntu 24.04 │  Caddy (TLS) ─► API container (port 8000)
          │  + Docker        │             └─► dashboard static files
          └──┬──────────┬────┘  managed identity → Key Vault
             │          │
   ┌─────────▼──────┐ ┌─▼────────────────────────────┐
   │ Azure Database │ │ Azure Communication Services │
   │ for PostgreSQL │ │ Email over SMTP: staff       │
   │ (Flexible)     │ │ invites, app sign-in codes   │
   └────────────────┘ └──────────────────────────────┘

   Recordings ──► each hospital's own Azure Blob container or S3 bucket (never NeuroCapture's)
```

**NeuroCapture stores no recordings** (decision 044). Every hospital connects **its own** Azure
Blob container or Amazon S3 bucket. Phones upload straight into it through short-lived links that
can write one recording and nothing else. NeuroCapture can never read, list or delete there; the
hospital's connector reads the files. Until a hospital's storage test passes, its phones cannot
record.

So the platform has **no storage account**. What you create instead:

- **Step 5b:** NeuroCapture's Azure app registration, so hospitals can choose Azure Blob.
- **Step 5c:** AWS credentials that can only assume roles, so hospitals can choose S3.

You need at least one of them. The API server holds no data: you can replace it, or run two or
more behind a load balancer.

---

## Step 1: Subscription basics

1. Use an account with MFA. Create a **budget** (Cost Management → Budgets) with e-mail alerts.
2. Install the Azure CLI on your computer, then sign in:

   ```bash
   az login
   az account set --subscription "<subscription name or id>"
   az group create -n nc-prod -l centralindia
   ```

## Step 2: Network

```bash
az network vnet create -g nc-prod -n nc-vnet --address-prefix 10.20.0.0/16 \
  --subnet-name app --subnet-prefix 10.20.1.0/24
```

The database gets its own delegated subnet in step 3.

## Step 3: Database (Azure Database for PostgreSQL – Flexible Server)

```bash
az postgres flexible-server create -g nc-prod -n nc-db-<unique> -l centralindia \
  --version 16 --tier GeneralPurpose --sku-name Standard_D2ds_v5 --storage-size 64 \
  --admin-user nc_admin --admin-password '<long random password>' \
  --vnet nc-vnet --subnet db --subnet-prefixes 10.20.2.0/24 \
  --backup-retention 14 --high-availability ZoneRedundant
az postgres flexible-server db create -g nc-prod -s nc-db-<unique> -d neurocapture
```

- For a pilot, use `--tier Burstable --sku-name Standard_B2s` and leave out `--high-availability`.
- **Private access (VNet):** the server has no public endpoint; only the API server's VNet
  reaches it. Data is encrypted at rest; TLS is required.
- You do **not** create tables. The API creates and upgrades all of them when it starts.

Database URL for the API:

```
postgresql+psycopg://nc_admin:<password>@nc-db-<unique>.postgres.database.azure.com:5432/neurocapture?sslmode=require
```

(Optional: create a separate application user with `psql` from the VM, as in [`aws.md`](aws.md)
step 3.)

## Step 4: E-mail (Azure Communication Services over SMTP)

1. **Email Communication Services:** Portal → create resource _Email Communication Services_
   (`nc-email`).
   - Add a **custom domain** (`example.in`). Add the TXT (verification), SPF and two DKIM records
     it shows to your DNS, then verify.
   - Add a DMARC record (`_dmarc` TXT `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.in`).
   - Under the domain → **MailFrom addresses**, add `no-reply@example.in`.
2. **Communication Services:** create resource _Communication Services_ (`nc-acs`), choosing the
   data location your policy needs. Then _Email → Domains → Connect domain_ to link the verified
   domain.
3. **SMTP credentials:** ACS SMTP signs in with a Microsoft Entra application.
   - Entra ID → App registrations → **New registration** (`nc-smtp`) → _Certificates & secrets_ →
     **New client secret**. Copy it now: it is the SMTP password.
   - On the `nc-acs` resource → _Access control (IAM)_, give the app a role that may send e-mail.
     Microsoft's guide "Create credentials for SMTP authentication" lists the exact permissions,
     or provides a ready role.
   - On `nc-acs` → **SMTP Usernames**, create a username for that app (e.g. `nc-mailer`).
     Otherwise use the form `<ACS resource name>.<application id>.<tenant id>`.
4. New ACS e-mail resources start with low sending limits. If you will invite many staff at once,
   request a **quota increase** (support request).
5. Settings for the API:

   ```
   NC_EMAIL_PROVIDER=smtp
   NC_SMTP_HOST=smtp.azurecomm.net
   NC_SMTP_PORT=587
   NC_SMTP_SECURITY=starttls
   NC_SMTP_USERNAME=<SMTP username from step 3>
   NC_SMTP_PASSWORD=<client secret>
   NC_MAIL_FROM=no-reply@example.in
   NC_MAIL_FROM_NAME=NeuroCapture
   ```

When the client secret expires (you choose 6–24 months), create a new one and update Key Vault
(step 6).

The platform sends staff invites and the patient app's sign-in codes (decision 043; the address
is used for that e-mail only and is not stored). Patient invites, reminders and SMS come from each
hospital's connector (step 11).

## Step 5: The server (VM)

```bash
az vm create -g nc-prod -n nc-api -l centralindia \
  --image Canonical:ubuntu-24_04-lts:server:latest --size Standard_D2s_v5 \
  --vnet-name nc-vnet --subnet app --public-ip-sku Standard --public-ip-address-allocation static \
  --admin-username azureuser --ssh-key-values ~/.ssh/id_ed25519.pub \
  --os-disk-size-gb 64 \
  --assign-identity
az vm open-port -g nc-prod -n nc-api --port 80,443 --priority 900
# Restrict SSH to your own IP (az vm create opens 22 to everyone):
az network nsg rule update -g nc-prod --nsg-name nc-apiNSG -n default-allow-ssh --source-address-prefixes <your.ip.address>/32
az vm show -g nc-prod -n nc-api -d --query publicIps -o tsv     # → DNS A records for api. and dashboard.
```

On the VM (`ssh azureuser@api.example.in`), install the tools:

```bash
sudo apt-get update && sudo apt-get install -y docker.io git postgresql-client
sudo usermod -aG docker azureuser && newgrp docker
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## Step 5b: Register NeuroCapture's Azure app (hospitals on Azure Blob)

Hospitals on Azure let **one app of yours** write into their container. You register it **once
per platform**, in your own Microsoft Entra tenant. Each hospital then approves it in theirs
(step 12).

You need the **Application Developer** role (or higher) in your tenant.

1. **Register the app.**
   - Azure portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
   - Name: `NeuroCapture recordings (India)` (one per market; use your market's name).
   - Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID
     tenant – Multitenant)**.
   - Redirect URI: leave empty.
   - **Register.** Copy the **Application (client) ID** from the Overview page.

   Or with the CLI:

   ```bash
   APP_ID=$(az ad app create --display-name "NeuroCapture recordings (India)" \
     --sign-in-audience AzureADMultipleOrgs --query appId -o tsv)
   az ad sp create --id "$APP_ID"          # its service principal in your own tenant
   echo "$APP_ID"
   ```

2. **API permissions:** none are needed. The app only gets storage roles that each hospital
   assigns on its own container. Remove the default `User.Read` permission if you like.
3. **Publisher details (recommended):** Branding & properties → set the publisher domain to your
   verified domain, plus a home page, privacy and terms URL. Hospital administrators see these when
   they approve the app. Consider Microsoft's publisher verification so the app shows as verified.
4. **Create a client secret.**
   - **Certificates & secrets** → **New client secret**, description `nc-api`, expiry 12 or
     24 months.
   - Copy the **Value** at once; it is shown only once.

   ```bash
   az ad app credential reset --id "$APP_ID" --display-name nc-api --years 1 --append --query password -o tsv
   ```

5. **Store the secret** in the key vault (step 6 creates the vault; come back here if needed):

   ```bash
   az keyvault secret set --vault-name nc-kv-<unique> -n azure-client-secret --value '<secret value>'
   ```

6. **Turn it on:**
   - In `api.env` (step 7): `NC_AZURE_CLIENT_ID=<application (client) id>`.
   - In `start-api.sh`: `-e NC_AZURE_CLIENT_SECRET="$(s azure-client-secret)"`.
   - Restart the API.
7. **Check.** Dashboard → **Platform settings** shows "Azure app registered" with your client ID,
   and the storage choices include **Azure Blob**.
8. **Before the secret expires,** create a new one (step 4 with `--append`), put it in the key
   vault, and restart the API. Then delete the old one. While the secret is expired, uploads to
   hospitals on Azure stop. Set a calendar reminder or an Entra expiry alert.

The client ID is not secret: hospitals see it on their set-up page. The same app works whether the
platform runs on Azure or AWS.

## Step 5c: AWS credentials for hospitals on S3

Hospitals on S3 create a role in **their** AWS account that trusts **your** AWS identity (with an
ExternalId, step 12 in [`aws.md`](aws.md)). A platform on Azure has no AWS instance role, so create
an AWS user that can do nothing but assume such roles:

1. In your AWS account (one per market is fine): IAM → **Users** → **Create user**
   `nc-platform-uploader`. No console access.
2. Inline policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{ "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "*" }]
   }
   ```

3. **Security credentials** → **Create access key** (use case: application running outside AWS).
4. Store it:

   ```bash
   az keyvault secret set --vault-name nc-kv-<unique> -n aws-access-key-id     --value '<access key id>'
   az keyvault secret set --vault-name nc-kv-<unique> -n aws-secret-access-key --value '<secret access key>'
   ```

5. In `api.env`: `NC_PLATFORM_AWS_PRINCIPAL=arn:aws:iam::<your-account-id>:user/nc-platform-uploader`.
   In `start-api.sh`: `-e NC_S3_ACCESS_KEY="$(s aws-access-key-id)" -e NC_S3_SECRET_KEY="$(s aws-secret-access-key)"`.

The hospital's role trusts exactly this ARN. Rotate the key yearly (create a second key, switch,
delete the old one).

## Step 6: Keys and secrets (Azure Key Vault)

On **your own computer**:

```bash
openssl genpkey -algorithm ed25519 -out platform-signing.pem
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out server-private.pem
openssl pkey -in server-private.pem -pubout -out server-public.pem

az keyvault create -g nc-prod -n nc-kv-<unique> -l centralindia --enable-rbac-authorization true
KV=$(az keyvault show -n nc-kv-<unique> --query id -o tsv)
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" --role "Key Vault Secrets Officer" --scope "$KV"
az keyvault secret set --vault-name nc-kv-<unique> -n platform-signing-key --file platform-signing.pem
az keyvault secret set --vault-name nc-kv-<unique> -n server-public-key   --file server-public.pem
az keyvault secret set --vault-name nc-kv-<unique> -n jwt-secret          --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name nc-kv-<unique> -n account-pepper      --value "$(openssl rand -hex 32)"   # never change after go-live
az keyvault secret set --vault-name nc-kv-<unique> -n db-url              --value 'postgresql+psycopg://nc_admin:<pw>@nc-db-<unique>.postgres.database.azure.com:5432/neurocapture?sslmode=require'
az keyvault secret set --vault-name nc-kv-<unique> -n smtp-username       --value '<SMTP username>'
az keyvault secret set --vault-name nc-kv-<unique> -n smtp-password       --value '<client secret>'
az keyvault secret set --vault-name nc-kv-<unique> -n azure-client-secret --value '<step 5b secret>'
# Let the VM read them (its managed identity):
az role assignment create --assignee-object-id "$(az vm show -g nc-prod -n nc-api --query identity.principalId -o tsv)" \
  --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$KV"
```

Keep `server-private.pem` **offline** (not in Azure and not on the server).

## Step 7: Run the API

On the VM:

```bash
sudo mkdir -p /srv/nc/keys && sudo chown azureuser /srv/nc
git clone https://github.com/Venkat77081/NeuroAnalysis.git /srv/nc/src
cd /srv/nc/src && git checkout main            # or a release tag
docker build -t neurocapture-api:1.0.0 backend/
```

`/srv/nc/start-api.sh` (run it as root: `sudo`). It reads the secrets at every start:

```bash
#!/bin/sh
set -eu
az login --identity --allow-no-subscriptions >/dev/null
s() { az keyvault secret show --vault-name nc-kv-<unique> -n "$1" --query value -o tsv; }
s platform-signing-key > /srv/nc/keys/platform-signing.pem
s server-public-key    > /srv/nc/keys/server-public.pem
chmod 600 /srv/nc/keys/*.pem && chown 10001 /srv/nc/keys/*.pem   # the container's user
docker rm -f nc-api 2>/dev/null || true
docker run -d --name nc-api --restart unless-stopped -p 127.0.0.1:8000:8000 \
  -v /srv/nc/keys:/keys:ro -v /srv/nc/src/config:/srv/config:ro \
  -e NC_DATABASE_URL="$(s db-url)" \
  -e NC_JWT_SECRET="$(s jwt-secret)" \
  -e NC_ACCOUNT_PEPPER="$(s account-pepper)" \
  -e NC_SMTP_USERNAME="$(s smtp-username)" \
  -e NC_SMTP_PASSWORD="$(s smtp-password)" \
  -e NC_AZURE_CLIENT_SECRET="$(s azure-client-secret)" \
  -e NC_S3_ACCESS_KEY="$(s aws-access-key-id)" \
  -e NC_S3_SECRET_KEY="$(s aws-secret-access-key)" \
  --env-file /srv/nc/api.env \
  neurocapture-api:1.0.0
```

Leave out the `NC_AZURE_CLIENT_SECRET` line if you skipped step 5b, and the two `NC_S3_*` lines if
you skipped step 5c.

`/srv/nc/api.env` (no secrets in it):

```bash
NC_PUBLIC_BASE_URL=https://api.example.in
NC_DASHBOARD_URL=https://dashboard.example.in
NC_CORS_ORIGINS=https://dashboard.example.in,https://localhost
NC_PLATFORM_SIGNING_KEY_PATH=/keys/platform-signing.pem
NC_PLATFORM_KEY_ID=platform-1
NC_SERVER_PUBLIC_KEY_PATH=/keys/server-public.pem
NC_SERVER_KEY_ID=server-1
# Recordings go to each hospital's own storage (decision 044). Keep development storage off:
NC_DEV_STORAGE=false
NC_AZURE_CLIENT_ID=<step 5b application (client) id>
NC_PLATFORM_AWS_PRINCIPAL=arn:aws:iam::<your-account-id>:user/nc-platform-uploader
NC_S3_REGION=ap-south-1
NC_REQUIRE_HOSPITAL_KEY=true
NC_ALLOW_LEGACY_REF_HASH=false
NC_EMAIL_PROVIDER=smtp
NC_SMTP_HOST=smtp.azurecomm.net
NC_SMTP_PORT=587
NC_SMTP_SECURITY=starttls
NC_MAIL_FROM=no-reply@example.in
NC_MAIL_FROM_NAME=NeuroCapture
NC_CONFIG_DIR=/srv/config
```

```bash
chmod +x /srv/nc/start-api.sh && sudo /srv/nc/start-api.sh
curl -s http://127.0.0.1:8000/health      # {"status":"ok", ... "checks": {"database": "ok", "storage": "hospital_owned"}}
```

If the container stops at once, read `docker logs nc-api`. A message starting with
`message delivery settings:` names the SMTP setting that is missing.

## Step 8: HTTPS and the dashboard

These are the same as AWS step 9 ([`aws.md`](aws.md#step-9-https-and-the-dashboard)):

1. Build the dashboard and copy `dist/` to `/srv/nc/dashboard`.
2. Write `config.json` with `https://api.example.in`.
3. Use the same `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`.

Caddy gets and renews the certificates itself (ports 80 and 443 must be open, step 5).

Alternative for the dashboard: **Azure Static Web Apps**. Add a `staticwebapp.config.json` with
`"navigationFallback": { "rewrite": "/index.html" }`.

## Step 9: First platform admin and a test e-mail

```bash
docker exec -it nc-api python -m app.admin create-platform-admin --email you@example.in --name "Your Name"
```

1. Open the printed link and set a password and two-step sign-in.
2. Onboard a test hospital with **your own** e-mail as its admin.
3. Check that the invite e-mail arrives. That confirms ACS works.

## Step 10: Operations

| Task               | How                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start after reboot | `sudo crontab -e` → `@reboot /srv/nc/start-api.sh` (the container also restarts itself)                                                                                       |
| Health             | Azure Monitor → Application Insights **availability test** on `https://api.example.in/health`, with an alert                                                                  |
| Logs               | `docker logs nc-api`; for central logs, install the Azure Monitor Agent and collect syslog, or run the container with `--log-driver syslog`                                   |
| Backups            | PostgreSQL automatic backups (14 days; add long-term retention if needed); the VM holds no data (Azure Backup for it is optional); recordings live in each hospital's storage |
| More servers       | The API keeps no files: add a second VM with the same `start-api.sh` and put both behind Azure Application Gateway or Load Balancer                                           |
| Update             | Back up first → `git pull` → `docker build -t neurocapture-api:<new> backend/` → edit the tag in `start-api.sh` → `sudo /srv/nc/start-api.sh`                                 |
| Config change      | Edit `config/*.json`, run `pnpm validate`, then `sudo /srv/nc/start-api.sh`. The app needs a new APK for the same change                                                      |
| Patching           | Ubuntu unattended upgrades (on by default); Azure Update Manager for scheduled reboots                                                                                        |

## Step 11: A hospital that runs its connector in Azure

Each hospital runs its **own** connector, in its own subscription and network ([`../connector.md`](../connector.md)).
If the hospital uses Azure:

1. **Network.** Put the connector in a VNet connected to the hospital network (VPN Gateway or
   ExpressRoute) so it reaches the FHIR server or database.
   - Publish it at `https://neurocapture-connector.hospital.in` through Application Gateway or
     Caddy on the VM, so doctors' browsers, clinic phones and the NeuroCapture platform can reach
     it.
   - Restrict who can reach it with NSGs or a WAF.
2. **Database.** A Burstable PostgreSQL Flexible Server (`Standard_B1ms`) or PostgreSQL on the
   same VM. Use `NCC_DATABASE_URL=postgresql+psycopg://…?sslmode=require`. The 5 tables are
   created on start.
3. **Server.** A small VM (`Standard_B2s`) with Docker. Build and run the connector image
   ([`../PRODUCTION.md`](../PRODUCTION.md) §5.4). Keep `/data` (signing key, **take keys**) on a
   managed disk covered by **Azure Backup**. Without the take keys, recordings can never be
   decrypted.
4. **Patient e-mail:** the hospital's own ACS Email (same steps as step 4, with the hospital's
   domain) or its mail server:

   ```
   NCC_EMAIL_PROVIDER=smtp
   NCC_SMTP_HOST=smtp.azurecomm.net
   NCC_SMTP_PORT=587
   NCC_SMTP_SECURITY=starttls
   NCC_SMTP_USERNAME=<hospital's ACS SMTP username>
   NCC_SMTP_PASSWORD=<client secret>
   NCC_MAIL_FROM=neurocapture@hospital.in
   NCC_MAIL_FROM_NAME=Sunrise Neuro Clinic
   ```

5. **Patient SMS.** Azure Communication Services SMS does not cover sending to Indian mobile
   numbers, so use **Twilio** (or an Indian gateway through the `http` adapter, decision 036):
   - **India DLT.** Register the hospital (principal entity), a sender ID (header) and two
     **transactional templates** whose text matches `patientInviteSms` and `reminderSms` in
     `config/messages/en.json`. Then complete Twilio's India registration with those IDs.

   ```
   NCC_SMS_PROVIDER=twilio
   NCC_TWILIO_ACCOUNT_SID=AC…
   NCC_TWILIO_AUTH_TOKEN=<token>
   NCC_TWILIO_MESSAGING_SERVICE_SID=MG…     # or NCC_SMS_FROM=<sender ID / number>
   NCC_SMS_DEFAULT_COUNTRY_CODE=+91
   ```

   - **With an Indian gateway (MSG91, Gupshup, Kaleyra, …):** run a small adapter that accepts
     `POST {to, body, template, dlt_template_id, dlt_entity_id, sender}` and calls the gateway.

   ```
   NCC_SMS_PROVIDER=http
   NCC_SMS_HTTP_URL=https://sms-adapter.hospital.in/send
   NCC_SMS_HTTP_TOKEN=<shared secret>
   NCC_SMS_FROM=SNRISE
   NCC_SMS_DLT_ENTITY_ID=1201xxxxxxxxxxxxxxx
   NCC_SMS_DLT_TEMPLATE_IDS={"patientInviteSms": "1207xxxxxxxxxxxxxxx", "reminderSms": "1207xxxxxxxxxxxxxxx"}
   ```

6. **Test.** Register the connector in the dashboard, then run Data connections → **Test**.
   Invite yourself by e-mail and by SMS from "Invite patients": each row should say "Sent".
   "Not sent" means the mail or SMS settings were refused; the connector log says which (by type,
   never the address).

## Step 12: A hospital connects its own Azure Blob container

Every hospital must do this (or the S3 version in [`aws.md`](aws.md) step 12) before its phones
can record. Until then the dashboard says **Recording is off**, the clinic phone says "Recording is
not ready" and patients see the hospital as "Getting ready".

NeuroCapture can only **write** into the container: it can never read, list or delete. The
hospital's connector reads the recordings. The files are already encrypted on the phone with the
hospital's take key.

**At the hospital** (its Azure administrator; the dashboard's Data connections → Recording storage
→ **Your own Azure Blob container** shows these steps with the real IDs filled in):

1. **Create the storage**, in the hospital's subscription and region:

   ```bash
   az storage account create -g <rg> -n <account> -l <region> --sku Standard_ZRS --kind StorageV2 \
     --https-only true --min-tls-version TLS1_2 --allow-blob-public-access false
   az storage account blob-service-properties update -g <rg> --account-name <account> \
     --enable-delete-retention true --delete-retention-days 30 --enable-versioning true
   az storage container create --account-name <account> -n neurocapture-takes --auth-mode login
   ```

   Size: a session is about 0.3–0.5 GB. Set the hospital's own retention rules.

2. **Approve NeuroCapture's app** in the hospital tenant. A Global Administrator (or Privileged
   Role Administrator) opens the approval link shown in the dashboard, or runs
   `az ad sp create --id <NeuroCapture client id>`.
3. **Create the custom role** the dashboard shows. It allows writing blobs only:

   ```bash
   az role definition create --role-definition @neurocapture-uploader.json
   ```

4. **Assign the app two roles:**
   - **Storage Blob Delegator** on the storage account (lets it sign upload links);
   - the custom role on the container.

   ```bash
   SP=$(az ad sp show --id <NeuroCapture client id> --query id -o tsv)
   az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
     --role "Storage Blob Delegator" --scope <storage account id>
   az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
     --role "NeuroCapture recording uploader" --scope <storage account id>/blobServices/default/containers/neurocapture-takes
   ```

5. **Let the connector read:** give the connector's managed identity **Storage Blob Data Reader**
   on the container. (Or set `NCC_AZURE_STORAGE_KEY` on the connector, if the hospital uses
   account keys.)
6. **In the dashboard:** storage account, container, tenant ID → **Test and save**. The test signs
   in, uploads a test block and checks that reading is refused. It saves only if the upload works.
   The card then says **Phones can record**.

Role assignments can take a few minutes to apply; if the first test fails with "not allowed", wait
five minutes and test again.

## Costs (rough, pay-as-you-go, before tax; similar in East US and Central India)

| Item                                      | Pilot (1 hospital)                                         |
| ----------------------------------------- | ---------------------------------------------------------- |
| VM Standard_D2s_v5 + 64 GB OS disk        | ~ US$ 75 / month (B2ms: ~ US$ 35)                          |
| PostgreSQL Flexible, Burstable B2s, 64 GB | ~ US$ 35 / month (General Purpose + HA several times more) |
| ACS Email                                 | ~ US$ 0.25 per 1,000 e-mails + data                        |

Prices change; check the Azure Pricing Calculator.
