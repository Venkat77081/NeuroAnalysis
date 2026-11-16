# 037 — Azure Blob Storage for recordings, next to Amazon S3

- **Status:** accepted (user, 16 Nov 2026: "Have options for s3 bucket and blob storage to store
  video not just s3 so if hospitals use azure they can use blob").

## Decision

- **NeuroCapture storage** can be the local disk (`NC_STORAGE=local`), Amazon S3 (`s3`) or **Azure
  Blob Storage** (`azure`).
  - On Azure, the API's managed identity signs upload links with a **user delegation SAS**; no
    storage key is kept.
  - An account key (`NC_AZURE_STORAGE_KEY`) also works.
- **A hospital's own storage** can be an S3 bucket (decision 026) or an **Azure Blob container**:
  - The hospital approves NeuroCapture's **multitenant app** (`NC_AZURE_CLIENT_ID` /
    `NC_AZURE_CLIENT_SECRET`) in its Microsoft Entra tenant.
  - It assigns the app **Storage Blob Delegator** on the account and a custom role on the
    container that allows only `blobs/write` and `blobs/add/action`.
  - A user delegation SAS can never allow more than the identity's role, so NeuroCapture can
    upload but cannot read, list or delete.
  - The connector reads with its own identity (Storage Blob Data Reader) and checks SHA-256.
- **The same phone protocol** as S3:
  - Each part is a PUT to a short-lived URL: for Azure, a **Put Block** with a SAS for that one
    blob, create and write only, valid for `upload_url_ttl_s`.
  - Block IDs come from the upload ID and the part number.
  - The server commits the block list in part order, then checks SHA-256 (NeuroCapture storage)
    or leaves that to the connector (hospital storage).
  - Resuming reads the staged blocks. A write-only identity may not list them; the phone then
    sends every part again.
  - Interrupted uploads need no clean-up: Azure drops uncommitted blocks after 7 days.
- **Phone change:** Put Block answers **201 with no ETag**. The app (Kotlin `partTag`, TypeScript
  `partTag`) now accepts that and reports `azure-<n>`. S3 and local storage still require 200 with
  an ETag.
- **The storage test before switching** (dashboard → Recording storage):
  1. sign in to the hospital's tenant (getting a delegation key);
  2. stage one block through a phone-style URL (never committed);
  3. check that reading is refused.

  The storage is saved only if the upload works.

- **Testing:** against **Azurite**, Microsoft's Blob emulator (npm `azurite@3.35.0`). CI starts it
  for the backend and connector jobs. Azurite only supports account keys, so the tests sign with
  the key. The delegation-key path is the SDK's own; check it in the first real deployment.

## Why

Many hospitals in India run on Azure, and Blob is not S3-compatible. Direct uploads keep video off
the API servers. With S3 or Azure, the API server holds no files, so it can be replaced or run as
several copies; local disk storage ties the recordings to one server.

## Consequences

- New dependencies: `azure-storage-blob==12.31.1`, `azure-identity==1.27.0` (platform and
  connector).
- `ObjectLocation` in the connector API gains `account` and `container` (kind `azure`), and
  `bucket` becomes optional.
- Phones on an older build cannot upload to Azure. No release before this change is in use.
