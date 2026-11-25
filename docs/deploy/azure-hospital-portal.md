# Azure portal guide: the hospital side (connector, recordings, biomarkers)

Click-by-click set-up of a hospital's NeuroCapture side in the **Azure portal**
(https://portal.azure.com), in **the hospital's own subscription**. This is the same deployment as
[`azure-hospital.md`](azure-hospital.md), which uses the command line. What runs at the hospital,
the architecture and costs are explained there.

**Some steps cannot be done in the portal.** Building and running the connector happens on the VM
over SSH. Those steps are marked **On the VM** and use the scripts from
[`azure-hospital.md`](azure-hospital.md).

Example names: region **Central India**, resource group `nc-hosp`, the hospital domain
`hospital.in`.

## Before you start: get these from NeuroCapture

1. **The platform's address:** `https://api.example.in`.
2. **The platform's public IP,** for your firewall.
3. **NeuroCapture's application (client) ID**.
4. **Your hospital admin's dashboard sign-in.** Data connections then shows:
   - the **site ID**;
   - the **platform key fingerprint**;
   - the storage steps, with your IDs filled in.

You also need your EHR's FHIR R4 base URL, MRN identifier system and a read-only token, **or** a
read-only SQL user on four views (`connector/sql/sample_views.sql`).

---

## Step 1: Resource group and budget

1. Search → **Resource groups** → **+ Create**.
   - Name `nc-hosp`, region **Central India**.
   - **Review + create** → **Create**.
2. Search → **Cost Management** → **Budgets** → **+ Add**. Set a monthly amount and e-mail alerts
   at 80 % and 100 %.

## Step 2: Virtual network

Search → **Virtual networks** → **+ Create**.

| Tab          | Setting                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basics       | Resource group `nc-hosp`, name `nc-hosp-vnet`, region Central India                                                                                                                                                                                                                                 |
| IP addresses | <ul><li>Address space `10.50.0.0/16`. Pick a range that does **not** overlap the hospital's own networks.</li><li>Edit the `default` subnet: name `app`, `10.50.1.0/24`.</li><li>**+ Add a subnet**: Subnet purpose **Virtual Network Gateway** (name `GatewaySubnet`), `10.50.255.0/27`.</li></ul> |

**Review + create** → **Create**.

## Step 3: VPN to the hospital network

This lets the connector reach the EHR, and the staff PCs reach the connector privately. Skip it if
the EHR is already in Azure and reachable.

1. Search → **Virtual network gateways** → **+ Create**.
   - Name `nc-hosp-vpngw`, region Central India.
   - Gateway type **VPN**, SKU **VpnGw1**, generation 1.
   - Virtual network `nc-hosp-vnet`.
   - Public IP: **Create new** `nc-hosp-vpngw-ip`.
   - **Create.** It takes 30–45 minutes.
2. Search → **Local network gateways** → **+ Create**.
   - Name `hospital-onprem`.
   - Endpoint: **IP address** = the hospital firewall's public IP.
   - Address space: the hospital ranges the connector must reach (EHR servers, staff PCs, clinic
     Wi-Fi).
   - **Create.**
3. Open `nc-hosp-vpngw` → **Connections** → **+ Add**.
   - Connection type **Site-to-site (IPsec)**.
   - Local network gateway `hospital-onprem`.
   - Shared key: a long random string.
   - **OK.**
4. On the hospital firewall:
   1. Configure the other end of the tunnel, with the same shared key.
   2. Peer with the public IP of `nc-hosp-vpngw-ip`.
   3. Use the VNet range `10.50.0.0/16`.
5. The connection shows **Connected** when it is up.

## Step 4: Database (Azure Database for PostgreSQL flexible server)

Search → **Azure Database for PostgreSQL flexible servers** → **+ Create**.

| Tab        | Setting                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Basics     | <ul><li>Resource group `nc-hosp`, name `nc-hosp-db-<unique>`, Central India, version **16**.</li><li>**Configure server**: Burstable **B1ms**, 32 GiB; backup retention **35** days (geo-redundant backup if your policy needs it).</li><li>Authentication: PostgreSQL only. Admin `nc_admin` with a long random password.</li></ul> |
| Networking | <ul><li>**Private access (VNet Integration)**, VNet `nc-hosp-vnet`.</li><li>**Create subnet** `db` `10.50.2.0/24`.</li><li>New private DNS zone.</li></ul>                                                                                                                                                                           |

**Create**. Then open the server → **Databases** → **+ Add** `nc_connector` → **Save**.

The database URL (for step 8):

```
postgresql+psycopg://nc_admin:<password>@nc-hosp-db-<unique>.postgres.database.azure.com:5432/nc_connector?sslmode=require
```

The connector creates its own tables when it starts.

## Step 5: The connector VM

Search → **Virtual machines** → **+ Create** → **Azure virtual machine**.

| Tab        | Setting                                                                                                                                                                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basics     | <ul><li>Resource group `nc-hosp`, name `nc-connector`, Central India.</li><li>Image **Ubuntu Server 24.04 LTS – x64 Gen2**.</li><li>Size: **Standard_D4s_v5** (4 vCPU, 16 GiB) **with biomarker analysis**; Standard_B2s without.</li><li>SSH public key, user `azureuser`.</li><li>Public inbound ports: **None**. You add rules below.</li></ul> |
| Disks      | <ul><li>OS disk 64 GiB Premium SSD.</li><li>**Data disks → Create and attach a new disk**: 64 GiB Premium SSD, name `nc-connector-data`. It will hold the signing key and **take keys**.</li></ul>                                                                                                                                                 |
| Networking | <ul><li>VNet `nc-hosp-vnet`, subnet `app`.</li><li>Public IP: **Create new**, Standard, **Static**.</li><li>NIC network security group: **Advanced** → **Create new** `nc-connectorNSG`.</li></ul>                                                                                                                                                 |
| Management | **Enable system assigned managed identity** ✔                                                                                                                                                                                                                                                                                                      |

**Review + create** → **Create**.

### 5a. Firewall rules (network security group)

Open `nc-connectorNSG` → **Inbound security rules** → **+ Add**, once for each row:

| Priority | Name             | Source: IP addresses                                                             | Port | Protocol | Action |
| -------- | ---------------- | -------------------------------------------------------------------------------- | ---- | -------- | ------ |
| 900      | `https-platform` | the **platform's public IP**`/32`                                                | 443  | TCP      | Allow  |
| 910      | `https-hospital` | the hospital's public IP ranges (staff PCs and clinic Wi-Fi leave through these) | 443  | TCP      | Allow  |
| 920      | `http-acme`      | Service tag **Internet**                                                         | 80   | TCP      | Allow  |
| 930      | `ssh-vpn`        | the hospital's private ranges (over the VPN)                                     | 22   | TCP      | Allow  |

- **Port 80** is for automatic certificate renewal only.
- **Doctors working from home** use the hospital VPN.

### 5b. DNS

1. VM → **Overview** → copy the **Public IP address**.
2. In your DNS (Azure **DNS zones** → `hospital.in` → **+ Record set**, or your registrar), add an
   **A** record: `neurocapture-connector` → that IP.

## Step 6: Recordings storage (required: phones cannot record without it)

The hospital admin's dashboard (Data connections → Recording storage → **Your own Azure Blob
container**) shows these steps with your real IDs.

### 6a. Storage account

Search → **Storage accounts** → **+ Create**.

| Tab             | Setting                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basics          | <ul><li>Resource group `nc-hosp`, name `nchosp<unique>`, Central India.</li><li>Primary service: **Azure Blob Storage**.</li><li>Performance **Standard**; redundancy **Zone-redundant storage (ZRS)**.</li></ul>   |
| Advanced        | <ul><li>**Require secure transfer** ✔.</li><li>**Allow enabling anonymous access on individual containers** ✘ (off).</li><li>Minimum TLS **1.2**.</li><li>Leave storage account key access on (default).</li></ul>  |
| Networking      | <ul><li>Public network access: **Enable from all networks**. Patients' phones upload from home.</li><li>Each upload link can write one file for one hour, and the file is already encrypted on the phone.</li></ul> |
| Data protection | <ul><li>**Soft delete for blobs** ✔, 30 days.</li><li>**Soft delete for containers** ✔, 30 days.</li><li>**Versioning for blobs** ✔.</li></ul>                                                                      |

**Review + create** → **Create**.

Then open the account:

1. **Containers** → **+ Container**. Name `neurocapture-takes`, anonymous access level
   **Private** → **Create**.
2. Optional: **Lifecycle management** → **+ Add a rule** → move blobs to **Cool** after 90 days,
   and delete them per your retention policy.

Size: one session is about 0.3–0.5 GB.

### 6b. Approve NeuroCapture's app in your tenant

A **Global Administrator** (or Privileged Role Administrator) opens the approval link from the
dashboard, signs in and clicks **Accept**. The link looks like this:

```
https://login.microsoftonline.com/<your tenant id>/adminconsent?client_id=<NeuroCapture client id>
```

Check: Microsoft Entra ID → **Enterprise applications** now lists **NeuroCapture recordings
(India)**.

### 6c. Create the write-only custom role

1. Storage account → **Access control (IAM)** → **+ Add** → **Add custom role**.
2. **Baseline permissions:** **Start from JSON**, and upload a file `neurocapture-uploader.json`
   with this content. Put your subscription ID in it.

   ```json
   {
     "properties": {
       "roleName": "NeuroCapture recording uploader",
       "description": "Upload NeuroCapture recordings (encrypted on the phone). No read, list or delete.",
       "assignableScopes": ["/subscriptions/<subscription-id>"],
       "permissions": [
         {
           "actions": [],
           "notActions": [],
           "dataActions": [
             "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
             "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"
           ],
           "notDataActions": []
         }
       ]
     }
   }
   ```

3. **Review + create** → **Create**. A new custom role can take a few minutes to appear in lists.

### 6d. Give NeuroCapture's app its two roles

1. **On the storage account:** **Access control (IAM)** → **+ Add** → **Add role assignment**.
   1. Role: **Storage Blob Delegator**.
   2. Members: **User, group, or service principal** → **+ Select members** → search
      `NeuroCapture recordings` → **Select**.
   3. **Review + assign**.

   This lets it sign upload links, and does not let it read data.

2. **On the container:** storage account → **Containers** → `neurocapture-takes` → **Access
   Control (IAM)** → **+ Add** → **Add role assignment**.
   1. Role: **NeuroCapture recording uploader**. Use the **Job function roles** tab and search for
      it.
   2. Members: the same `NeuroCapture recordings` app.
   3. **Review + assign**.

### 6e. Give the connector its role

On the container `neurocapture-takes` → **Access Control (IAM)** → **+ Add** → **Add role
assignment**.

1. Role: **Storage Blob Data Contributor**. Automatic analysis writes the encrypted reports next
   to each take. Use **Storage Blob Data Reader** only if automatic analysis will be off.
2. Members: **Managed identity** → **+ Select members** → **Virtual machine** → `nc-connector`.
3. **Review + assign**.

You finish this in the dashboard in step 10.

## Step 7: Key Vault

1. Search → **Key vaults** → **+ Create**.
   - Resource group `nc-hosp`, name `nc-hosp-kv-<unique>`.
   - **Purge protection: Enable**.
   - Access configuration: **Azure role-based access control**.
   - **Create**.
2. Vault → **Access control (IAM)** → **+ Add role assignment**:
   - **Key Vault Secrets Officer** → yourself;
   - **Key Vault Secrets User** → Managed identity → Virtual machine → `nc-connector`.
3. Vault → **Secrets** → **+ Generate/Import**, once for each secret:

   | Name            | Value                                              |
   | --------------- | -------------------------------------------------- |
   | `db-url`        | the database URL from step 4                       |
   | `smtp-password` | the ACS SMTP secret from step 8                    |
   | `twilio-token`  | the Twilio auth token (or the gateway token)       |
   | `fhir-token`    | the read-only FHIR token, if your server needs one |

## Step 8: E-mail and SMS for patients

**E-mail.** Use the hospital's own domain. Follow the platform portal guide, step 4
([`azure-platform-portal.md`](azure-platform-portal.md)), with:

- names `nc-hosp-email` and `nc-hosp-acs`;
- domain `hospital.in`;
- sender `neurocapture`;
- an SMTP app `nc-hosp-smtp`.

Or use the hospital's existing SMTP server.

**SMS.** Azure Communication Services cannot send SMS to Indian mobile numbers.

- Use **Twilio**, or an Indian gateway (MSG91, Gupshup, Kaleyra and others).
- **India DLT:** register the hospital as the principal entity, a sender ID, and two
  transactional templates. Their text must match `patientInviteSms` and `reminderSms` in
  `config/messages/en.json`.

The hospital admin can also enter these settings later in the dashboard → **Messages**.

## Step 9: On the VM: install and start the connector

1. Connect: VM → **Connect** → **SSH**, from inside the VPN. Or use **Bastion**: search
   **Bastions** → **+ Create** in `nc-hosp-vnet`, then VM → Connect → Bastion.
2. Follow [`azure-hospital.md`](azure-hospital.md):
   - **§5.3, second half:** mount the data disk at `/srv/ncc/data`, then install Docker, the Azure
     CLI and Caddy.
   - **§5.7:** build the image. With biomarkers, use `connector/Dockerfile.analysis`.
   - **§5.8:**
     1. Write `/srv/ncc/connector.env` (site ID, platform key fingerprint, FHIR or SQL, e-mail,
        SMS).
     2. Write `/srv/ncc/start-connector.sh`.
     3. Create the signing key with `keygen`. **Copy the public key it prints.**
     4. Start the connector.
     5. Set up the Caddyfile and reload Caddy.
3. Check:
   - `https://neurocapture-connector.hospital.in/health` answers from a hospital PC.
   - `sudo crontab -e` contains `@reboot /srv/ncc/start-connector.sh`.

## Step 10: Register and test (hospital dashboard)

1. **Data connections:**
   1. Enter `https://neurocapture-connector.hospital.in`.
   2. Paste the public key from step 9 → **Save**.
2. **Take key.** On the VM:

   ```bash
   docker exec nc-connector python -m ncconnector rotate-take-key
   docker exec nc-connector python -m ncconnector take-keys
   ```

   The fingerprint must match Data connections → **Keys**.

3. **Data connections → Test**, with one real MRN. Every check must pass: reachable, records, NCID
   map, activity log, decrypt key.
4. **Recording storage → Your own Azure Blob container:**
   1. Enter the storage account name, the container `neurocapture-takes` and your tenant ID
      (Entra ID → Overview → **Tenant ID**).
   2. Click **Test and save**. The card must say **Phones can record**.

   If it says "not allowed", wait 5 minutes for the role assignments and test again.

5. **Messages:** invite yourself by e-mail and by SMS. Both should say **Sent**.
6. **Full test:**
   1. Record a session on a phone.
   2. The doctor can play it.
   3. After a minute or two, **Biomarkers** shows the report.

## Step 11: Backups

1. Search → **Recovery Services vaults** → **+ Create**. Name `nc-hosp-backup`, Central India →
   **Create**.
2. VM `nc-connector` → **Backup** → vault `nc-hosp-backup`, policy **DefaultPolicy** (daily,
   30 days) → **Enable backup**. This includes the data disk with the take keys.
3. **Offline copy of the take keys:**
   1. On the VM:

      ```bash
      sudo tar czf take-keys-$(date +%F).tgz -C /srv/ncc/data take-keys signing.pem
      ```

   2. Copy the file to two encrypted offline places.
   3. Repeat after every take-key rotation.

   **Without the take keys, recordings can never be decrypted.**

4. **Database backups:** PostgreSQL server → **Backup and restore** shows them (35 days, from
   step 4).

## Step 12: Monitoring and patching

1. VM → **Monitoring** → **Insights** → **Enable**. This installs the Azure Monitor Agent.
2. VM → **Alerts** → **+ Create** → **Alert rule**:
   - VM availability;
   - CPU over 90 % for 30 minutes (analysis uses the CPU in bursts, so use a long window);
   - disk over 80 %.

   Send them to IT's e-mail.

3. VM → **Updates** → monthly maintenance window, outside clinic hours.
4. Connector health is also visible to the hospital admin: Dashboard → **Data connections**.

## Checklist

- [ ] VPN **Connected**; the connector reaches the FHIR server (or SQL views)
- [ ] The connector's HTTPS address works from a hospital PC and from the platform's IP
- [ ] Take key created; its fingerprint matches the dashboard
- [ ] Data connections → **Test**: all pass
- [ ] Storage → **Test and save**: Phones can record
- [ ] Test invites by e-mail and by SMS arrive (DLT templates approved in India)
- [ ] A test session plays for a doctor and shows a biomarker report
- [ ] Azure Backup on; take keys copied offline in two places
- [ ] SSH only over the VPN or Bastion; 443 only from the platform IP and hospital ranges
- [ ] Clinic phones registered (Dashboard → Phones) and the phone check passed on each
