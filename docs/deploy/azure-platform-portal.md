# Azure portal guide: the NeuroCapture platform

Click-by-click set-up of the NeuroCapture platform in the **Azure portal** (https://portal.azure.com).
This is the same deployment as [`azure-platform.md`](azure-platform.md), which uses the command line.
What the platform holds, the architecture and costs are explained there. The hospital side is in
[`azure-hospital-portal.md`](azure-hospital-portal.md).

**Some steps cannot be done in the portal.** Building and running the containers happens on the VM
over SSH. Those steps are marked **On the VM** and use the scripts from
[`azure-platform.md`](azure-platform.md).

**Cloud Shell** is the `>_` icon in the portal's top bar. Use it where a step needs to upload a key
file.

Example names: region **Central India**, resource group `nc-prod`, domain `example.in`. Replace
`<unique>` with a short suffix of your own; some names must be unique across Azure.

**Tip:** each "Create" page has tabs (Basics, Networking, …). Anything not mentioned here can stay
at its default.

---

## Step 1: Resource group and budget

1. Search bar → **Resource groups** → **+ Create**.
   - Subscription: yours.
   - Resource group: `nc-prod`.
   - Region: **(Asia Pacific) Central India**.
   - **Review + create** → **Create**.
2. Search → **Cost Management + Billing** → **Cost Management** → **Budgets** → **+ Add**.
   - Scope: the subscription.
   - Name: `nc-prod-budget`, with a monthly amount.
   - Alert conditions: 80 % and 100 %, with your e-mail → **Create**.

## Step 2: Virtual network

Search → **Virtual networks** → **+ Create**.

| Tab          | Setting                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| Basics       | Resource group `nc-prod`, name `nc-vnet`, region Central India                            |
| IP addresses | Address space `10.20.0.0/16`. Edit the `default` subnet: name `app`, range `10.20.1.0/24` |

**Review + create** → **Create**. The database subnet is created in step 3.

## Step 3: Database (Azure Database for PostgreSQL flexible server)

Search → **Azure Database for PostgreSQL flexible servers** → **+ Create**.

| Tab        | Setting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Basics     | <ul><li>Resource group `nc-prod`; server name `nc-db-<unique>`; region Central India; PostgreSQL version **16**.</li><li>Workload type: **Development** (pilot) or **Production**.</li><li>**Compute + storage → Configure server**: Burstable **B2s**, 64 GiB (pilot). Production: General Purpose **D2ds_v5**, high availability **Zone redundant**. Backup retention: **14** days → Save.</li><li>Authentication: **PostgreSQL authentication only**. Admin username `nc_admin`; a long random password (keep it for step 7).</li></ul> |
| Networking | <ul><li>Connectivity method: **Private access (VNet Integration)**.</li><li>Virtual network `nc-vnet`.</li><li>Subnet: **Create subnet** `db`, `10.20.2.0/24`. The portal delegates it.</li><li>Private DNS zone: create a new one (default).</li></ul>                                                                                                                                                                                                                                                                                    |

**Review + create** → **Create**. It takes about 10 minutes.

Then open the server → **Databases** → **+ Add**, name `neurocapture` → **Save**.

Write down the database URL for step 7:

```
postgresql+psycopg://nc_admin:<password>@nc-db-<unique>.postgres.database.azure.com:5432/neurocapture?sslmode=require
```

You do not create any tables. The API creates them when it starts.

## Step 4: E-mail (Azure Communication Services)

### 4a. Email domain

1. Search → **Email Communication Services** → **+ Create**.
   - Resource group `nc-prod`, name `nc-email`.
   - Data location: **India**.
   - **Create**.
2. Open `nc-email` → **Provision domains** → **+ Add domain** → **Custom domain**. Enter
   `example.in` → **Add**.
3. Click the domain → **Configure**. The portal shows a **TXT** (verify), an **SPF** and two
   **DKIM** records.
   1. Add them at your DNS provider.
   2. Click **Verify** for each record. All four must show **Verified**.
4. At your DNS provider, also add a DMARC record: TXT `_dmarc` with
   `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.in`.
5. Domain → **MailFrom addresses** → **+ Add**. Display name `NeuroCapture`, address
   `no-reply` → **Save**.

### 4b. Communication Services

1. Search → **Communication Services** → **+ Create**.
   - Resource group `nc-prod`, name `nc-acs`.
   - Data location: **India**.
   - **Create**.
2. Open `nc-acs` → **Email** → **Domains** → **Connect domain**. Choose `nc-email` and
   `example.in` → **Connect**.

### 4c. SMTP login

1. Search → **Microsoft Entra ID** → **App registrations** → **+ New registration**.
   - Name `nc-smtp`.
   - Supported account types: **Single tenant**.
   - **Register**.
2. In `nc-smtp`:
   1. **Certificates & secrets** → **+ New client secret**, expiry 24 months → **Add**.
   2. **Copy the Value now**; it is shown once. This is the SMTP password.
3. Back in `nc-acs` → **Access control (IAM)** → **+ Add** → **Add role assignment**.
   - Choose the role Microsoft's page "Create credentials for SMTP authentication" names for
     sending e-mail (for example **Communication and Email Service Owner**, or the custom role it
     describes).
   - Members: **User, group, or service principal** → `nc-smtp` → **Review + assign**.
4. `nc-acs` → **SMTP Usernames** → **+ Add SMTP Username**. Application `nc-smtp`, username
   `nc-mailer@example.in` (or the form the portal suggests) → **Add**.

The SMTP settings are host `smtp.azurecomm.net`, port 587, STARTTLS, the username from step 4,
and the secret from step 2.

## Step 5: App registration for hospitals' recordings (multi-tenant)

Hospitals approve this app and give it **write-only** access to their own Blob container.

1. **Microsoft Entra ID** → **App registrations** → **+ New registration**.
   - Name: `NeuroCapture recordings (India)`.
   - Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID
     tenant – Multitenant)**.
   - Redirect URI: leave empty → **Register**.
2. **Overview:** copy the **Application (client) ID**. Hospitals need it; it is not secret.
3. **Certificates & secrets** → **+ New client secret**, expiry 12 or 24 months → **Add** →
   **copy the Value**.
4. **API permissions:** remove `User.Read` (optional). No permissions are needed.
5. **Branding & properties:**
   - publisher domain;
   - home page, privacy statement and terms of service URLs.

   Hospital administrators see these when they approve the app.

Set a calendar reminder before the secret expires. While it is expired, uploads to hospitals on
Azure stop.

## Step 6: The VM

Search → **Virtual machines** → **+ Create** → **Azure virtual machine**.

| Tab        | Setting                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basics     | <ul><li>Resource group `nc-prod`, name `nc-api`, region Central India.</li><li>Image: **Ubuntu Server 24.04 LTS – x64 Gen2**.</li><li>Size: **Standard_D2s_v5** (pilot: B2ms).</li><li>Authentication: **SSH public key**, username `azureuser`, your public key (or let the portal generate one and download it).</li><li>Public inbound ports: **Allow selected ports**: **HTTP (80), HTTPS (443), SSH (22)**.</li></ul> |
| Disks      | OS disk 64 GiB, **Premium SSD**                                                                                                                                                                                                                                                                                                                                                                                            |
| Networking | <ul><li>Virtual network `nc-vnet`, subnet `app`.</li><li>Public IP: **Create new**, SKU Standard, assignment **Static**.</li><li>NIC network security group: **Basic**.</li></ul>                                                                                                                                                                                                                                          |
| Management | Identity: **Enable system assigned managed identity** ✔                                                                                                                                                                                                                                                                                                                                                                    |
| Monitoring | Boot diagnostics on (default)                                                                                                                                                                                                                                                                                                                                                                                              |

**Review + create** → **Create**.

After it is created:

1. **Limit SSH to your own IP.** VM → **Networking** → **Network settings** → open the **SSH**
   inbound rule. Source: **IP Addresses**, your IP `<a.b.c.d>/32` → **Save**.
   - Or remove the SSH rule and use **Azure Bastion** (VM → Connect → Bastion).
2. **Public IP:** VM → **Overview** → copy the **Public IP address**.
3. **DNS:** create two **A** records pointing to that IP: `api.example.in` and
   `dashboard.example.in`.
   - In Azure DNS: search **DNS zones** → `example.in` → **+ Record set**.
   - Or use your registrar.
4. **Hospitals' firewalls:** send this IP to every hospital. Their firewall allows the platform's
   calls from it.

## Step 7: Key Vault and secrets

### 7a. Create the vault

Search → **Key vaults** → **+ Create**.

| Tab                  | Setting                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Basics               | Resource group `nc-prod`, name `nc-kv-<unique>`, region Central India, tier Standard; **Purge protection: Enable** |
| Access configuration | Permission model: **Azure role-based access control**                                                              |

**Review + create** → **Create**.

### 7b. Give yourself and the VM access

Open the vault → **Access control (IAM)** → **+ Add** → **Add role assignment**.

1. Role **Key Vault Secrets Officer** → Members: **User, group, or service principal** → yourself
   → **Review + assign**.
2. Again, role **Key Vault Secrets User** → Members: **Managed identity** → **+ Select members** →
   Managed identity: **Virtual machine** → `nc-api` → **Review + assign**.

### 7c. The secrets

**Generate the two key files on your own computer.** Never generate them in the portal or on the
server:

```bash
openssl genpkey -algorithm ed25519 -out platform-signing.pem
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out server-private.pem
openssl pkey -in server-private.pem -pubout -out server-public.pem
openssl rand -hex 32     # run twice: one value for jwt-secret, one for account-pepper
```

**Single-line secrets:** add them in the portal. Vault → **Secrets** → **+ Generate/Import** →
name and **Secret value** → **Create**.

| Name                  | Value                                            |
| --------------------- | ------------------------------------------------ |
| `jwt-secret`          | first `openssl rand -hex 32` output              |
| `account-pepper`      | second output. **Never change it after go-live** |
| `db-url`              | the database URL from step 3                     |
| `smtp-username`       | step 4c username                                 |
| `smtp-password`       | step 4c secret                                   |
| `azure-client-secret` | step 5 secret                                    |

**The two key files** span several lines, and the portal's secret box keeps only one line. Use
**Cloud Shell**:

1. Click `>_` → Bash.
2. **Manage files** → **Upload** `platform-signing.pem` and `server-public.pem`.
3. Run:

   ```bash
   az keyvault secret set --vault-name nc-kv-<unique> -n platform-signing-key --file platform-signing.pem
   az keyvault secret set --vault-name nc-kv-<unique> -n server-public-key   --file server-public.pem
   rm platform-signing.pem server-public.pem
   ```

Keep `server-private.pem` and a copy of `account-pepper` **offline**, in two safe places, and not
in Azure.

## Step 8: On the VM: run the API, the dashboard and HTTPS

1. Connect: VM → **Connect** → **SSH** (it shows the command) or **Bastion**.
2. Follow [`azure-platform.md`](azure-platform.md), in this order:
   - **§4.5, second half:** install Docker, the Azure CLI and Caddy.
   - **§4.7:** clone the repo, build the API image, write `/srv/nc/api.env` (put the step 5
     client ID in `NC_AZURE_CLIENT_ID`), write `/srv/nc/start-api.sh`, and run it.
     `curl -s http://127.0.0.1:8000/health` must show `ok`.
   - **§4.8:** build the dashboard, write `config.json` and the Caddyfile, then reload Caddy.
3. Start the API after every reboot: `sudo crontab -e` → add `@reboot /srv/nc/start-api.sh`.
4. Check:
   - `https://api.example.in/health` shows `"status":"ok"` and `"storage":"hospital_owned"`.
   - `https://dashboard.example.in` shows the sign-in page.

## Step 9: First platform admin

On the VM:

```bash
docker exec -it nc-api python -m app.admin create-platform-admin --email you@example.in --name "Your Name"
```

1. Open the printed link. Set a password and two-step sign-in.
2. **Platform settings** must say **Azure app registered**.
3. Onboard a test hospital with your own e-mail. The invite e-mail arriving proves step 4 works.

## Step 10: Monitoring

1. Search → **Application Insights** → **+ Create**.
   - Resource group `nc-prod`, name `nc-insights`.
   - Workspace: create `nc-logs`.
   - **Create**.
2. `nc-insights` → **Availability** → **+ Add Standard test**.
   - URL `https://api.example.in/health`, every 5 minutes, 3 locations.
   - Alerts: enabled.
   - **Create**.
3. Then **Alerts** → the rule → **Action group** → add your e-mail.
4. VM → **Monitoring** → **Insights** → **Enable**. This installs the Azure Monitor Agent.
5. VM → **Alerts** → **+ Create** → **Alert rule**:
   - Percentage CPU > 80 %;
   - OS disk used > 80 %.
6. VM → **Updates** (Azure Update Manager) → **Update settings**:
   - periodic assessment on;
   - a monthly maintenance window.

## Step 11: Optional: scale out

1. Create a second VM exactly like step 6, with the same `start-api.sh` (and the same Key Vault
   role for its identity).
2. Search → **Application gateways** → **+ Create**:
   - tier **WAF V2**, its own subnet in `nc-vnet`;
   - backend pool: both VMs;
   - HTTPS listener with your certificate;
   - health probe `/health`.
3. Point `api.example.in` to the gateway's IP.

The API keeps no files, so any VM can serve any request.

## Step 12: Onboard each hospital

1. Dashboard → **Hospitals** → **Onboard**. Enter the hospital admin's e-mail.
2. Send the hospital:
   - [`azure-hospital-portal.md`](azure-hospital-portal.md);
   - `https://api.example.in` and the VM's public IP (step 6);
   - the step 5 **Application (client) ID**.
3. When they are done, the hospital shows **Can record** and its connector checks pass.

## Checklist

- [ ] `https://api.example.in/health` → `ok`, storage `hospital_owned`
- [ ] Dashboard sign-in works, with two-step sign-in for the platform admin
- [ ] A test staff invite e-mail arrives
- [ ] Platform settings: Azure app registered
- [ ] Database backups 14+ days; Key Vault purge protection on
- [ ] SSH limited to your IP (or Bastion only)
- [ ] Availability test and alerts e-mail you
- [ ] `server-private.pem` and `account-pepper` stored offline in two places
- [ ] Reminders set for the two app secrets' expiry dates
