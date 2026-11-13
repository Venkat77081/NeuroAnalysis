# 005 — Device qualification design (M1)

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M1

## Decision

- **Native measures, TypeScript decides.** `runQualificationBenchmark` returns raw measurements
  (`contracts/benchmark-report.schema.json`); `quality-core.assignTier` assigns the tier from
  `config/device-tiers.json`. Thresholds change without a native release.
- **Two runs.** A 60 fps run decides Tier A; if it fails, a 30 fps run decides Tier B. Any mock or
  webcam report gives Tier W.
- **Recorded fps comes from the MP4** (frame count and duration via MediaMetadataRetriever), so
  encoder drops count. Sensor timestamps from the Camera2 capture callback give the 1-second window
  minimum and the clock-offset spread.
- **Thermal run** records in ≤ 5-minute segments, deleted right after measuring, to keep a 30-minute
  1080p60 run within ~1.2 GB of temporary storage.
- **Video only, no audio track** (no RECORD_AUDIO permission).
- **`frames.bin` (M1 format):** little-endian records `{int64 frameNumber, int64 sensorTsNs, int64 canonicalTsNs}`
  for every capture-session frame while recording. M2 adds the header contract and encryption.
- **Reports leave the phone** through app-specific external storage
  (`adb pull /sdcard/Android/data/<appId>/files/qualification/`), then `tools/device_qualification`.

## Consequences

- Tier assignment is unit-tested in Node; the native benchmark needs real phones.
- M1 analysis is a dummy luma analyzer; the ≥ 20 fps analysis criterion is re-measured with MediaPipe in M4.
