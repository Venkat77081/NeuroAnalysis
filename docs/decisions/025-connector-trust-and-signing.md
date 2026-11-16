# 025 — Connector trust: Ed25519 signing, connector tokens, live records

- **Status:** accepted (M11)
- **Milestone:** M11 (docs/PLATFORM_PLAN.md §3)

## Decision

- **Signed requests both ways.**
  - Platform ↔ connector requests are signed with Ed25519 over the method, path and query,
    timestamp, nonce and SHA-256 of the body.
  - Each request must arrive within a 300 s window, and each nonce is used once.
  - The platform stores only each connector's **public** key; the connector holds the platform's
    public key. No shared secret exists on either side.
  - This was chosen over mutual TLS, which hospitals' proxies often terminate.
- **Connector tokens.**
  - The doctor's or hospital admin's browser calls the connector directly with a 10-minute
    EdDSA token from the platform (`POST /hospital/connector-token`, audience `site:<id>`).
  - The connector verifies the token offline, so patient identity never passes through the
    platform.
- **Who creates NCIDs.**
  - The connector asks the platform for a new NCID (and, optionally, an invite link), then
    stores the NCID ↔ MRN link in its own database.
  - Contact details are read from the records and handed to the hospital's provider.
  - Once a connector is registered, the platform refuses MRNs and contact details on its
    interim invite endpoint (`use_connector`).
- **Records are read live** through a FHIR R4 or SQL-view adapter on every request, with no
  cache. If the records system is down, the doctor view returns `records_available: false` and
  recordings still open.
- **Decryption at the hospital.**
  - The connector fetches a take's encrypted files from short-lived download links (S3 presigned,
    or signed local-storage links).
  - It checks the SHA-256, unwraps the data key and streams the plaintext with `no-store`.
- **Copies instead of a shared package.** The connector image carries copies of `takecrypto.py`,
  the signing functions and `config/messages/en.json`. Tests fail if a copy drifts from its
  source.

## Consequences

- **Clocks.** Hospitals must keep connector clocks in sync, within 5 minutes (NTP).
- **Nonces** are remembered per process. Running several platform API replicas needs a shared
  nonce store (Redis or the database) before scale-out.
- **Key change.** Until `NCC_PLATFORM_PUBLIC_KEY_PATH` is set, the connector trusts the key it
  fetches from the platform over HTTPS. Changing the platform signing key needs each connector
  restarted or reconfigured.
