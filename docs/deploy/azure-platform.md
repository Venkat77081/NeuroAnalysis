# Azure deployment: the NeuroCapture platform

This guide is for **you, the NeuroCapture operator**. It sets up the platform for one market in
your own Azure subscription. The platform is:

- the API;
- the web dashboards for platform admins, hospital admins, the front desk and doctors;
- the server address built into the Android app.

Each hospital runs its own side in **its own** subscription. That guide is
[`azure-hospital.md`](azure-hospital.md); send it to the hospital's IT team.

Background: [`../PRODUCTION.md`](../PRODUCTION.md). The older combined guide, [`azure.md`](azure.md),
has the same platform steps.

---

## 1. What the platform holds, and what it never holds

| The platform keeps                                                                                                                                                                                                                             | The platform never keeps                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <ul><li>Hospitals and staff accounts</li><li>Patients **by random NCID only**</li><li>Appointments, sessions and upload status</li><li>Phone details (model, fps, memory, storage)</li><li>Pass/fail health checks of each connector</li></ul> | <ul><li>**Patient names, MRNs, phone numbers or addresses.** These stay in the hospital's records, reached through its connector. A test enforces this.</li><li>**Recordings** (decision 044). Phones upload straight into each hospital's own Blob container.</li><li>**Biomarker results.** They are computed at the hospital, next to its connector (decision 027).</li></ul> |

That is why the platform has **no storage account for videos**.

## 2. Architecture

```
  Patients' and clinic phones          Staff browsers (dashboard)
            │  HTTPS                          │  HTTPS
            ▼                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │  api.example.in / dashboard.example.in  (public IP, NSG 443) │
   │  VM nc-api: Ubuntu 24.04 + Docker                         │
   │    Caddy (TLS, Let's Encrypt) ──► API container :8000     │
   │                              └──► dashboard static files  │
   │    managed identity ──► Key Vault (secrets)               │
   └───────┬──────────────────────────────┬───────────────────┘
           │ private VNet                 │ SMTP 587
   ┌───────▼───────────────┐   ┌──────────▼─────────────────────┐
   │ PostgreSQL Flexible   │   │ Azure Communication Services    │
   │ (private, backups)    │   │ Email: staff invites, app codes │
   └───────────────────────┘   └─────────────────────────────────┘

   Phones ──(write-only upload link signed by the platform)──► hospital's own Blob container
   Browser ──(10-minute token from the platform)──► hospital connector (names, videos, reports)
```

## 3. Resources to create (per market)

Run **one platform per market** so data stays in the market: **Central India** (`centralindia`)
for India, **East US / East US 2** for the US. Examples below use `centralindia`, the domain
`example.in` and the resource group `nc-prod`. Replace `<unique>` with a short suffix of your own.

| #   | Resource                                        | Name (example)                           | Size / settings                                                                                                                     | Why                                                                        |
| --- | ----------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Resource group + **budget alert**               | `nc-prod`                                | Cost Management → Budgets                                                                                                           | One place for everything; cost control                                     |
| 2   | Virtual network                                 | `nc-vnet` (10.20.0.0/16)                 | subnets `app` 10.20.1.0/24, `db` 10.20.2.0/24 (delegated)                                                                           | The database is never on the internet                                      |
| 3   | **Azure Database for PostgreSQL – Flexible**    | `nc-db-<unique>`                         | PostgreSQL 16; pilot: Burstable `B2s`, 64 GB; production: General Purpose `D2ds_v5`, zone-redundant HA; backups 14–35 days; private | Platform data (§1). Tables are created by the API itself                   |
| 4   | **Virtual machine**                             | `nc-api`                                 | Ubuntu 24.04, `Standard_D2s_v5` (pilot `B2ms`), 64 GB Premium SSD, static public IP, **system-assigned managed identity**           | Runs the API container, Caddy and the dashboard                            |
| 5   | Network security group (created with the VM)    | `nc-apiNSG`                              | 80 and 443 from anywhere; 22 **only from your IP** (or use Azure Bastion)                                                           | Only HTTPS is public                                                       |
| 6   | **Key Vault** (RBAC mode)                       | `nc-kv-<unique>`                         | soft delete + purge protection on                                                                                                   | Holds every secret (§6)                                                    |
| 7   | **Email Communication Services** + domain       | `nc-email`                               | custom domain `example.in` with SPF, DKIM and DMARC; sender `no-reply@example.in`                                                   | Staff invites and the patient app's sign-in codes                          |
| 8   | **Communication Services**                      | `nc-acs`                                 | linked to the e-mail domain; data location India (or US)                                                                            | SMTP sending                                                               |
| 9   | Entra app registration (single tenant)          | `nc-smtp`                                | client secret, role on `nc-acs`, SMTP username                                                                                      | The SMTP login                                                             |
| 10  | **Entra app registration (multi-tenant)**       | `NeuroCapture recordings (India)`        | no API permissions; client secret 12–24 months                                                                                      | Lets hospitals give the platform **write-only** access to their containers |
| 11  | DNS records                                     | `api.example.in`, `dashboard.example.in` | A records to the VM's public IP (Azure DNS or your registrar)                                                                       | Public HTTPS addresses                                                     |
| 12  | **Application Insights** + Log Analytics        | `nc-insights`, `nc-logs`                 | availability test on `/health` every 5 min, e-mail alert                                                                            | Know when the API is down                                                  |
| 13  | Azure Monitor Agent (on the VM)                 | –                                        | collect syslog and Docker logs; alerts for CPU and disk                                                                             | Central logs                                                               |
| 14  | Optional: AWS IAM user                          | `nc-platform-uploader`                   | may only `sts:AssumeRole`                                                                                                           | Only if some hospitals keep recordings in **Amazon S3**                    |
| 15  | Optional: Application Gateway (WAF v2) + 2nd VM | `nc-agw`                                 | in front of two identical API VMs                                                                                                   | More capacity / no single server. The API keeps no files                   |

The **Android app** needs no Azure resource. It is built once per market with that market's API
address (§10).

## 4. Step by step

### 4.1 Subscription, resource group, network

```bash
az login
az account set --subscription "<subscription>"
az group create -n nc-prod -l centralindia
az network vnet create -g nc-prod -n nc-vnet --address-prefix 10.20.0.0/16 \
  --subnet-name app --subnet-prefix 10.20.1.0/24
```

Then add a budget with e-mail alerts: Portal → Cost Management → Budgets.

### 4.2 Database

```bash
az postgres flexible-server create -g nc-prod -n nc-db-<unique> -l centralindia \
  --version 16 --tier Burstable --sku-name Standard_B2s --storage-size 64 \
  --admin-user nc_admin --admin-password '<long random password>' \
  --vnet nc-vnet --subnet db --subnet-prefixes 10.20.2.0/24 \
  --backup-retention 14
az postgres flexible-server db create -g nc-prod -s nc-db-<unique> -d neurocapture
```

- **Production:** use `--tier GeneralPurpose --sku-name Standard_D2ds_v5 --high-availability ZoneRedundant`.
- **Private access:** only the VNet reaches the server.
- **Tables:** don't create any. The API creates them on start (`alembic upgrade head`, migrations `0001`–`0026`).

The database URL for the API:

```
postgresql+psycopg://nc_admin:<password>@nc-db-<unique>.postgres.database.azure.com:5432/neurocapture?sslmode=require
```

### 4.3 E-mail (Azure Communication Services)

1. Create **Email Communication Services** (`nc-email`).
   1. Add the custom domain `example.in`.
   2. Add the TXT, SPF and two DKIM records to your DNS, then **Verify**.
   3. Add DMARC: a `_dmarc` TXT record with `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.in`.
   4. Under **MailFrom addresses**, add `no-reply@example.in`.
2. Create **Communication Services** (`nc-acs`), with data location **India**. Then Email →
   Domains → **Connect domain**.
3. Create the SMTP login:
   1. Entra ID → App registrations → **New registration** `nc-smtp` → Certificates & secrets →
      **New client secret**. Copy the secret.
   2. On `nc-acs` → Access control (IAM), give `nc-smtp` a role that may send e-mail (see
      Microsoft's page "Create credentials for SMTP authentication").
   3. On `nc-acs` → **SMTP Usernames**, create `nc-mailer` for that app.
4. If you will invite many staff at once, ask for a **sending quota increase** (support request).

The platform sends only staff invites and the patient app's sign-in codes. It never sends SMS.
Patient invites and reminders come from each hospital's connector.

### 4.4 The multi-tenant app for hospitals' Blob containers

You register this app once per market. Each hospital approves it in its own tenant and gives it a
**write-only** role on its container.

```bash
APP_ID=$(az ad app create --display-name "NeuroCapture recordings (India)" \
  --sign-in-audience AzureADMultipleOrgs --query appId -o tsv)
az ad sp create --id "$APP_ID"
az ad app credential reset --id "$APP_ID" --display-name nc-api --years 1 --append --query password -o tsv
echo "client id: $APP_ID"
```

- **Branding:** under Branding & properties, set the publisher domain, a home page, and the
  privacy and terms URLs. Hospital admins see these when they approve the app. Publisher
  verification is recommended.
- **API permissions:** none are needed.
- **Secret expiry:** put a calendar reminder **before** the secret expires. While it is expired,
  uploads to hospitals on Azure stop.

### 4.5 The VM

```bash
az vm create -g nc-prod -n nc-api -l centralindia \
  --image Canonical:ubuntu-24_04-lts:server:latest --size Standard_D2s_v5 \
  --vnet-name nc-vnet --subnet app --public-ip-sku Standard --public-ip-address-allocation static \
  --admin-username azureuser --ssh-key-values ~/.ssh/id_ed25519.pub \
  --os-disk-size-gb 64 --assign-identity
az vm open-port -g nc-prod -n nc-api --port 80,443 --priority 900
az network nsg rule update -g nc-prod --nsg-name nc-apiNSG -n default-allow-ssh \
  --source-address-prefixes <your.ip.address>/32
az vm show -g nc-prod -n nc-api -d --query publicIps -o tsv
```

The last command prints the VM's public IP.

- **DNS:** create the A records `api.example.in` and `dashboard.example.in`, both pointing to
  that IP.
- **Hospitals' network rules:** give the same IP to each hospital. Their connector firewall
  allows the platform's calls from it.

On the VM:

```bash
sudo apt-get update && sudo apt-get install -y docker.io git
sudo usermod -aG docker azureuser && newgrp docker
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### 4.6 Keys and Key Vault

Generate the keys **on your own computer**, not on the server:

```bash
openssl genpkey -algorithm ed25519 -out platform-signing.pem          # signs calls to connectors
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out server-private.pem
openssl pkey -in server-private.pem -pubout -out server-public.pem

az keyvault create -g nc-prod -n nc-kv-<unique> -l centralindia --enable-rbac-authorization true \
  --enable-purge-protection true
KV=$(az keyvault show -n nc-kv-<unique> --query id -o tsv)
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --role "Key Vault Secrets Officer" --scope "$KV"

az keyvault secret set --vault-name nc-kv-<unique> -n platform-signing-key --file platform-signing.pem
az keyvault secret set --vault-name nc-kv-<unique> -n server-public-key   --file server-public.pem
az keyvault secret set --vault-name nc-kv-<unique> -n jwt-secret          --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name nc-kv-<unique> -n account-pepper      --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name nc-kv-<unique> -n db-url              --value '<database URL from 4.2>'
az keyvault secret set --vault-name nc-kv-<unique> -n smtp-username       --value '<SMTP username>'
az keyvault secret set --vault-name nc-kv-<unique> -n smtp-password       --value '<nc-smtp client secret>'
az keyvault secret set --vault-name nc-kv-<unique> -n azure-client-secret --value '<4.4 secret>'

az role assignment create \
  --assignee-object-id "$(az vm show -g nc-prod -n nc-api --query identity.principalId -o tsv)" \
  --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$KV"
```

- Keep `server-private.pem` **offline**: not in Azure, and not on the server.
- **Never change `account-pepper`** after go-live: patients would lose their app accounts. Restrict
  who can read it.

### 4.7 Build and run the API

```bash
sudo mkdir -p /srv/nc/keys && sudo chown azureuser /srv/nc
git clone https://github.com/Venkat77081/NeuroAnalysis.git /srv/nc/src
cd /srv/nc/src && git checkout <release tag or main>
docker build -t neurocapture-api:1.0.0 backend/
```

`/srv/nc/api.env` holds the settings that are not secret:

```bash
NC_PUBLIC_BASE_URL=https://api.example.in
NC_DASHBOARD_URL=https://dashboard.example.in
NC_CORS_ORIGINS=https://dashboard.example.in,https://localhost
NC_PLATFORM_SIGNING_KEY_PATH=/keys/platform-signing.pem
NC_PLATFORM_KEY_ID=platform-1
NC_SERVER_PUBLIC_KEY_PATH=/keys/server-public.pem
NC_SERVER_KEY_ID=server-1
NC_DEV_STORAGE=false
NC_AZURE_CLIENT_ID=<4.4 client id>
NC_REQUIRE_HOSPITAL_KEY=true
NC_ALLOW_LEGACY_REF_HASH=false
NC_EMAIL_PROVIDER=smtp
NC_SMTP_HOST=smtp.azurecomm.net
NC_SMTP_PORT=587
NC_SMTP_SECURITY=starttls
NC_MAIL_FROM=no-reply@example.in
NC_MAIL_FROM_NAME=NeuroCapture
NC_CONFIG_DIR=/srv/config
# Only if some hospitals use Amazon S3 (resource 14):
# NC_PLATFORM_AWS_PRINCIPAL=arn:aws:iam::<account>:user/nc-platform-uploader
# NC_S3_REGION=ap-south-1
```

- `https://localhost` in `NC_CORS_ORIGINS` is the Android app's WebView. Keep it.

`/srv/nc/start-api.sh` reads the secrets from Key Vault at every start. Run it with `sudo`:

```bash
#!/bin/sh
set -eu
az login --identity --allow-no-subscriptions >/dev/null
s() { az keyvault secret show --vault-name nc-kv-<unique> -n "$1" --query value -o tsv; }
s platform-signing-key > /srv/nc/keys/platform-signing.pem
s server-public-key    > /srv/nc/keys/server-public.pem
chmod 600 /srv/nc/keys/*.pem && chown 10001 /srv/nc/keys/*.pem
docker rm -f nc-api 2>/dev/null || true
docker run -d --name nc-api --restart unless-stopped -p 127.0.0.1:8000:8000 \
  -v /srv/nc/keys:/keys:ro -v /srv/nc/src/config:/srv/config:ro \
  -e NC_DATABASE_URL="$(s db-url)" \
  -e NC_JWT_SECRET="$(s jwt-secret)" \
  -e NC_ACCOUNT_PEPPER="$(s account-pepper)" \
  -e NC_SMTP_USERNAME="$(s smtp-username)" \
  -e NC_SMTP_PASSWORD="$(s smtp-password)" \
  -e NC_AZURE_CLIENT_SECRET="$(s azure-client-secret)" \
  --env-file /srv/nc/api.env \
  neurocapture-api:1.0.0
```

```bash
chmod +x /srv/nc/start-api.sh && sudo /srv/nc/start-api.sh
curl -s http://127.0.0.1:8000/health
```

`/health` should return `"status":"ok"`, with `"database": "ok"` and `"storage": "hospital_owned"`.

If the container stops, run `docker logs nc-api`. A line starting with `message delivery
settings:` names the missing mail setting.

### 4.8 Dashboard and HTTPS

The dashboard needs Node 22 and pnpm. Build it on your computer or on the VM:

```bash
pnpm install && pnpm --filter @neurocapture/dashboard build
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
    header Strict-Transport-Security "max-age=31536000"
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets and renews the TLS certificates itself; ports 80 and 443 must stay open.

There is one dashboard for every hospital. Each hospital's connector must allow this dashboard's
origin (`NCC_CORS_ORIGINS`).

### 4.9 First platform admin

```bash
docker exec -it nc-api python -m app.admin create-platform-admin --email you@example.in --name "Your Name"
```

1. Open the printed link, then set a password and two-step sign-in.
2. Dashboard → **Platform settings** should say "Azure app registered".

### 4.10 Monitoring and start-up

- **Application Insights:** add an availability test on `https://api.example.in/health` every
  5 minutes, with an e-mail alert.
- **Start after a reboot:** `sudo crontab -e` → `@reboot /srv/nc/start-api.sh`.
- **Logs:** install the Azure Monitor Agent. Collect syslog and Docker logs (run the container with
  `--log-driver syslog`), and add alerts for CPU over 80 % and disk over 80 %.
- **Updates:** Azure Update Manager for monthly patching.

## 5. Bringing a hospital onto the platform

Do these steps **in this order**:

1. **You:** Dashboard → Hospitals → **Onboard**. Enter the name, region and the hospital admin's
   e-mail. The admin receives an invite.
2. **You:** send the hospital three things:
   - [`azure-hospital.md`](azure-hospital.md);
   - the platform address `https://api.example.in` and the platform's public IP;
   - the multi-tenant **client ID** from 4.4.

   The dashboard shows them the site ID and the platform key fingerprint.

3. **Hospital IT:** follows [`azure-hospital.md`](azure-hospital.md). They:
   - set up the connector;
   - register it;
   - create the take key;
   - connect their Blob container.
4. **Check:** Hospitals → the hospital shows **Can record** and the connector health checks pass.

## 6. Secrets: what, where, and if lost

| Key Vault secret         | Used as                                | If lost or changed                                                                       |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `platform-signing-key`   | `NC_PLATFORM_SIGNING_KEY_PATH`         | Every connector must pin the new key fingerprint                                         |
| `server-public-key`      | `NC_SERVER_PUBLIC_KEY_PATH`            | Older phones only (hospital take keys are used instead)                                  |
| `jwt-secret`             | `NC_JWT_SECRET`                        | Everyone signs in again                                                                  |
| **`account-pepper`**     | `NC_ACCOUNT_PEPPER`                    | **Patients lose their app accounts and every hospital must re-invite. Never change it.** |
| `db-url`                 | `NC_DATABASE_URL`                      | Rotate the database password                                                             |
| `smtp-username/password` | `NC_SMTP_USERNAME`, `NC_SMTP_PASSWORD` | Staff invites and app codes stop until rotated                                           |
| `azure-client-secret`    | `NC_AZURE_CLIENT_SECRET`               | **Uploads to hospitals on Azure stop until rotated**                                     |

## 7. Operations

| Task          | How                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update        | Back up the database → `git pull` (or check out the new tag) → `docker build -t neurocapture-api:<new> backend/` → change the tag in `start-api.sh` → `sudo /srv/nc/start-api.sh` |
| Config change | Edit `config/*.json`, run `pnpm validate`, restart the API. The app needs a new build for the same change                                                                         |
| Backups       | PostgreSQL automatic backups (add long-term retention if your policy needs it). The VM holds no data; Key Vault has soft delete                                                   |
| Scale out     | A second VM with the same `start-api.sh`, both behind Application Gateway (resource 15)                                                                                           |
| Rotate        | Rotate the `nc-smtp` and multi-tenant app secrets before they expire: add the new secret, put it in Key Vault, restart, then delete the old one                                   |

## 8. Rough monthly cost (pay-as-you-go, before tax)

| Item                                           | Pilot        | Production                   |
| ---------------------------------------------- | ------------ | ---------------------------- |
| VM (B2ms / D2s_v5) + 64 GB disk                | ~ US$ 35     | ~ US$ 75 (× 2 with a 2nd VM) |
| PostgreSQL Flexible (B2s / D2ds_v5 + HA)       | ~ US$ 35     | ~ US$ 300                    |
| Application Gateway WAF v2 (optional)          | –            | ~ US$ 250                    |
| Key Vault, Monitor, ACS Email (~ 0.25 / 1,000) | under US$ 15 | under US$ 40                 |

Check the Azure Pricing Calculator; prices change.

## 9. Go-live checklist (platform)

- [ ] `curl https://api.example.in/health` → `ok`, storage `hospital_owned`
- [ ] `https://dashboard.example.in` opens; the platform admin signed in with two-step sign-in
- [ ] A test staff invite e-mail arrives (ACS works)
- [ ] Platform settings: "Azure app registered"
- [ ] Database backups on; Key Vault purge protection on; `server-private.pem` and a copy of
      `account-pepper` stored offline in two places
- [ ] SSH limited to your IP; only 80/443 public
- [ ] Availability alert on `/health`
- [ ] Release app built with this market's address and tested end to end with one hospital (§10)

## 10. The Android app (no Azure resources)

1. Build the release with the market's API address built in:
   `VITE_SERVER_URL=https://api.example.in` (or `upload.defaultEndpoint` in `config/session.json`).
   Use GitHub Actions → **Release (pilot)** ([`../release.md`](../release.md)) or a local build
   ([`../PRODUCTION.md`](../PRODUCTION.md) §6).
2. Keep the signing keystore in two safe places. Without it, the app can never be updated.
3. Distribution:
   - **Patients:** Google Play.
   - **Clinic phones:** the APK, installed through the hospital's MDM or Firebase App
     Distribution.
