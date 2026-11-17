# 044 — Hospital storage only: NeuroCapture keeps no recordings

- **Status:** accepted (user, 17 Nov 2026: "hospital storage only", "don't want neuro storage
  anywhere"; mockups "v12 · Hospital storage only").
- **Changes:**
  - Decision 037: the platform's own S3 bucket or Blob container is now **development storage
    only**.
  - M12 "managed storage": removed. There is no NeuroCapture storage option, no migration and no
    deadline.

## Why

- The platform never could open a recording (decision 027), but it still paid for and held the
  encrypted files of hospitals that had not connected their own storage.
- Hospitals own their data (decision 023). Holding even encrypted videos makes NeuroCapture a
  custodian of clinical files, with the retention, legal-hold and deletion duties that come with
  it.
- One storage model is simpler to explain, deploy and support.

## What changes

1. **Every hospital connects its own storage** before any phone can record:
   - an Amazon S3 bucket (an upload role that trusts the platform, with an ExternalId), or
   - an Azure Blob container (NeuroCapture's multi-tenant Entra app, with a write-only role).

   NeuroCapture can only write there. It cannot read, list or delete. The hospital's connector
   reads the files.

2. **Recording is off until the storage test passes.**
   - A new hospital starts with storage `none`.
   - `create_session` and `create_take` answer 409 `storage_not_connected`.
   - `GET /sessions/can-record` lets the app explain this before anyone starts:
     - clinic queue: "Recording is not ready";
     - patient app: the hospital shows "Getting ready".
   - Dashboards show "Recording is off" (hospital) and a "Can record" column (platform admin).
3. **Development storage** (`NC_DEV_STORAGE=true`) is used only by the tests, the e2e stack and
   `docker compose`. It offers a "Development storage" choice that uses the old `NC_STORAGE`
   settings. Production keeps it **off**. Health then reports `storage: hospital_owned`.
4. **Platform settings page** (platform admin): shows which storage kinds hospitals can choose,
   and whether the Azure app is registered (`NC_AZURE_CLIENT_ID`). S3 is always offered.
5. **Migration `0020`:** hospitals on `managed` become `none`; they must connect their storage
   before recording again. Recordings already in the old bucket stay there, readable by their
   hospital's connector, until the operator deletes them.

## Consequences

- A hospital cannot start until its IT team has created the bucket or container. The set-up page
  shows the steps; `docs/deploy/aws.md` and `azure.md` describe both sides.
- An Azure-hosted platform that offers S3 needs AWS credentials that can only assume roles
  (`NC_S3_ACCESS_KEY`/`NC_S3_SECRET_KEY`). An AWS-hosted platform that offers Azure needs the Entra
  app. Both are documented.
- The platform's cloud bill no longer grows with recordings.
