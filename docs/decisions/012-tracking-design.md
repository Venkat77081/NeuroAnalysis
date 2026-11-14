# 012 — Tracking layer: coordinates, handedness, timing, web mode

- **Status:** accepted; handedness rule revised 2026-11-14 after the first device check
- **Date:** 2026-11-14
- **Milestone:** M4

## Context

M4 adds MediaPipe Hand / Pose / Face inside CaptureKit. Overlays, `landmarks.bin` and later
quality checks (M5) and detectors (M6) all depend on one agreed coordinate frame, one rule for
left/right hands and one clock.

## Decision

- **Coordinates.** Landmarks are normalized to the **upright, un-mirrored analysis image**
  (rotation applied with `ImageProcessingOptions`, so `previewTransform.rotationDeg` is 0).
  The front-camera preview is mirrored on screen; the overlay applies `mirrored` when it maps
  points (`toScreen`). Preview, video and analysis are all 16:9 (A14), so one FILL_CENTER
  scale/offset maps them.
- **Handedness.** Events and `landmarks.bin` carry MediaPipe's **raw** label
  (`handednessLabels: "mediapipe_raw"`, `imageMirrored: false`). Consumers get the side only
  through `sideFromLabel(label, imageMirrored)`.
  - First version assumed MediaPipe labels as if the image were mirrored (its documentation says
    so) and flipped the label on our un-mirrored back-camera frames.
  - Device check (OnePlus CPH2649, back camera, right hand palm towards the camera, upright frames):
    raw label **Right** twice. So on un-mirrored frames the raw label already names the subject's
    hand; it is flipped only when `imageMirrored` is true.
  - Because the raw label is stored, takes written before the fix are read correctly by the new rule.
- **Running mode.** Android: `LIVE_STREAM` with result listeners; `FrameJoiner` merges the
  per-tracker results for one frame and marks missing ones as `error`. Only trackers listed in the
  test config are created. GPU delegate first, CPU on failure (`gpuDelegate` in capabilities).
  Tracking runs on the analysis thread and drops frames when busy; it never touches the recording
  path (CLAUDE.md native rule).
- **Clock.** `tsNs` is the frame's canonical time (§5.6); `emitNs` is when native sent the event;
  `procMs` is MediaPipe time. JS measures end-to-end latency by mapping `performance.now()` to the
  native clock with `clockNow()` (offset from the shortest of 5 round trips).
- **Web mode (Tier W).** `WebcamCaptureKit` runs the same three models with MediaPipe Tasks for
  Web 0.10.35 in `VIDEO` mode on a timer at `analysis.fps`, emits native-shaped events, records
  WebM with MediaRecorder (not encrypted, in memory only). It is lazy-loaded so mock and native
  builds never fetch the WASM. Models and WASM are served from `public/mediapipe` (fetched and
  hash-checked by `pnpm models`, not committed).

- **Upright input.** MediaPipe returns landmarks in the frame of the image it was given, even
  when a rotation option is passed (first device check: overlay rotated 90°). CameraX therefore
  rotates analysis frames (`setOutputImageRotationEnabled`), with a bitmap rotation as fallback.

## Consequences

- An overlay that is mirrored the wrong way, or L/R labels swapped, is a bug in `toScreen` /
  `sideFromLabel` only, so there is one place to fix and test.
- Web latency and fps numbers are not comparable with Tier A numbers; Tier W is demo only.
