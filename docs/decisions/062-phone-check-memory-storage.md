# 062: The phone check also checks memory and storage; Phones pages for the platform and hospitals

- **Status:** accepted. Built on `claude/new-ui-for-app` and `main` (older dashboard look). Mockups: canvas page v35.
- **Asked by the user (24 Nov 2026):** "along with the frame rate check also check for storage and
  RAM so that video recording or upload is not affected, and collect those details and show: for
  the platform NCID with phone model, brand, fps, pixels, RAM, storage for all app users; for
  hospitals MRN, fps, RAM, storage." The limits below were agreed after the v35 review ("yes update
  the mocks and build it").

## What is checked, when

| Check                               | When                                     | Passes         | Warns                                      | Stops                                                            |
| ----------------------------------- | ---------------------------------------- | -------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Camera (unchanged, decision 035)    | joining, adding a clinic phone, the menu | 59 fps or more | 55–59 fps                                  | under 55 fps: not suitable                                       |
| Memory, total                       | the same                                 | 4 GB or more   | 3 GB                                       | under 3 GB: not suitable                                         |
| Memory, free                        | before each visit                        | not low        | Android's low-memory flag, or under 0.5 GB | never stops                                                      |
| Storage, free                       | the phone check, and before each visit   | 3 GB or more   | 2–3 GB                                     | under 2 GB, or less than the visit needs: the visit cannot start |
| Storage while recording (unchanged) | every take                               | —              | —                                          | under 500 MB the take stops and is kept                          |

- **Memory** is compared as the phone is sold ("4 GB"): Android reports a little less, so the bytes
  are rounded up to whole GiB.
- **What a visit needs** is worked out per phone. The 20 s check video is measured (bytes per second)
  before CaptureKit deletes it, and the rate is kept on the phone. A visit needs its seconds of video,
  plus the largest take again (its encrypted copy exists for a moment while it is saved), plus 0.25 GB.
  Five tests at 3.6 MB/s need about 0.8 GB. Before a phone has been measured, 4.5 MB/s is assumed.
- **Uploading** needs no extra space or memory: it sends the encrypted files already on the phone,
  in parts. So the storage start limit also protects the upload.
- Storage never stops a phone from joining: the patient can free space before the first visit.
- All limits are in `config/platform.json` (`deviceCheck.memory`, `deviceCheck.storage`) and
  `config/session.json` (`storage`).

## What is kept and who sees it

- **Kept per phone** (`devices.device_report`): brand, video size (pixels), video bytes per second,
  memory total and free, the low-memory flag, storage free and total, and when they were reported.
  Device data only: no names, numbers, photos, files, other apps or location.
- **Updated** when a phone joins or is added, when the check runs from the menu
  (`POST /devices/me/phone`, `kind: check`), and by the quick check before each visit (`kind: visit`).
- **Platform admin** (Phones page, `GET /platform/phones`): every phone at every hospital, patients by
  NCID only, clinic phones by name.
- **Hospital admin** (Phones page, first tab): the hospital's patients' phones by MRN, read live from
  the hospital's records through the connector (`/v1/patients/lookup`), and its clinic phones. The
  platform stores only the NCID.

## Native changes

- `Benchmark.kt` measures the record phase's MP4 (size, width, height) before deleting it, and its
  free-space need now follows its length (about 0.4 GB for the 20 s check instead of 3 GB, which had
  blocked the check on exactly the phones it should report on).
- `getMemoryStatus()` (Android `ActivityManager.MemoryInfo`), and the brand in the device info.
