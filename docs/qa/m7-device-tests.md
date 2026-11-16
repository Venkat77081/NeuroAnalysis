# M7 on-device tests (upload and §15 recovery)

Debug APK from CI. These tests need a reachable server (Docker or a cloud host, both on hold).
Until then, run only rows 1–4 and 9; mock mode covers the rest in CI (e2e `uploads`, `recovery`;
JVM `UploadQueueTest`).

| #   | What                                                                                     | Expected                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Low storage: fill the phone to < 2 GB free, open framing                                 | Red message "Storage almost full …"; Record disabled                                            |
| 2   | Low storage during a take: free space falls below 500 MB while recording (e.g. SAW 45 s) | Take stops; framing notice "Storage ran low …"; take listed as recovered                        |
| 3   | Press Home during a take; come back                                                      | Framing notice "The app left the screen …"; record again works                                  |
| 4   | Incoming call during a take (call from another phone, accept it)                         | Same as row 3                                                                                   |
| 5   | `adb shell am kill com.neurocapture.app` during recording, and during encryption         | On restart: take marked recovered, no plaintext `.mp4` left in `files/takes/*`                  |
| 6   | WebView reload during a take (engineering menu → reload)                                 | Native timer still ends the take; session resumes at framing with the take as interrupted       |
| 7   | Register (enrollment code), sign in (code + PIN), run a full session                     | Summary: every passed/kept test shows "Uploading n%" → "Uploaded"; server lists the 5 takes     |
| 8   | Flight mode at ~30 % of a video upload; turn it off after 1 min                          | "Will retry · No connection" → resumes (no restart from 0) → "Uploaded"; server SHA-256 matches |
| 9   | Wi-Fi only on, phone on mobile data                                                      | "Paused · Waiting for Wi-Fi"; uploads start when Wi-Fi connects                                 |
| 10  | Reboot the phone with uploads queued                                                     | Uploads continue after boot without opening the app                                             |
| 11  | Sign out on another phone / revoke this device on the server                             | Takes pause "Sign in to upload"; signing in again continues                                     |
| 12  | Retention: set 24 h, upload; check the take folder after 24 h                            | Take folder (with its key) deleted only after server confirmation + 24 h                        |
