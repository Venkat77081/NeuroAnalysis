# Azure deployment: the hospital side (connector, recordings, biomarkers)

This guide is for a **hospital's or clinic's IT team** (the "client"). It sets up NeuroCapture's
hospital side in **the hospital's own Azure subscription**. Everything created here belongs to the
hospital. NeuroCapture cannot read it.

The NeuroCapture platform (API and dashboards) is run by NeuroCapture: see
[`azure-platform.md`](azure-platform.md). Background: [`../connector.md`](../connector.md) and
[`../biomarkers.md`](../biomarkers.md).

---

## 1. What runs at the hospital, and why

| Part                   | What it does                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connector**          | <ul><li>The only part of NeuroCapture that knows who a patient is.</li><li>Reads patients **live** from the hospital's FHIR R4 server or read-only SQL views, and never copies records.</li><li>Keeps the NCID ↔ MRN map.</li><li>Sends patient invites and reminders by e-mail and SMS.</li><li>Writes the clinical activity log.</li><li>Decrypts recordings for doctors.</li></ul> |
| **Biomarker analysis** | Runs inside the connector (the analysis image). It analyses every new take on its own (Finger Tapping, Finger-to-Finger, Forearm Roll, Facial Activation, Stand and Walk) and keeps the report at the hospital                                                                                                                                                                        |
| **Recordings storage** | The hospital's own Blob container. **Required:** phones cannot record until it passes its test. Phones upload encrypted files into it, with links that can write one file and nothing else                                                                                                                                                                                            |
| **Take key**           | The hospital's RSA key. Phones encrypt each recording for it. It never leaves the connector. **If it is lost, recordings can never be opened**                                                                                                                                                                                                                                        |

What the NeuroCapture platform learns: NCIDs, the invite channel, upload status and pass/fail health
results. It never learns names, MRNs, contact details, videos or biomarker results.

## 2. Architecture

```
 Hospital network (on-premises)                 Hospital's Azure subscription (resource group nc-hosp)
 ┌──────────────────────────┐   VPN Gateway /   ┌─────────────────────────────────────────────────────┐
 │ EHR / HIS: FHIR R4 or SQL │◄─ ExpressRoute ──►│ VNet 10.50.0.0/16                                   │
 │ Doctors' and desk PCs     │                   │  ┌──────────────────────────────────────────────┐  │
 │ Clinic phones (Wi-Fi)     │──── HTTPS ───────►│  │ VM nc-connector (Ubuntu + Docker)            │  │
 └──────────────────────────┘                   │  │  Caddy TLS :443 ──► connector :8100          │  │
                                                │  │  data disk /srv/ncc/data: signing key,       │  │
 NeuroCapture platform (fixed IP) ─ HTTPS ─────►│  │    TAKE KEYS (backed up)                      │  │
   health checks, signed calls                  │  │  managed identity ─► Key Vault, Blob          │  │
                                                │  └───────┬──────────────────────┬───────────────┘  │
                                                │          │ private              │                    │
                                                │  ┌───────▼─────────┐  ┌─────────▼──────────────┐   │
                                                │  │ PostgreSQL       │  │ Storage account        │   │
                                                │  │ Flexible (B1ms)  │  │ container               │   │
                                                │  │ NCID↔MRN, logs   │  │ neurocapture-takes      │◄──┼── Phones anywhere:
                                                │  └─────────────────┘  │ (encrypted takes,       │   │   write-only upload
                                                │                       │  encrypted reports)     │   │   links from the platform
                                                │                       └────────────────────────┘   │
                                                └─────────────────────────────────────────────────────┘
```

## 3. Resources to create (in the hospital's subscription)

Examples use region `centralindia`, resource group `nc-hosp`, and the hospital domain
`hospital.in`.

| #   | Resource                                       | Name (example)                          | Size / settings                                                                                                                                               | Why                                                                                |
| --- | ---------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Resource group + budget alert                  | `nc-hosp`                               | same region as the platform's market                                                                                                                          | Keeps NeuroCapture separate in the hospital's subscription                         |
| 2   | Virtual network                                | `nc-hosp-vnet` (10.50.0.0/16)           | subnets `app` 10.50.1.0/24, `db` 10.50.2.0/24 (delegated), `GatewaySubnet` 10.50.255.0/27                                                                     | Private network for the connector and its database                                 |
| 3   | **VPN Gateway** (or ExpressRoute)              | `nc-hosp-vpngw`                         | Site-to-Site VPN (`VpnGw1`) to the hospital firewall, with a local network gateway for the hospital's address ranges                                          | The connector must reach the EHR (FHIR or SQL); staff PCs reach the connector      |
| 4   | **VM: connector + analysis**                   | `nc-connector`                          | Ubuntu 24.04, **`Standard_D4s_v5`** (4 vCPU, 16 GB) with analysis; `Standard_B2s` without; 64 GB OS disk; **system-assigned managed identity**                | Runs the connector (and the biomarker analysis) in Docker                          |
| 5   | **Managed data disk**                          | `nc-connector-data`                     | 64 GB Premium SSD, mounted at `/srv/ncc/data`                                                                                                                 | Holds the signing key and **take keys**, separate from the OS                      |
| 6   | Static public IP + NSG                         | `nc-connector-ip`, `nc-connectorNSG`    | 443 only from: the **platform's IP**, the hospital's public ranges or VPN; 80 for certificate renewal; SSH only over the VPN                                  | The platform, doctors' browsers and clinic phones must reach the connector         |
| 7   | **Azure Database for PostgreSQL – Flexible**   | `nc-hosp-db-<unique>`                   | PostgreSQL 16, Burstable **`B1ms`**, 32 GB, private (VNet), backups 35 days, geo-redundant backup if policy requires                                          | NCID ↔ MRN map, activity log, reviews, remarks, biomarker runs, messaging settings |
| 8   | **Storage account + container**                | `nchosp<unique>` / `neurocapture-takes` | StorageV2, **ZRS**, HTTPS only, TLS 1.2, **no public blob access**, soft delete 30 days, versioning; public network endpoint **on** (phones upload from home) | The hospital's recordings and encrypted reports                                    |
| 9   | Custom role                                    | `NeuroCapture recording uploader`       | blob **write** only: no read, list or delete                                                                                                                  | What NeuroCapture's app may do in the container                                    |
| 10  | Enterprise application (approval)              | `NeuroCapture recordings (India)`       | NeuroCapture's multi-tenant app, approved by a Global Administrator                                                                                           | Lets the platform sign write-only upload links                                     |
| 11  | **Key Vault**                                  | `nc-hosp-kv-<unique>`                   | RBAC, purge protection; VM identity = Secrets User                                                                                                            | Database password, SMTP and SMS secrets, FHIR token                                |
| 12  | **Recovery Services vault** (Azure Backup)     | `nc-hosp-backup`                        | daily VM + data-disk backup, 30 days; optionally a weekly copy of the take keys to an offline place                                                           | **Without the take keys, recordings cannot be decrypted, ever**                    |
| 13  | E-mail: **ACS Email** (or the hospital's SMTP) | `nc-hosp-email`, `nc-hosp-acs`          | the hospital's domain, SPF/DKIM/DMARC, sender `neurocapture@hospital.in`                                                                                      | Patient invites and reminders by e-mail                                            |
| 14  | SMS (outside Azure)                            | Twilio or an Indian gateway             | India: DLT entity, sender ID and two transactional templates                                                                                                  | Patient invites and reminders by SMS. ACS SMS does not send to Indian numbers      |
| 15  | DNS record + TLS                               | `neurocapture-connector.hospital.in`    | A record to the public IP; Caddy gets the certificate. Or Application Gateway with the hospital's certificate                                                 | The connector's HTTPS address                                                      |
| 16  | Monitoring                                     | Log Analytics + alerts                  | Azure Monitor Agent; alerts on the VM being down, disk over 80 %, `/health` failing                                                                           | Know when it breaks                                                                |
| 17  | Optional: Application Gateway (WAF v2)         | `nc-hosp-agw`                           | in front of the VM, with the hospital's certificate                                                                                                           | If hospital policy requires a WAF                                                  |

**Biomarker analysis sizing.** One 15-second take takes about 20–60 s on 4 vCPU. One take runs at
a time, and a GPU is not needed. For more than about 300 takes a day, use `Standard_D8s_v5`.

## 4. Before you start: get these from NeuroCapture

1. **The platform's address:** `https://api.example.in`.
2. **The platform's public IP,** for your firewall rule.
3. **NeuroCapture's multi-tenant app client ID**.
4. **The hospital admin invite:** your hospital admin signs in to `https://dashboard.example.in`.
   Under Data connections they will see:
   - the **site ID**;
   - the **platform key fingerprint** (`NCC_PLATFORM_KEY_SHA256`);
   - the storage set-up steps, with your IDs filled in.

You also need from your own teams:

- **FHIR:** the FHIR R4 base URL, the identifier system that holds the MRN, and a read-only token.
- **Or SQL:** a read-only SQL user on four views (`connector/sql/sample_views.sql`).

## 5. Step by step

### 5.1 Resource group, network, VPN

```bash
az login && az account set --subscription "<hospital subscription>"
az group create -n nc-hosp -l centralindia
az network vnet create -g nc-hosp -n nc-hosp-vnet --address-prefix 10.50.0.0/16 \
  --subnet-name app --subnet-prefix 10.50.1.0/24
az network vnet subnet create -g nc-hosp --vnet-name nc-hosp-vnet -n GatewaySubnet --address-prefixes 10.50.255.0/27
```

Create the Site-to-Site VPN (Portal → Virtual network gateways, `VpnGw1`). Then add a **local
network gateway** with the hospital firewall's public IP and the hospital's address ranges (EHR
servers, staff PCs, clinic Wi-Fi), and a connection with a shared key. ExpressRoute works the same
way, if the hospital has it.

Check from a VM in the VNet that the FHIR server (or SQL server) answers.

### 5.2 Database

```bash
az postgres flexible-server create -g nc-hosp -n nc-hosp-db-<unique> -l centralindia \
  --version 16 --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
  --admin-user nc_admin --admin-password '<long random password>' \
  --vnet nc-hosp-vnet --subnet db --subnet-prefixes 10.50.2.0/24 --backup-retention 35
az postgres flexible-server db create -g nc-hosp -s nc-hosp-db-<unique> -d nc_connector
```

The connector creates its tables on first start.

### 5.3 VM and data disk

```bash
az vm create -g nc-hosp -n nc-connector -l centralindia \
  --image Canonical:ubuntu-24_04-lts:server:latest --size Standard_D4s_v5 \
  --vnet-name nc-hosp-vnet --subnet app --public-ip-address nc-connector-ip \
  --public-ip-sku Standard --public-ip-address-allocation static \
  --admin-username azureuser --ssh-key-values ~/.ssh/id_ed25519.pub \
  --os-disk-size-gb 64 --data-disk-sizes-gb 64 --assign-identity
```

Then set the network rules:

```bash
NSG=nc-connectorNSG
az network nsg rule create -g nc-hosp --nsg-name $NSG -n https-platform --priority 900 \
  --access Allow --protocol Tcp --destination-port-ranges 443 --source-address-prefixes <platform IP>/32
az network nsg rule create -g nc-hosp --nsg-name $NSG -n https-hospital --priority 910 \
  --access Allow --protocol Tcp --destination-port-ranges 443 --source-address-prefixes <hospital public ranges>
az network nsg rule create -g nc-hosp --nsg-name $NSG -n http-acme --priority 920 \
  --access Allow --protocol Tcp --destination-port-ranges 80 --source-address-prefixes Internet
az network nsg rule update -g nc-hosp --nsg-name $NSG -n default-allow-ssh --source-address-prefixes 10.0.0.0/8
```

- **Port 443:** the platform's IP and the hospital's own ranges.
- **Port 80:** open only for Caddy's certificate renewal.
- **SSH:** only from inside the VPN. Use your hospital's private ranges instead of `10.0.0.0/8`.

Add the DNS A record: `neurocapture-connector.hospital.in` → `nc-connector-ip`.

On the VM, mount the data disk and install the tools:

```bash
sudo mkfs.ext4 /dev/disk/azure/scsi1/lun0
sudo mkdir -p /srv/ncc/data
echo '/dev/disk/azure/scsi1/lun0 /srv/ncc/data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && sudo chown 10002 /srv/ncc/data     # the connector container's user

sudo apt-get update && sudo apt-get install -y docker.io git
sudo usermod -aG docker azureuser && newgrp docker
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
# Caddy, as in the platform guide:
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### 5.4 Recordings storage (required)

Ask the hospital admin to open Data connections → Recording storage → **Your own Azure Blob
container**. It shows these same steps with the real IDs filled in.

1. **Create the storage account and container:**

   ```bash
   az storage account create -g nc-hosp -n nchosp<unique> -l centralindia --sku Standard_ZRS --kind StorageV2 \
     --https-only true --min-tls-version TLS1_2 --allow-blob-public-access false
   az storage account blob-service-properties update -g nc-hosp --account-name nchosp<unique> \
     --enable-delete-retention true --delete-retention-days 30 --enable-versioning true
   az storage container create --account-name nchosp<unique> -n neurocapture-takes --auth-mode login
   ```

   - **Keep the public network endpoint on.** Patients' phones upload from home. Each upload link
     can write one file, for one hour, and nothing else, and the files are already encrypted on
     the phone.
   - **Size:** one session is about 0.3–0.5 GB. Add a lifecycle rule (for example, Cool tier
     after 90 days) and your own retention rule.

2. **Approve NeuroCapture's app** in the hospital tenant. A Global Administrator uses the approval
   link in the dashboard, or runs:

   ```bash
   az ad sp create --id <NeuroCapture client id>
   ```

3. **Create the write-only custom role.** The dashboard shows `neurocapture-uploader.json`:

   ```bash
   az role definition create --role-definition @neurocapture-uploader.json
   ```

4. **Give NeuroCapture's app its two roles:**

   ```bash
   SP=$(az ad sp show --id <NeuroCapture client id> --query id -o tsv)
   ACC=$(az storage account show -g nc-hosp -n nchosp<unique> --query id -o tsv)
   az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
     --role "Storage Blob Delegator" --scope $ACC
   az role assignment create --assignee-object-id $SP --assignee-principal-type ServicePrincipal \
     --role "NeuroCapture recording uploader" --scope $ACC/blobServices/default/containers/neurocapture-takes
   ```

5. **Give the connector's managed identity its role.**
   - Use **Storage Blob Data Contributor** on the container. Automatic analysis writes the
     encrypted reports (`biomarkers-*.enc`) next to each take.
   - Use **Storage Blob Data Reader** if you turn automatic analysis off
     (`NCC_ANALYSIS_INTERVAL_S=0`).

   ```bash
   VMID=$(az vm show -g nc-hosp -n nc-connector --query identity.principalId -o tsv)
   az role assignment create --assignee-object-id $VMID --assignee-principal-type ServicePrincipal \
     --role "Storage Blob Data Contributor" --scope $ACC/blobServices/default/containers/neurocapture-takes
   ```

6. **Finish in the dashboard,** after the connector is running (5.8): enter the storage account,
   container and tenant ID → **Test and save**. The card should say **Phones can record**.

   Role assignments can take 5 minutes to apply. If the test says "not allowed", wait and test
   again.

### 5.5 Key Vault

```bash
az keyvault create -g nc-hosp -n nc-hosp-kv-<unique> -l centralindia --enable-rbac-authorization true --enable-purge-protection true
KV=$(az keyvault show -n nc-hosp-kv-<unique> --query id -o tsv)
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" --role "Key Vault Secrets Officer" --scope "$KV"
az role assignment create --assignee-object-id "$VMID" --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$KV"
az keyvault secret set --vault-name nc-hosp-kv-<unique> -n db-url --value \
  'postgresql+psycopg://nc_admin:<pw>@nc-hosp-db-<unique>.postgres.database.azure.com:5432/nc_connector?sslmode=require'
az keyvault secret set --vault-name nc-hosp-kv-<unique> -n smtp-password  --value '<ACS SMTP client secret>'
az keyvault secret set --vault-name nc-hosp-kv-<unique> -n twilio-token   --value '<Twilio auth token>'
az keyvault secret set --vault-name nc-hosp-kv-<unique> -n fhir-token     --value '<read-only FHIR token>'   # if needed
```

### 5.6 E-mail and SMS for patients

- **E-mail:** the same ACS steps as the platform guide (§4.3), using the hospital's own domain and
  sender (`neurocapture@hospital.in`). You can also use the hospital's own SMTP server.
- **SMS:** ACS SMS cannot send to Indian mobile numbers. Use **Twilio**, or an Indian gateway
  (MSG91, Gupshup, Kaleyra and others) behind a small HTTP adapter (`NCC_SMS_PROVIDER=http`).
- **India DLT:** register three things:
  - the hospital as the principal entity;
  - a sender ID;
  - two transactional templates, matching `patientInviteSms` and `reminderSms` in
    `config/messages/en.json`.

The hospital admin can also enter the e-mail and SMS settings later in the dashboard → Messages.
They are stored encrypted in the connector database.

### 5.7 Build the connector image

Build it on the VM, from the NeuroCapture release that matches the platform:

```bash
sudo mkdir -p /srv/ncc && sudo chown azureuser /srv/ncc
git clone https://github.com/Venkat77081/NeuroAnalysis.git /srv/ncc/src
cd /srv/ncc/src && git checkout <same release as the platform>
docker build -f connector/Dockerfile.analysis -t neurocapture-connector:analysis-1.0.0 .   # with biomarkers (~1 GB more)
# or, without biomarkers:  docker build -t neurocapture-connector:1.0.0 connector/
```

NeuroCapture can also give you a ready image instead. Push it to an Azure Container Registry and
`docker pull` it.

### 5.8 Configure and start

`/srv/ncc/connector.env` holds the settings that are not secret:

```bash
NCC_SITE_ID=<site ID from Data connections>
NCC_PLATFORM_URL=https://api.example.in
NCC_PLATFORM_KEY_SHA256=<platform key fingerprint from Data connections>
NCC_SIGNING_KEY_PATH=/data/signing.pem
NCC_TAKE_KEYS_DIR=/data/take-keys
NCC_HOSPITAL_NAME=Sunrise Neuro Clinic
NCC_CORS_ORIGINS=https://dashboard.example.in,https://localhost
NCC_MESSAGE_LANG=en

# Patient records: FHIR …
NCC_RECORDS=fhir
NCC_FHIR_BASE_URL=https://fhir.hospital.in/fhir
NCC_FHIR_MRN_SYSTEM=urn:oid:<hospital MRN system>
# … or read-only SQL views:
# NCC_RECORDS=sql

NCC_ACTIVITY_SINK=db                     # or http + NCC_ACTIVITY_HTTP_URL (the hospital's log server)
NCC_REMINDER_INTERVAL_S=900
NCC_ANALYSIS_INTERVAL_S=60               # automatic biomarker analysis; 0 = off
NCC_ANALYSIS_BACKFILL_DAYS=7

NCC_EMAIL_PROVIDER=smtp
NCC_SMTP_HOST=smtp.azurecomm.net
NCC_SMTP_PORT=587
NCC_SMTP_SECURITY=starttls
NCC_SMTP_USERNAME=<ACS SMTP username>
NCC_MAIL_FROM=neurocapture@hospital.in
NCC_MAIL_FROM_NAME=Sunrise Neuro Clinic

NCC_SMS_PROVIDER=twilio
NCC_TWILIO_ACCOUNT_SID=AC...
NCC_TWILIO_MESSAGING_SERVICE_SID=MG...
NCC_SMS_DEFAULT_COUNTRY_CODE=+91
NCC_SMS_DLT_ENTITY_ID=1201...
NCC_SMS_DLT_TEMPLATE_IDS={"patientInviteSms": "1207...", "reminderSms": "1207..."}
```

- **`NCC_CORS_ORIGINS`:** keep `https://localhost`, so clinic phones can look up NCIDs.
- **Blob access:** no setting is needed. The connector uses the VM's managed identity.

`/srv/ncc/start-connector.sh` (run it with `sudo`):

```bash
#!/bin/sh
set -eu
az login --identity --allow-no-subscriptions >/dev/null
s() { az keyvault secret show --vault-name nc-hosp-kv-<unique> -n "$1" --query value -o tsv; }
IMG=neurocapture-connector:analysis-1.0.0
docker rm -f nc-connector 2>/dev/null || true
docker run -d --name nc-connector --restart unless-stopped -p 127.0.0.1:8100:8100 \
  -v /srv/ncc/data:/data \
  -e NCC_DATABASE_URL="$(s db-url)" \
  -e NCC_SMTP_PASSWORD="$(s smtp-password)" \
  -e NCC_TWILIO_AUTH_TOKEN="$(s twilio-token)" \
  --env-file /srv/ncc/connector.env \
  $IMG
```

Add `-e NCC_FHIR_BEARER_TOKEN="$(s fhir-token)"` if your FHIR server needs a token. For SQL, add
`-e NCC_RECORDS_SQL_URL=...`.

Create the signing key once, then start the connector:

```bash
docker run --rm -v /srv/ncc/data:/data neurocapture-connector:analysis-1.0.0 \
  python -m ncconnector keygen --out /data/signing.pem      # prints the PUBLIC key: copy it
chmod +x /srv/ncc/start-connector.sh && sudo /srv/ncc/start-connector.sh
curl -s http://127.0.0.1:8100/health
sudo crontab -e     # add: @reboot /srv/ncc/start-connector.sh
```

`/etc/caddy/Caddyfile`:

```
neurocapture-connector.hospital.in {
    reverse_proxy 127.0.0.1:8100
    request_body {
        max_size 64MB
    }
}
```

```bash
sudo systemctl reload caddy
```

### 5.9 Register, create the take key, test

1. **Register:** Dashboard → Data connections → enter `https://neurocapture-connector.hospital.in`
   and paste the public key from 5.8.
2. **Create the hospital's take key** and check its fingerprint:

   ```bash
   docker exec nc-connector python -m ncconnector rotate-take-key
   docker exec nc-connector python -m ncconnector take-keys
   ```

   The fingerprint must match Data connections → Keys.

3. **Test:** Data connections → **Test** with one real MRN. Every check should pass: reachable,
   records, NCID map, activity log, decrypt key.
4. **Storage:** finish 5.4 step 6 (**Test and save** → "Phones can record").
5. **Messages:** invite yourself by e-mail and by SMS from "Invite patients". Both should say
   "Sent".
6. **Full test:** record a test session on a phone. Then:
   - the doctor can play it;
   - after a minute or two, **Biomarkers** shows the report.

### 5.10 Backups

```bash
az backup vault create -g nc-hosp -n nc-hosp-backup -l centralindia
az backup protection enable-for-vm -g nc-hosp --vault-name nc-hosp-backup --vm nc-connector --policy-name DefaultPolicy
```

The VM backup includes the data disk.

Also keep an **offline copy** of the take keys, outside Azure, in two places (for example an
encrypted USB drive in a safe). Make a new copy after every key rotation:

```bash
sudo tar czf take-keys-$(date +%F).tgz -C /srv/ncc/data take-keys signing.pem
```

| What                                           | Backed up by                                     | If lost                                                     |
| ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `take-keys/`                                   | Azure Backup + offline copy                      | **Recordings can never be decrypted**                       |
| `signing.pem`                                  | Azure Backup + offline copy                      | Register a new key; enter the e-mail and SMS settings again |
| Connector database (NCID ↔ MRN, logs, reports) | PostgreSQL backups (35 days)                     | Recordings can no longer be linked to patients              |
| Recordings and encrypted reports               | ZRS + soft delete + versioning (+ GRS if needed) | Lost recordings                                             |

## 6. Operations

| Task                | How                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Update              | When NeuroCapture announces a release: `git checkout <tag>` → rebuild the image → change `IMG` in `start-connector.sh` → `sudo /srv/ncc/start-connector.sh`  |
| Rotate the take key | `docker exec nc-connector python -m ncconnector rotate-take-key`, yearly or per policy. Old keys stay, so old recordings still open. Make a new offline copy |
| Health              | Azure Monitor alert on the VM, plus the platform's dashboard: Data connections shows the last health check                                                   |
| Logs                | `docker logs nc-connector`. Logs never contain names, MRNs or contact details                                                                                |
| Who looked at what  | The clinical activity log (connector database, or your log server with `NCC_ACTIVITY_SINK=http`)                                                             |
| Patching            | Azure Update Manager, monthly, outside clinic hours                                                                                                          |

## 7. Rough monthly cost (pay-as-you-go, before tax)

| Item                                  | With analysis | Without analysis |
| ------------------------------------- | ------------- | ---------------- |
| VM (D4s_v5 / B2s) + disks             | ~ US$ 160     | ~ US$ 40         |
| PostgreSQL Flexible B1ms, 32 GB       | ~ US$ 20      | ~ US$ 20         |
| VPN Gateway VpnGw1                    | ~ US$ 140     | ~ US$ 140        |
| Storage (ZRS, ~ 50 GB a month added)  | ~ US$ 5–15    | ~ US$ 5–15       |
| Backup, Key Vault, Monitor, ACS Email | ~ US$ 20      | ~ US$ 20         |
| SMS (Twilio / Indian gateway)         | per message   | per message      |

You can skip the VPN Gateway if the EHR is already in Azure, or reachable another way.

## 8. Go-live checklist (hospital)

- [ ] VPN up; the connector reaches the FHIR server (or SQL views)
- [ ] `https://neurocapture-connector.hospital.in/health` answers through the firewall from the
      platform's IP and from a doctor's PC
- [ ] Connector registered; take key created; its fingerprint matches Data connections → Keys
- [ ] Data connections → **Test**: every check passes
- [ ] Storage → **Test and save**: "Phones can record"
- [ ] Test invite by e-mail and by SMS arrives (DLT templates approved for India)
- [ ] A test session uploads, plays for a doctor, and shows a biomarker report
- [ ] Azure Backup on; offline take-key copy in two places; database backups 35 days
- [ ] SSH only over the VPN; 443 only from the platform's IP and hospital ranges
- [ ] Clinic phones registered (Dashboard → Phones) and the phone check passed on each
