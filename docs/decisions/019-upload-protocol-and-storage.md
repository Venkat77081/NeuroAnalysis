# 019 — Upload protocol and object storage

- **Status:** accepted for dev / CI / pilots; production storage provider still open (§19)
- **Date:** 2026-11-14
- **Milestone:** M7
- **Supersedes:** the interim part of decision 004 (upload no longer blocked on a MinIO image)

## Decision

- **One protocol for the phone, two storage backends:**
  1. `POST /takes` (idempotent on the phone's take ID) declares each file's size and SHA-256 and
     returns, per file, a multipart plan: part size and a signed URL per missing part.
  2. The phone `PUT`s each part and keeps the returned ETag.
  3. `POST /takes/{id}/files/{kind}/complete` with the ETags: the server assembles the object and
     recomputes **SHA-256 and size**. A mismatch returns 409 `checksum_mismatch` and starts a
     fresh upload of that file.
  4. `POST /takes/{id}/complete` when every file is verified → `complete` + `confirmed_at`. Only
     then may the phone delete its copy, after the retention time (§14).
  - Resume at any time: `GET /takes/{id}/upload` lists uploaded parts and fresh URLs for the rest.
- **`NC_STORAGE=local`** (default; docker-compose, CI, single-server pilots): parts go to an
  HMAC-signed, expiring URL served by this API; objects live under `NC_STORAGE_DIR`.
- **`NC_STORAGE=s3`** (production): presigned S3 multipart URLs, server-side encryption (SSE).
  The provider/region (India) is decided with hosting (DEV_PLAN §19); no third-party MinIO image.
- What is uploaded is the **encrypted** file (`*.enc`, Tink streaming AEAD). The take's data key
  travels in the take record, wrapped with the server's RSA-OAEP public key; the phone receives
  that key (and its ID) at device registration over TLS. The private key belongs in the KMS.
- Patient references are hashed on the phone with the site's salt (from registration); the server
  stores only the hash, year of birth and sex.
- Auth: device registration with a site enrollment code → device secret; operator login (code +
  PIN, PBKDF2) on a registered device → 15 min JWT + rotating refresh token; admins revoke lost
  devices. Every login, take and revocation is in `audit_events`.

## Consequences

- No third-party storage image is needed for development or CI.
- The local backend reads whole parts into memory (8 MiB) and assembles on disk: fine for pilots;
  production uses S3.
