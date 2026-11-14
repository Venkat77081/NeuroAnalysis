# 020 — Native upload worker, key wrapping and §15 recovery

- **Status:** accepted
- **Date:** 2026-11-14
- **Milestone:** M7

## Decision

- **Uploads run natively.** `UploadQueue` (pure Kotlin, JVM-tested) keeps one record per take in
  its own Keystore-encrypted store (`noBackupFilesDir/uploads`). `UploadWorker` (WorkManager)
  runs it. WorkManager restarts the work after a reboot. Nothing waits on JavaScript; the
  WebView only listens to `uploadProgress` events.
- **The same protocol in both languages.** The Kotlin client mirrors `src/upload/protocol.ts`:
  - It resumes from the server's plan, using the ETags of parts already uploaded.
  - It re-sends a file after `checksum_mismatch`, up to 3 times.
  - It refreshes the token once on a 401. A second 401 pauses the take with `login_required`.
  - Server session and take IDs are saved the moment they are known, so a killed process
    resumes the same take.
- **Tokens never live in the WebView.** The app passes tokens once, at sign-in
  (`configureUploads`). The plugin stores and rotates them. Later `configureUploads` calls
  without tokens keep the stored ones. The PIN is never stored.
- **Wi-Fi only** uses WorkManager's unmetered-network constraint. Takes waiting for Wi-Fi show
  `paused · wifi_required`.
- **Backoff:**
  - WorkManager exponential backoff starts at 30 s. WorkManager caps the delay at 5 h, which
    meets the §15 limit of 24 h.
  - An operator "Retry now" re-queues the take at once.
- **Data-key wrapping:**
  - When a take is uploaded, its Tink StreamingAead keyset is exported in binary form. It is
    about 100 B, which fits one RSA-2048 block.
  - The keyset is wrapped with RSA-OAEP: SHA-256, MGF1-SHA-256, no label.
  - The wrapped key is sent as `wrapped_data_key`, together with the server `key_id`.
  - Keys are wrapped at upload time, not when the take is queued. A server key rotation
    therefore re-wraps any take that is not yet uploaded.
  - The server decrypts each `.enc` file with Tink streaming AEAD. The associated data is
    `nc-file-v1:<client take id>/<file name>`.
- **Files uploaded** (`take_files.kind`): video, frames, landmarks, sensors, quality, meta.
  These are the `.enc` files exactly as stored. `quality`/`meta` JSON for the take record are
  read from the decrypted evidence when the app does not include them inline.
- **Retention:**
  - Local takes are deleted `retentionHours` after the server confirms them; the default is
    24 h, set in `session.json` `upload`.
  - Deleting a take deletes its directory and its data key with it.
  - A one-off worker wakes up when the next deletion is due.
- **Session close** waits until every queued take of the session is confirmed. The phone uses
  `POST /sessions/{id}/close`, a POST alias of PATCH, because `HttpURLConnection` cannot send
  PATCH.
- **§15 recording faults:**
  - _StorageLow:_
    - No new take starts below `minFreeGbToStart` (2 GB). The app shows a message and the
      plugin rejects with `STORAGE_LOW`.
    - A take in progress stops when free space falls below `stopBelowMb` (500 MB). It is
      marked `interrupted` with reason `storage_low`, and the partial take is kept encrypted
      as RetainedForRecovery.
  - _AppBackgrounded_ (an app switch, or an incoming call taking the screen): `handleOnPause`
    interrupts the take (`app_backgrounded`). The app returns to framing with a plain notice.
  - _EncryptionFailure:_ plaintext stays in app-private storage and is marked `ENCRYPT_PENDING`.
    Encryption is retried at the next start. Uploads read `.enc` files only, so plaintext is
    never uploaded.

## Consequences

- A phone can be enrolled and signed in without a running server only in mock mode, where
  `fake://api` is the built-in test server. Testing against the real server waits for Docker or a
  cloud host (on hold).
- The Kotlin code is compiled and unit-tested in CI (`testDebugUnitTest`). Behaviour on a device
  is covered by the M7 QA sheet (`docs/qa/m7-device-tests.md`).
