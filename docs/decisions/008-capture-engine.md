# 008 — Capture engine: timestamps, MP4 mapping, encryption, sensors (M2)

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M2

## Decisions

- **Stream files.** `frames.bin` and `sensors.bin` use one envelope: 4-byte magic (`NCFR` / `NCSE`),
  uint32 LE header length, compact JSON header (`contracts/stream-header.schema.json`), then 24-byte
  LE records. Kotlin writer and TypeScript codec are pinned to `contracts/tests/golden/*.bin`
  (byte-for-byte tests on both sides).
- **Frame log** starts when recording is requested (before the first encoded frame) and ends at
  finalize, so the first encoded frame is always inside the log.
- **MP4 ↔ canonical mapping.** MP4 sample times are relative to the first sample, so the mapping is
  "sample j ↔ record j + firstRecordIndex". The offset is found by matching the interval pattern
  (`PtsAlignment`). With perfectly even frames several offsets fit; then the earliest is chosen and
  the header says `anchor: "earliest_candidate"`: relative timing is exact (checked ≤ 2 ms), absolute
  alignment may be off by 1–2 frames. If absolute alignment matters for biomarkers, add a CameraX
  `CameraEffect` frame tap on the video stream (records which frames are encoded).
- **Encryption.** Android Keystore master AEAD (`android-keystore://neurocapture_master_v1`, via Tink's
  `AndroidKeystoreKmsClient`) wraps a per-take StreamingAead key (`AES256_GCM_HKDF_4KB`) stored as
  `datakey.enc`. Associated data binds each file to its take and name. `frames.bin`, `sensors.bin`,
  `quality.json`, `meta.json` are encrypted while being written (never plaintext); the MP4 is written
  by CameraX as plaintext in app-private no-backup storage and encrypted right after finalize, then
  deleted. At start-up `TakeVault.recover()` encrypts any leftover plaintext (crash / process kill)
  and marks the take `RECOVERED` (RetainedForRecovery); decrypted playback copies are deleted.
- **Playback** decrypts to the app cache and is served to the WebView via Capacitor's local server;
  `closePlayback` deletes the copy. (Server-side key wrapping for upload is M7.)
- **Sensors.** Gyroscope + gravity at ~100 Hz on their own thread while the camera is open;
  `sensorBatch` to JS every 100 ms (capped); recorded to `sensors.bin` during takes. The sensor clock
  is checked per take (`sensorClockOffsetMs`, callback time − event time).
- **Sharpness.** Variance of the 4-neighbour Laplacian on the central 50 % of the analysis Y plane;
  `calibrateSharpness` returns the median over N seconds of a static target (device baseline).
- **Isolation test hooks.** `debugAnalysisDelayMs` (sleep in the analyzer) and a JS busy-wait in the
  engineering Capture test screen.
