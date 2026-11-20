# 058: Save a take's video to the phone in test mode

- **Status:** built on branch `claude/biomarker-analysis`, not merged.
- **Asked by the user (20 Nov 2026):** "in app debug in test mode allow to download the recorded
  video to phone so I can use that to test it" (with the biomarker analysis, decision 057).

## What it does

- **Button:** the take's review screen shows **Save video to phone** in the debug APK's test mode
  (decision 041), and in the browser mock for the e2e tests.
- **Where it goes:** the take's video is decrypted and saved to `Movies/NeuroCapture` as
  `NeuroCapture_<test>_<side>_take<n>_<date>.mp4`. It shows in the phone's gallery and can be
  copied to a computer for `python -m ncbio analyse … --report`.
- **Plugin:** a new call, `exportTakeVideo({ takeId, label })`. On Android it saves through
  MediaStore, so no storage permission is needed.

## Safeguards

A patient's recording must never leave the app (decision 027), so the phone refuses in three ways:

- **Release builds:** the native call checks that the app is a debug build; a release APK always
  answers `export_not_allowed`.
- **Real servers:** a phone set up to upload to any server (any upload profile) also answers
  `export_not_allowed`. Test mode never sets one, because its uploads go to the pretend hospital.
- **Hidden button:** the button is shown only in test mode. The browser's webcam mode has no
  export.

Android 9 and older answer `export_needs_android_10`.

## Tests

- **Browser e2e (`apps/mobile/e2e/patient.spec.ts`):** the first take of the home session is saved
  in the mock, and the note names the file.
- **Not run here:** the native code is compiled and tested by the CI Android job
  (`assembleDebug`); this container has no Android SDK. It needs one check on a phone.
