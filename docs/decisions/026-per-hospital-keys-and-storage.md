# 026 — Per-hospital take keys and storage

- **Status:** accepted (M12); one open question, below
- **Milestone:** M12 (docs/PLATFORM_PLAN.md)

## Decision

- **Hospital take keys.**
  - Each hospital's connector generates an RSA-3072 (or larger) key pair
    (`python -m ncconnector rotate-take-key`) and registers only the public key, through a
    signed request. The private key stays in the connector's keyring (`NCC_TAKE_KEYS_DIR`), one
    file per key ID.
  - **Each new session gets the hospital's active key** (`encryption_key` in the
    `POST /sessions` response). Every take in that session must use that key ID; any other key
    is refused (`wrong_key`).
  - **Rotation:** a new registration retires the previous key. Sessions already started keep
    their key, new sessions get the new one, and the connector keeps old private keys so
    earlier recordings stay readable.
  - **Fallback:** managed hospitals without a registered key fall back to the platform key
    (pilot compatibility). Own-system (`byo`) hospitals cannot start sessions without one
    (`no_hospital_key`).
- **Hospital storage.**
  - `managed` uses NeuroCapture storage, separated per hospital: by prefix, or by bucket via
    `NC_MANAGED_BUCKET_TEMPLATE`.
  - `s3` uses the hospital's own bucket. The platform assumes the hospital's IAM role with a
    platform-generated ExternalId, and adds a session policy narrowed to `s3:PutObject`,
    `s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` under the hospital's prefix.
  - The dashboard shows the trust and permissions policies to attach. Switching to `s3` runs a
    test first (assume role, start and abort an upload, try to read back) and is refused unless
    the upload works.
- **Where each file lives** is recorded when its take is created, so changing storage never
  moves or strands earlier recordings.
- **Checksums in a hospital bucket.** The platform cannot read objects back, so it checks sizes
  from the part list. The connector checks SHA-256 when it first reads a file and reports the
  result (`checksum_verified`); a mismatch is logged on the platform.
- **Azure Blob and GCS** are deferred until a hospital needs them. Their upload protocols
  differ from S3 multipart, which the phone speaks today.

## Open question — server-side biomarkers

DEV_PLAN and decision 023 say biomarkers are computed on the server from the 60 fps video. With
hospital keys, the platform can no longer decrypt recordings: server readiness already falls back
to the phone's hint (`source: device_hint`). Two ways forward:

1. **Compute at the hospital.** The biomarker job runs next to the connector (same image or a
   sidecar) and writes results to the hospital's database under the NCID. This keeps the
   M12 guarantee.
2. **Hospital-approved processing on the platform.** The connector re-wraps a take's data key
   for a NeuroCapture processing key, per take or per hospital opt-in. This is simpler to run,
   but weakens "readable only by the hospital".

The recommendation is option 1. It needs a product decision before biomarker computation is
built.
