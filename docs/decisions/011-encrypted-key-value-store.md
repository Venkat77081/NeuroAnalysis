# 011 — Encrypted key–value store instead of SQLCipher (M3)

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M3

## Context

DEV_PLAN §4 names `@capacitor-community/sqlite` with SQLCipher for patients, sessions, takes and the
upload queue. M3 needs only a few small JSON records (patients, the current session snapshot,
settings). CaptureKit already holds an Android Keystore master key and Tink (decision 008).

## Decision

- CaptureKit gets `secureGet/securePut/secureDelete/secureKeys`: one Tink-AEAD-encrypted file per key
  in no-backup storage, key bound as associated data, atomic writes.
- The app uses an `AppStore` interface: the CaptureKit store on a device; localStorage **in the
  browser for development only** (marked `encrypted: false`, never used with native capture).
- Stored keys: `patient.<localId>`, `session.current` (XState persisted snapshot, written after every
  transition), `sessiondone.<id>`, `settings`.

## Consequences

- No extra native dependency or SQL schema; data stays encrypted with the same Keystore key.
- No queries: lists are prefix scans (fine for hundreds of patients). The upload queue (M7) lives
  in native WorkManager state anyway. Revisit SQLCipher if reviewers need search or reporting on
  the device.
