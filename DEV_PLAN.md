# NeuroCapture — Development Plan v3.1

**Hybrid app (web + native wrapper): capture, quality and biomarker readiness**

| | |
|---|---|
| Version | 3.1 (v3 + fixed-duration takes, override flow, readiness folded into the verdict) |
| Date | 13 November 2026 |
| Status | Implementation plan, ready for Claude Code |
| Platform | Web app (React + TypeScript) in a Capacitor wrapper, with a native capture plugin (Android first, iOS later) |
| Mockups | https://claude.ai/artifact/QYZxafDLLUSV47nhC5a9VH (see `docs/mockups.md`) |

**Later change (13 Nov 2026):** device-model approval (tier gating, §7) is **deferred** until the client asks for it; per-take fps/drop checks remain the safety net. See `docs/decisions/006-defer-device-model-approval.md`.

**Changes from v3** (agreed in the mockup review, 13 Nov 2026)
- **Fixed-duration takes.** Every take records for a fixed time instead of stopping after a number of reps: **15 s** for FT, FR, FTF and FA, **30 s** for SAW. Task detectors no longer decide when recording stops; they mark movement, events and phases.
- **Biomarker readiness is not shown to operators.** Readiness problems that a retake can fix become plain RETAKE reasons in the capture verdict. Everything else is saved in `quality.json` for the server and reviewers.
- **Override is a deliberate step: "Keep this take…".** It opens a panel that repeats the failure reasons, requires a reason from the config enum (free text for "other"), and confirms with "Keep and flag for review". Kept takes show as "Kept · flagged".

**Changes from v2**
- The platform is now a hybrid app. The UI, session flow and quality engine are TypeScript. Camera, recording, tracking, sensors, encryption and background upload live in a native plugin, **CaptureKit**.
- Added concrete specifications: per-test configs and thresholds, quality check conditions, rule-engine parameters, backend data model and API, repo tree, numeric acceptance criteria, device-tier thresholds, timestamp clock decision, key-management design.
- Added browser development modes (mock and webcam), so most UI and engine work runs without a phone.

> **How to use this file:** keep it in the repo root as `DEV_PLAN.md`; section 3 is copied into `CLAUDE.md`. Claude Code works one milestone at a time (M0 → M10). A milestone is done only when its numeric acceptance criteria pass.

---

## 1. Product summary

NeuroCapture is a **clinic/operator app** that records standardized videos of patients doing neurological motor tests. It does three things:
- guides positioning in real time
- monitors capture quality before and during recording
- stores enough evidence (video, frame timestamps, landmarks, sensor data, quality log) for server-side biomarker computation later

**Scope boundary:** this phase is a capture and quality platform. It does **not** diagnose disease, and it does not show diagnostic scores or biomarker values to patients or operators.

| Code | Examination | Biomarkers | Count | Sides | Take length |
|---|---|---|---|---|---|
| FT  | Finger Tapping    | FT1–FT12   | 12  | Right, Left (separate takes) | 15 s |
| FTF | Finger-to-Finger  | FTF1–FTF18 | 18  | Both arms in one take | 15 s |
| FR  | Forearm Roll      | FR1–FR12   | 12  | Right, Left (separate takes) | 15 s |
| SAW | Stand and Walk    | SAW1–SAW15 | 15  | Not sided | 30 s |
| FA  | Facial Activation | TBD        | TBD | Not sided | 15 s |

The UI follows the agreed mockup screens: Session home → Test instructions → Live framing check → Recording → Quality review → (Keep this take) → (Gait framing) → Session summary.

---

## 2. Engineering principles

1. **Recording is P0.** Tracking, quality checks, the UI, the WebView and uploads must never block recording. Analysis may drop frames; recorded frames must not.
2. **Native does hardware, web does logic.** Native owns camera, recording, tracking, sensors, timestamps, encryption and background upload. TypeScript owns the UI, session flow, quality engine, guidance and verdict.
3. **Config-driven protocols.** Test protocols, thresholds, prompts and UI copy are versioned configuration, never hard-coded.
4. **Pure quality core.** Quality checks are deterministic TypeScript functions with no browser, Capacitor or Android dependencies. The same code runs in the app, in Node (replay) and in tests.
5. **Traceability first.** Every biomarker traces to a capture requirement, a quality rule, persisted evidence and an acceptance test.
6. **Version everything.** App, plugin, config, schema and biomarker-registry versions are saved with every take.
7. **Privacy by design.** Minimal patient data, nothing in the public gallery, encryption at rest, TLS in transit, PII-safe logs.
8. **Graceful degradation.** Device tier and thermal state decide the capture modes allowed. Unsupported devices are blocked, so they never silently produce inadequate data.

---

## 3. Instructions for Claude Code (copied into `CLAUDE.md`)

- Work **one milestone at a time** (M0 → M10). Do not start the next milestone until every acceptance criterion of the current one passes.
- At the end of each milestone, report:
  1. files created/changed
  2. tests run and results
  3. each acceptance criterion with pass/fail and the measured value
  4. assumptions made
  5. decisions that need human review
- Put all protocol values, thresholds and user-facing text in `config/` and the i18n files. Never hard-code them.
- `packages/quality-core` must stay pure TypeScript: no DOM, no Capacitor, no Node-only APIs. 100% of its public functions need unit tests.
- Native plugin code must never wait on JavaScript to keep recording. JS failures, WebView reloads or a slow bridge must not stop or corrupt a recording.
- Never log patient names, external IDs, raw frames or landmark streams. Use the provided `logger` with PII redaction.
- Write ambiguities to `docs/assumptions.md` and carry on. Record significant technical choices in `docs/decisions/NNN-title.md`.
- Do not add features outside this plan (no diagnosis, no scoring UI, no cloud ML) unless asked.
- Keep commits small, one task per commit, with clear messages.

---

## 4. Technology stack (Option B: hybrid)

| Layer | Choice | Notes |
|---|---|---|
| Web app | **React 18+ + TypeScript (strict) + Vite** | UI, session flow, guidance, verdict |
| UI kit | Tailwind CSS + headless components | Large touch targets (≥ 48 px) |
| State | Zustand (UI state) + XState (session state machine) | The state machine is testable in Node |
| i18n | i18next (EN, HI, plus 1 regional language TBD) | Includes TTS prompt strings |
| Wrapper | **Capacitor (latest stable)** | Android first; iOS in M10 |
| Native plugin | **CaptureKit** (custom Capacitor plugin) | Android: Kotlin. iOS: Swift (M10) |
| Android camera | CameraX (Preview + VideoCapture + ImageAnalysis) + Camera2 interop | 60 fps, AE/AF/AWB lock, stabilization off |
| Tracking (in device mode) | **MediaPipe Tasks Vision for Android**, run inside CaptureKit | Hand, Pose, Face landmarkers, live-stream mode, GPU delegate with CPU fallback |
| Tracking (browser dev mode) | MediaPipe Tasks Vision for Web (`@mediapipe/tasks-vision`) | Only for the webcam dev/demo mode |
| Sensors | Android SensorManager (gyroscope, gravity/accelerometer), inside CaptureKit | |
| Local DB | `@capacitor-community/sqlite` with encryption (SQLCipher) | Patients, sessions, takes, upload queue |
| Video and evidence files | App-private storage, encrypted by CaptureKit (Tink StreamingAead) | Never in the gallery or shared storage |
| Background upload | Inside CaptureKit: Android WorkManager, chunked resumable upload | Keeps working when the WebView is closed |
| TTS / haptics | `@capacitor-community/text-to-speech`, `@capacitor/haptics` | |
| Shared contracts | JSON Schema + generated TS types (`json-schema-to-typescript`) + Kotlin data classes | `/contracts` |
| Backend | Python 3.12, FastAPI, SQLAlchemy + Alembic, PostgreSQL, S3-compatible storage (MinIO in dev) | |
| Analysis (later) | Python: MediaPipe / RTMPose, NumPy, SciPy | Biomarker readiness |
| Tests | Vitest (TS), Playwright (web UI in mock mode), JUnit + Robolectric (plugin), pytest (backend) | |
| CI | GitHub Actions | Lint, type check, tests, Android build, web build |

### Why tracking runs natively, not in the WebView
The native plugin owns the camera, and Android allows only one client to use a camera at a time. Sending 30 frames per second of images across the JS bridge would be slow and expensive. So CaptureKit runs MediaPipe natively and sends only small **landmark + frame-statistics events** to the web layer. Landmarks are packed as binary (Float32) and sent as base64, at most 20 KB per event. The quality engine, UI and verdict stay in TypeScript.

---

## 5. Architecture

### 5.1 Responsibilities

| Concern | Native (CaptureKit) | Web (TypeScript) |
|---|---|---|
| Camera open/close, preview | ✅ native preview rendered **behind** a transparent WebView | Draws overlays on a `<canvas>` above it |
| Recording (MP4, 60 fps) | ✅ | Start/stop commands only |
| Fixed-duration stop | ✅ native timer stops at `durationS` even if JS is unresponsive | Sends `durationS` with `startRecording`; may stop early on operator request |
| Exposure/focus/WB lock, stabilization off | ✅ | Requests via config |
| Per-frame timestamps of the recorded video | ✅ persisted | — |
| MediaPipe tracking | ✅ | Receives landmark events |
| Brightness, sharpness and face-light statistics | ✅ computed on the analysis frame | Receives stats |
| Gyroscope / gravity | ✅ | Receives sensor events |
| Quality checks, rule engine, gate, prompts | — | ✅ `quality-core` |
| Task detectors (movement, rep events, SAW phases) | — | ✅ `quality-core` |
| Verdict | — | ✅ |
| Encryption of files | ✅ | — |
| Persisting the landmark/sensor/event logs | ✅ (native writes the streams it produced) | Sends the quality log to native for encrypted write |
| Local DB | — | ✅ (encrypted SQLite plugin) |
| Background upload | ✅ WorkManager | Queues jobs, shows progress |

### 5.2 Pipeline

```
                      ┌────────────────────── CaptureKit (native) ──────────────────────┐
Camera 1080p@60 ─────►│ VideoCapture → MP4 → encrypt → app-private file     [P0 NEVER BLOCK]│
                      │ Camera2 CaptureCallback → frame timestamps (every recorded frame)  │
                      │ Native duration timer → stop at durationS                          │
                      │ ImageAnalysis (~480p, KEEP_ONLY_LATEST, ≤30 fps)                   │
                      │   ├─ MediaPipe Hand / Pose / Face (per test config)                │
                      │   ├─ luma mean, clipped %, Laplacian variance, face L/R luma       │
                      │   └─ landmarks.bin writer (encrypted)                [P1 MAY DROP]  │
                      │ Gyro + gravity → sensors.bin writer (encrypted)                    │
                      └───────────┬──────────────────────────────────────────────────────┘
                                  │ events (≤30 Hz): AnalysisFrame{ts, landmarks, stats}
                                  │ events (≤50 Hz, batched every 100 ms): SensorBatch
                                  ▼
                      ┌────────────────────── Web app (TypeScript) ─────────────────────┐
                      │ quality-core: checks → rule engine (window+hysteresis)          │
                      │             → gate / prompts / task detectors / verdict          │
                      │ UI: overlays (canvas), banners, TTS, haptics, Record lock         │
                      │ quality.json → CaptureKit.writeEvidence() (encrypted)             │
                      └──────────────────────────────────────────────────────────────────┘
Server: upload → storage → biomarker readiness (M8) → biomarker results (later)
```

### 5.3 CaptureKit plugin API (TypeScript contract)

```ts
export interface CaptureKitPlugin {
  getCapabilities(): Promise<DeviceCapabilities>;          // cameras, max fps per resolution, timestamp source, GPU
  runQualificationBenchmark(opts: BenchmarkOpts): Promise<BenchmarkReport>;

  openCamera(opts: {
    facing: 'back' | 'front';
    resolution: '1080p' | '720p';
    targetFps: 60 | 30;
    orientation: 'portrait' | 'landscape';
    trackers: Array<'hand' | 'pose' | 'face'>;
    analysisFps: number;                                    // e.g. 30
  }): Promise<{ previewTransform: PreviewTransform; actualFps: number }>;

  lockCameraSettings(opts: { ae: boolean; af: boolean; awb: boolean }): Promise<void>;
  startRecording(opts: { takeId: string; durationS: number }): Promise<{ startedAtNs: string }>; // native stops at durationS
  stopRecording(): Promise<RecordingResult>;               // early stop; file refs, frame count, effective fps, dropped frames
  closeCamera(): Promise<void>;

  writeEvidence(opts: { takeId: string; name: 'quality.json' | 'meta.json'; json: string }): Promise<void>;
  playTake(opts: { takeId: string }): Promise<{ playerUrl: string }>; // decrypts into a temporary in-app player
  deleteTake(opts: { takeId: string; reason: string }): Promise<void>;

  enqueueUpload(opts: { takeId: string; sessionId: string; endpoint: string; token: string }): Promise<void>;
  getUploadStatus(opts: { takeId: string }): Promise<UploadStatus>;

  addListener(e: 'analysisFrame', cb: (f: AnalysisFrameEvent) => void): Promise<PluginListenerHandle>;
  addListener(e: 'sensorBatch',   cb: (b: SensorBatchEvent) => void): Promise<PluginListenerHandle>;
  addListener(e: 'recordingState',cb: (s: RecordingStateEvent) => void): Promise<PluginListenerHandle>; // includes 'completed' with RecordingResult when the timer stops it
  addListener(e: 'thermal',       cb: (t: ThermalEvent) => void): Promise<PluginListenerHandle>;
  addListener(e: 'uploadProgress',cb: (u: UploadProgressEvent) => void): Promise<PluginListenerHandle>;
}

export interface AnalysisFrameEvent {
  seq: number;
  tsNs: string;                 // canonical clock (see 5.6), as a string to keep 64-bit precision
  imageW: number; imageH: number;
  hands?: { handedness: 'Left' | 'Right'; score: number; lm: string }[]; // lm = base64 Float32[21*4] (x,y,z,vis)
  pose?: { lm: string };        // base64 Float32[33*4]
  face?: { lm: string; blendshapes?: string; yawDeg: number; pitchDeg: number; rollDeg: number }; // lm Float32[478*3]
  stats: { lumaMean: number; clippedFrac: number; sharpness: number; faceLumaRatio?: number };
  trackerStatus: Record<'hand'|'pose'|'face', 'ok' | 'no_result' | 'error' | 'off'>;
}

export interface PreviewTransform {
  // maps normalized analysis coordinates to on-screen CSS pixels for overlay drawing
  scaleX: number; scaleY: number; offsetX: number; offsetY: number; rotationDeg: 0|90|180|270; mirrored: boolean;
}
```

The plugin has three implementations, chosen at startup:

| Implementation | Where | Purpose |
|---|---|---|
| `NativeCaptureKit` | Android device (iOS in M10) | **The only implementation allowed for clinical capture** |
| `MockCaptureKit` | Browser / Node | Replays recorded fixtures (landmarks + stats + sensors) on a timer. Used for UI development, Playwright tests and the replay tool |
| `WebcamCaptureKit` | Browser | getUserMedia + MediaPipe Web. Demo and quick UI testing only; marked **Tier W – not for clinical data** |

### 5.4 Session state machine (XState)

`PatientSelected → ConsentConfirmed → MedStateSet → DeviceCheck → [for each test/side: Intro → Framing → Countdown → Recording(fixed duration) → Review(Accept | Retake | KeepThisTake(reason) | Skip(reason))] → Summary → UploadQueued`

- Test order comes from `config/session.json`. Default: FT-R, FT-L, FR-R, FR-L, FTF, FA, SAW.
- Skipping a test requires a reason, from an enum plus free text.
- At most **3 retakes** per test. After that, only "Keep this take…" (with a reason) or Skip.
- "Keep this take…" is offered only after a RETAKE verdict. It requires a reason from `overrideReasons` (free text required for `other`), records operator ID and time, and sets `flaggedForReview: true`.
- The state is persisted after every transition, so the app resumes after process death (the take in progress becomes `Interrupted`; see §15).

### 5.5 Performance budgets

| Component | Priority | Target (measured on Tier A devices) |
|---|---|---|
| Video recording | P0 | Effective fps ≥ 58 at 60 fps target; dropped frames < 1%; never blocked |
| Take duration | P0 | Recorded duration = `durationS` ± 50 ms (native timer) |
| Native analysis (tracking + stats) | P1 | ≤ 50 ms per processed frame (p95); ≥ 20 analysis fps sustained |
| Bridge event size | P1 | ≤ 20 KB per AnalysisFrame event |
| Camera → web event latency | P1 | ≤ 80 ms p95 (sensor timestamp → JS receipt) |
| Quality evaluation (all checks, one frame) | P1 | ≤ 5 ms p95 in WebView |
| UI prompt update | P2 | ≤ 100 ms after the rule-engine state change |
| Overlay drawing | P2 | ≥ 30 fps canvas redraw |
| WebView memory | P2 | < 300 MB during a 30-minute session |

### 5.6 Timestamp and clock contract (decided)

- **Canonical clock:** Android `SystemClock.elapsedRealtimeNanos()`. All persisted timestamps are converted to this clock.
- **Sensors:** `SensorEvent.timestamp` already uses this clock on modern Android. Verify it on each device during qualification.
- **Camera:** read `CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE`.
  - `REALTIME` → use the frame timestamps directly.
  - `UNKNOWN` → estimate the offset to the canonical clock from the median difference between frame timestamps and `elapsedRealtimeNanos()` at callback over the first 60 frames. Record the offset and its spread. If the spread is > 5 ms, the device is Tier B at best.
- **Recorded frames:** a Camera2 interop `CaptureCallback.onCaptureCompleted` logs `SENSOR_TIMESTAMP` and the frame number for **every recorded frame** into `frames.bin`. The first recorded frame defines video t = 0. Map MP4 presentation times to canonical times using this list (parity tested in M2).
- **Analysis and landmark frames:** use the timestamp of the camera frame they were computed from (`ImageProxy.imageInfo.timestamp`), converted to canonical.
- **Saved for every stream:** source timestamp, canonical timestamp, clock source type, sequence number.

### 5.7 Landmark model (TypeScript, decoded from events)

```ts
interface Landmark { x: number; y: number; z: number; v?: number } // normalized 0..1 in the upright analysis frame
interface LandmarkFrame {
  seq: number; tNs: bigint;
  hands: { side: 'L' | 'R'; score: number; pts: Landmark[] }[];   // side already corrected for mirroring
  pose?: Landmark[]; face?: { pts: Landmark[]; yaw: number; pitch: number; roll: number; blend?: Record<string, number> };
  stats: { lumaMean: number; clippedFrac: number; sharpness: number; faceLumaRatio?: number };
  trackerStatus: Record<'hand'|'pose'|'face', 'ok'|'no_result'|'error'|'off'>;
}
```

---

## 6. Repository structure

```
neurocapture/
├── CLAUDE.md
├── DEV_PLAN.md
├── docs/
│   ├── assumptions.md
│   ├── mockups.md                    # link to the agreed mockups
│   ├── decisions/
│   ├── protocols/                    # human-readable protocols from the neurologist
│   └── traceability/
│       └── matrix.md                 # §11
├── contracts/                        # JSON Schemas, versioned (single source of truth)
│   ├── test-config.schema.json
│   ├── session-config.schema.json
│   ├── quality.schema.json
│   ├── meta.schema.json
│   ├── landmarks-header.schema.json
│   ├── biomarker-registry.schema.json
│   └── tests/                        # compatibility tests (old samples must still validate)
├── config/
│   ├── session.json
│   └── tests/ FT.json FTF.json FR.json SAW.json FA.json
├── packages/
│   ├── quality-core/                 # PURE TS: checks, rule engine, detectors, verdict, readiness hints
│   │   ├── src/checks/
│   │   ├── src/engine/
│   │   ├── src/detectors/
│   │   ├── src/verdict/
│   │   └── test/fixtures/{FT,FTF,FR,SAW,FA}/
│   ├── capture-kit/                  # Capacitor plugin
│   │   ├── src/                      # TS definitions + MockCaptureKit + WebcamCaptureKit
│   │   ├── android/                  # Kotlin: camera, recorder, tracking, sensors, crypto, upload
│   │   └── ios/                      # Swift (M10)
│   └── contracts-ts/                 # generated TS types from /contracts + validator CLI
├── apps/
│   └── mobile/                       # React + Vite web app + Capacitor config
│       ├── src/screens/              # SessionHome, TestIntro, Framing, Recording, Review, KeepTake, Summary, DeviceCheck
│       ├── src/session/              # XState machine
│       ├── src/guidance/             # prompt selection, TTS, haptics
│       ├── src/overlays/             # hand outline, upper body, full body, face oval
│       ├── src/data/                 # encrypted SQLite repositories
│       ├── src/i18n/
│       ├── android/                  # Capacitor-generated Android project
│       └── e2e/                      # Playwright (mock mode)
├── backend/
│   ├── app/ api/ models/ storage/ main.py
│   ├── analysis/                     # biomarker readiness (M8)
│   ├── alembic/
│   └── tests/
├── tools/
│   ├── replay/                       # Node CLI: runs quality-core on saved evidence
│   └── device_qualification/         # benchmark report templates and aggregation
├── docker-compose.yml
└── .github/workflows/
```

---

## 7. Device qualification and tiers

| Tier | Requirements (all must pass in the M1 benchmark) | Allowed |
|---|---|---|
| **A — Full** | 1080p, effective fps ≥ 58 for 10 minutes of continuous recording; dropped frames < 1%; analysis ≥ 20 fps while recording; camera timestamp source REALTIME, or offset spread ≤ 5 ms; no thermal throttling that drops recording fps in a 30-minute simulated session; AE/AF/AWB lock supported | All tests |
| **B — Limited** | 1080p or 720p at ≥ 29 fps stable; drops < 1%; analysis ≥ 15 fps | Only tests whose biomarkers are validated at 30 fps (initially **SAW and FA**; never FT, FTF or FR) |
| **C — Unsupported** | Anything else | Clinical capture blocked; demo mode only |
| **W — Web demo** | Browser webcam mode | Never for clinical data; every output is tagged `tier: "W"` |

The benchmark report is saved per device model and Android version. The app reads it at startup (DeviceCheck screen) and enables only the allowed tests.

---

## 8. Test configuration

### 8.1 Example: `config/tests/FT.json`

```json
{
  "schemaVersion": "1.0.0",
  "configVersion": "FT@1.0.0",
  "code": "FT",
  "name": "Finger Tapping",
  "biomarkers": ["FT1","FT2","FT3","FT4","FT5","FT6","FT7","FT8","FT9","FT10","FT11","FT12"],
  "sides": ["R", "L"],
  "minTier": "A",
  "trackers": ["hand"],
  "camera": { "facing": "back", "resolution": "1080p", "targetFps": 60, "minEffectiveFps": 58, "orientation": "portrait", "lock": { "ae": true, "af": true, "awb": true } },
  "analysis": { "fps": 30 },
  "setup": {
    "view": "front_offset_30deg",
    "distanceM": [0.6, 1.0],
    "heightRef": "hand",
    "checklist": ["sleeve_rolled", "phone_on_stand", "light_in_front", "seated_no_armrest"]
  },
  "framing": {
    "overlay": "hand_outline",
    "requiredLandmarks": { "hand": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20] },
    "safeZoneMargin": 0.05,
    "subjectSize": { "metric": "hand_bbox_height", "min": 0.25, "max": 0.45 },
    "handednessMustMatchSide": true
  },
  "task": {
    "detector": "tap_counter",
    "durationS": 15,
    "noMotionTimeoutS": 3
  },
  "verdict": {
    "minLandmarkVisibleFrac": 0.95,
    "durationToleranceS": 0.1,
    "maxCriticalEvents": 0,
    "sharpness": "DEVICE_CALIBRATED"
  },
  "instructions": {
    "demoVideo": "assets/demo/ft.mp4",
    "stepKeys": ["ft.step1", "ft.step2", "ft.step3"]
  }
}
```

### 8.2 All tests (starting values, tuned in the pilot)

| Test | Min tier | Trackers | Orientation | View / distance / height | Required in frame | Detector (events + movement window) | Duration | Visible-frames threshold |
|---|---|---|---|---|---|---|---|---|
| FT | A | hand | portrait | front, ~30° offset to tested side; 0.6–1.0 m; hand height | all 21 hand points; handedness = side | `tap_counter`: thumb-tip (4) ↔ index-tip (8) distance ÷ hand size (0→9), smoothed, peak detection | 15 s | ≥ 0.95 |
| FTF | A | pose + hand | landscape | front, centred; 1.5–2.0 m; chest height | nose, shoulders (11, 12), elbows (13, 14), wrists (15, 16); both hands | `ftf_cycle_counter`: index-tip trajectories, approach/separation cycles | 15 s | ≥ 0.95 (both wrists) |
| FR | A | hand + pose | landscape | front, centred; 1.0–1.5 m; chest height | elbow, wrist, all hand points of the tested side | `rotation_counter`: palm normal from hand points 0, 5, 17; sign changes of its forward component | 15 s | ≥ 0.95 |
| SAW | B | pose | landscape | side 90°; 3–4 m from walkway; hip height; floor tape at start and 5 m | all 33 pose points at start; ankles (27, 28) and heels (29, 30) throughout | `saw_phases`: seated → standing → walk out → turn → walk back → seated | 30 s | ≥ 0.90 (ankles) |
| FA | B | face | portrait | frontal; 0.4–0.6 m; eye height; \|yaw\|, \|pitch\| ≤ 10° | full face mesh (478 points) | `expression_sequence`: blendshape peaks per instructed expression | 15 s | ≥ 0.98 |

Common to all tests: 1080p; stabilization off; AE/AF/AWB locked after the gate passes; phone on a stand; operator behind the phone; the native timer stops recording at `durationS`.

### 8.3 `config/session.json`

```json
{
  "schemaVersion": "1.0.0",
  "configVersion": "SESSION@1.0.0",
  "order": [["FT","R"],["FT","L"],["FR","R"],["FR","L"],["FTF",null],["FA",null],["SAW",null]],
  "maxRetakes": 3,
  "skipReasons": ["patient_unable","patient_declined","time_constraint","equipment_issue","other"],
  "overrideReasons": ["clinically_adequate","patient_fatigue","max_retakes_reached","other"],
  "medStates": ["ON","OFF","NA"]
}
```

---

## 9. Quality engine

### 9.1 Check result

```ts
interface CheckSample {
  tNs: bigint;
  ruleId: string;              // e.g. "in_safe_zone@1.0.0"
  state: 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';
  value: number | null;
  threshold: number | [number, number] | null;
  confidence: number;          // 0..1, e.g. landmark visibility or tracker score
  configVersion: string;
}
```

`UNKNOWN` is **not** `FAIL`. It means the input was unavailable: tracker `error`, analysis frame dropped, or sensor gap. A tracker that ran and found nothing (`no_result`) is a real FAIL for presence checks.

### 9.2 Checks (in `packages/quality-core/src/checks/`)

| Rule ID | Input | OK when (default, configurable) | Used in |
|---|---|---|---|
| `subject_present` | trackerStatus + results | required tracker returned a result | all |
| `required_landmarks_visible` | landmarks + list | all listed points present; visibility ≥ 0.5 (pose) / hand score ≥ 0.6 | all |
| `in_safe_zone` | landmarks | all required points within [m, 1 − m], m = 0.05 | all |
| `subject_size` | landmarks | bbox metric within [min, max] from config | all |
| `handedness_match` | hand side | corrected side == tested side | FT, FR |
| `single_person` | pose / face count | exactly 1 | FTF, SAW, FA |
| `side_view` | pose | \|x(L shoulder) − x(R shoulder)\| ÷ torso height < 0.25 | SAW |
| `face_frontal` | face angles | \|yaw\| ≤ 10°, \|pitch\| ≤ 10° | FA |
| `brightness` | stats | luma mean in [60, 200] and clipped fraction < 0.05 | all |
| `face_light_balance` | stats | face L/R luma ratio in [0.7, 1.3] | FA |
| `sharpness` | stats | Laplacian variance ≥ 0.6 × device baseline (from calibration) | all |
| `tilt` | gravity | roll and pitch within ±5° of the expected orientation | all |
| `shake` | gyroscope | mean angular speed over 300 ms < 0.15 rad/s | all |
| `frame_drops` | recording result | dropped frames < 1%; effective fps ≥ config minimum | verdict |
| `analysis_health` | event stream | analysis fps ≥ 15 and event latency p95 ≤ 150 ms | all (UNKNOWN source) |

### 9.3 Rule engine

- A **sliding window** of 700 ms per rule.
- Window state:
  - `UNKNOWN` if more than 50% of samples are UNKNOWN (UI shows a neutral "tracking…", no error prompt)
  - otherwise **OK → WARN** when the bad fraction is > 0.6, and **WARN → OK** when it is < 0.2 (hysteresis)
- **Gate (before recording):** Record is enabled only when every gate rule has been OK continuously for ≥ 1.0 s.
- **Severity during recording:**
  - `INFO`: icon only.
  - `WARN`: banner + TTS prompt (cooldown 3 s per prompt), logged as an event.
  - `CRITICAL`: haptic + red banner, take marked invalid. Triggered by any of:
    - required subject missing > 2.0 s
    - wrong side or hand
    - second person > 1.0 s
    - shake > 1.0 s
    - recording fps drops below 50 for > 1 s
- **Prompt priority (only one prompt at a time):**
  1. wrong side/hand
  2. subject missing
  3. second person
  4. out of frame
  5. distance
  6. face angle
  7. lighting
  8. tilt
  9. shake
  10. blur

### 9.4 Task detectors (in `src/detectors/`)

- Input: a stream of LandmarkFrames. Output: events (`rep`, `phase_change`, `no_motion`) with timestamps, and the **movement window**.
- Detectors **do not stop recording**; the fixed duration does. Their outputs feed the verdict (movement present, SAW phases), the Review timeline and the evidence log.
- Signal smoothing with a One-Euro filter, plus a Savitzky–Golay filter for offline recompute. Peak detection uses minimum prominence and minimum distance from config.
- **Accuracy targets (on the M6 fixture library):**
  - event count exact or ±1 on ≥ 90% of fixtures
  - mean absolute count error ≤ 0.5
  - event precision and recall ≥ 0.90
  - SAW phase-boundary error ≤ 0.3 s median

### 9.5 Capture verdict

| Verdict | Condition |
|---|---|
| `PASS` | All of the conditions listed below |
| `RETAKE` | Any condition fails. Human-readable, actionable reasons are listed (e.g. "Hand left the frame for 2.4 s (8.1–10.5 s)") |
| `OVERRIDE` | Operator keeps a RETAKE take through "Keep this take…", with a reason from the config enum; operator ID and timestamp are logged; `flaggedForReview: true` |

**PASS conditions:**
- recorded duration ≥ `durationS` − `durationToleranceS` (the take was not stopped early or interrupted)
- movement present: no `no_motion` window longer than `noMotionTimeoutS` inside the take (for SAW: all six phases detected)
- landmark-visible fraction ≥ threshold
- no CRITICAL events
- effective fps ≥ `minEffectiveFps`
- dropped frames < 1%
- median sharpness ≥ threshold
- no UNKNOWN window lasting more than 2 s inside the movement window
- every registered biomarker whose missing input a retake could fix is COMPUTABLE in the readiness hint (§10); a failure becomes a plain RETAKE reason, never a biomarker name

---

## 10. Capture quality vs biomarker readiness

A technically good recording is **not** automatically biomarker-computable. There are two layers:

| Layer | Where computed | States | Shown to |
|---|---|---|---|
| Capture quality | Device (quality-core) | PASS / RETAKE / OVERRIDE | Operator (Review screen) |
| Biomarker readiness | Server (M8); device stores a hint only | COMPUTABLE / PARTIAL / NOT_COMPUTABLE per biomarker | Reviewers (server reports); **never operators** |

The device stores a **readiness hint**: what the registry says each biomarker needs, checked against this take's evidence. The server is authoritative.

- If a biomarker is NOT_COMPUTABLE for a reason a retake can fix (fps, visibility, duration), the verdict becomes RETAKE with a plain reason (e.g. "Frame rate dropped to 41 fps — retake").
- Otherwise (e.g. the device tier cannot support it), the hint is saved in `quality.json` only.

```json
{
  "captureVerdict": "PASS",
  "captureReasons": [],
  "biomarkerReadinessHint": {
    "registryVersion": "REG@0.1.0",
    "FT1": {"status": "COMPUTABLE"},
    "FT2": {"status": "NOT_COMPUTABLE", "reason": "requires >= 58 fps; effective 41.2 fps", "retakeFixable": true}
  }
}
```

---

## 11. Requirements traceability matrix

Kept in `docs/traceability/matrix.md`. **A biomarker counts as supported only when all five columns are defined and its acceptance test passes.** Until the biomarker definitions arrive, each test gets one row per biomarker family.

| Biomarker (family) | Capture requirement | Quality rule(s) | Persisted evidence | Acceptance test |
|---|---|---|---|---|
| FT temporal (rate, rhythm, hesitations) | ≥ 58 effective fps; full 15 s take | `frame_drops`, duration, `tap_counter` events | `frames.bin`, `landmarks.bin`, `quality.json` | Timing fixture: metronome tapping at 2, 3 and 4 Hz recovers rate within ±3% |
| FT amplitude / decrement | All 21 hand points visible; hand 25–45% of frame height; ~30° view | `required_landmarks_visible`, `subject_size`, `in_safe_zone` | `landmarks.bin` | Occlusion fixture: partly hidden thumb → RETAKE |
| FTF trajectory / accuracy | Both arms and hands in frame through full extension | `required_landmarks_visible` (pose + both hands), `single_person` | `landmarks.bin` | Full-extension fixture: wrists visible ≥ 95% |
| FR rotation rate / amplitude | Elbow + hand visible; ≥ 58 fps | `required_landmarks_visible`, `frame_drops`, `rotation_counter` | `landmarks.bin`, `frames.bin` | Known-rate rotation fixture: cycle count exact |
| SAW gait (cadence, step, turn) | Side view; feet visible across the walkway; floor marks visible; 30 s take | `side_view`, ankle visibility, `saw_phases` | `landmarks.bin` + movement window | Walk fixture: all 6 phases, boundary error ≤ 0.3 s |
| SAW sit-to-stand | Chair and whole body visible at start | `required_landmarks_visible` (33 points) at start | `landmarks.bin` | Rise fixture: rise phase detected |
| FA expressivity | Frontal face; even light | `face_frontal`, `face_light_balance`, `brightness` | Face landmarks + blendshapes + `quality.json` | Pose/light fixture: 20° head turn → RETAKE |

When a biomarker definition arrives, add one row per biomarker ID (FT1…FT12, etc.) with its exact needs.

---

## 12. Versioned data contracts

### 12.1 Files saved per take

```
takes/{sessionId}/{testCode}_{side|NA}_{takeNo}/
  video.mp4.enc          # encrypted MP4 (H.264, constant 60 fps target)
  frames.bin.enc         # per recorded frame: frameNo, sourceTsNs, canonicalTsNs
  landmarks.bin.enc      # header (JSON, schema landmarks-header) + Float32 records per analysis frame
  sensors.bin.enc        # gyro + gravity samples, canonical timestamps
  quality.json.enc       # verdict, events, metrics, readiness hint
  meta.json.enc          # device, capabilities, tier, versions, orientation, med state, operator
```

### 12.2 Version metadata

| Artifact | Required metadata |
|---|---|
| `quality.json` | schemaVersion, configVersion, rule IDs with versions, quality-core version |
| `meta.json` | schemaVersion, appVersion, pluginVersion, device model, OS version, tier, capability snapshot, timestamp source + offset |
| `landmarks.bin` header | schemaVersion, coordinate system (normalized, upright analysis frame), orientation, mirroring, timestamp semantics, tracker model versions |
| `frames.bin`, `sensors.bin` | schemaVersion, clock source type |
| Test / session config | schemaVersion, configVersion |
| Biomarker registry | registryVersion; for each biomarker, its formula version and input requirements |

**Compatibility rule:** a major schema change is breaking. A minor change must be backward-compatible, or ship a migration. The `contracts/tests/` samples from every earlier version must still validate (or migrate) in CI.

### 12.3 `quality.json` example

```json
{
  "schemaVersion": "1.0.0",
  "configVersion": "FT@1.0.0",
  "qualityCoreVersion": "0.1.0",
  "testCode": "FT", "side": "R", "take": 1, "tier": "A",
  "durationTargetS": 15, "durationS": 15.0, "stoppedEarly": false,
  "fpsTarget": 60, "fpsEffective": 59.8, "droppedFrames": 5, "droppedFrac": 0.006,
  "eventsDetected": 52, "landmarkVisibleFrac": 0.975,
  "sharpnessMedian": 182.4, "sharpnessBaseline": 240.1, "brightnessMedian": 131,
  "movementWindow": {"tStartS": 0.8, "tEndS": 15.0},
  "events": [{"tStartS": 6.2, "tEndS": 7.1, "ruleId": "in_safe_zone@1.0.0", "severity": "WARN"}],
  "unknownWindows": [],
  "captureVerdict": "PASS",
  "captureReasons": [],
  "override": null,
  "flaggedForReview": false,
  "biomarkerReadinessHint": {"registryVersion": "REG@0.1.0", "FT1": {"status": "COMPUTABLE"}}
}
```

---

## 13. Backend

### 13.1 Data model (PostgreSQL)

| Table | Columns |
|---|---|
| `sites` | id, name, region |
| `operators` | id, site_id, display_name_hash, role (`operator` / `reviewer` / `admin`), active |
| `devices` | id, site_id, model, os_version, tier, qualification_report (jsonb), registered_at |
| `patients` | id, site_id, external_ref_hash, year_of_birth, sex. **No names** |
| `sessions` | id, patient_id, operator_id, device_id, started_at, ended_at, med_state, app_version, config_versions (jsonb), consent_version, consent_at |
| `takes` | id, session_id, test_code, side, take_no, capture_verdict, override_reason, flagged_for_review, quality (jsonb), meta (jsonb), status (`pending` / `uploading` / `complete` / `failed`), checksums (jsonb), created_at, uploaded_at |
| `take_files` | id, take_id, kind (video / frames / landmarks / sensors / quality / meta), object_key, size_bytes, sha256, uploaded_at |
| `biomarker_runs` | id, take_id, registry_version, status, readiness (jsonb), results (jsonb), created_at (M8) |
| `audit_events` | id, actor_id, actor_type, action, target_type, target_id, at, details (jsonb) |

### 13.2 API (FastAPI; JWT per operator, device-bound)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/device-register` | Register a device with a site enrollment code |
| POST | `/auth/login` | Operator login on a registered device → access + refresh token |
| POST | `/auth/refresh` | |
| POST | `/sessions` | Create a session (patient ref hash, med state, versions) |
| PATCH | `/sessions/{id}` | Close the session |
| POST | `/takes` | Create a take record → returns presigned **multipart** upload URLs for each file |
| POST | `/takes/{id}/files/{kind}/complete` | Complete the multipart upload; server verifies SHA-256 |
| POST | `/takes/{id}/complete` | All files verified → status `complete` |
| GET | `/takes?session_id=` | List takes (reviewer role); filter `flagged_for_review` |
| GET | `/devices/{id}/tier` | Server-confirmed tier |
| GET | `/health` | |

Files are encrypted on the device with a per-file data key. The data key is sent over TLS, wrapped with the server's public key, so the server can decrypt (see §14). Object storage also applies server-side encryption.

---

## 14. Privacy, security and key management (decided)

**On the device**
- An Android Keystore **master key** (AES-256-GCM, non-exportable, hardware-backed when available) wraps each take's **data key**.
- Each take gets a random 256-bit data key. Files are encrypted with **Tink StreamingAead** (AES256_GCM_HKDF_4KB).
- The video is written by CameraX into app-private, no-backup storage. It is encrypted **immediately after stop** into `video.mp4.enc`, then the plaintext is deleted. A crash before encryption leaves a plaintext file in app-private storage only, and it is encrypted or removed on next start (§15).
- For upload, the data key is also wrapped with the **server RSA-OAEP public key** (bundled, with key ID and rotation support), and sent in the take metadata.
- Playback in the Review screen decrypts into a temporary in-memory or app-cache stream that is deleted when the screen closes.
- The local DB uses SQLCipher, with its key in the Android Keystore.
- **Retention:** local takes are deleted 24 h after the server confirms all checksums (configurable). Data keys are destroyed with them.
- **Lost device:** the admin revokes it on the server (refresh tokens invalidated). Local data stays encrypted with a non-exportable key.

**On the server**
- Server-side encryption on object storage, plus application-level decryption keys held in a KMS.
- Regular key rotation; access is audited in `audit_events`.

**Always**
- TLS 1.2+ in transit (1.3 preferred), with certificate pinning in the app.
- No patient names on the server. The local name (optional) stays only in the encrypted local DB.
- Consent text version, timestamp, and operator/session link are recorded.
- PII-safe logging: crash and analytics logs exclude names, external refs, raw video, landmarks and file paths that contain IDs.
- Follow India's DPDP Act 2023 principles: purpose limitation, data minimization, access logs, an India hosting region (TBD).

---

## 15. Failure and recovery state model

```
Take recording
├── Completed (timer reached durationS) → Encrypting → Stored
├── StoppedEarly (operator)             → Encrypting → Stored (verdict RETAKE: duration)
├── Interrupted
│   ├── CameraError          → discard partial; prompt retake
│   ├── StorageLow           → stop gracefully; keep the partial as RetainedForRecovery; block new takes (< 2 GB free)
│   ├── EncryptionFailure    → keep plaintext in app-private storage; retry on next start; never upload plaintext
│   ├── AppBackgrounded      → stop recording; take = Interrupted; prompt retake on return
│   ├── WebViewCrash/Reload  → native finishes the recording safely (timer still stops it); web resumes from persisted state
│   └── ProcessDeath         → on restart: scan for orphan files → encrypt → mark RetainedForRecovery
└── Discarded | RetainedForRecovery

Upload
Queued → Uploading → Paused(no network | Wi-Fi-only rule)
                   → FailedRetryable → exponential backoff (max 24 h)
                   → FailedPermanent  → shown on Summary; operator/support action
                   → Completed        → server SHA-256 verified → eligible for local deletion
```

**Required tests:**
- an incoming phone call mid-recording
- process kill (`adb shell am kill`) during recording and during encryption
- WebView reload during recording
- low storage
- network loss mid-upload and resume
- checksum mismatch
- reboot with a queued upload

---

## 16. Milestones

Timings assume 1–2 developers with Claude Code. Every milestone also follows the definition of done (§18).

### M0 — Foundation and contracts (≈ 1 week)
- [ ] Monorepo (pnpm workspaces) as in §6; `CLAUDE.md`, `docs/assumptions.md`, decision record template
- [ ] `apps/mobile`: Vite + React + TS strict + Tailwind; Capacitor initialized with an Android project
- [ ] `packages/capture-kit`: plugin scaffold with the full TS interface (§5.3) and `MockCaptureKit` replaying one sample fixture
- [ ] `packages/quality-core`: scaffold with Vitest
- [ ] `/contracts`: JSON Schemas for test config, session config, quality, meta and landmarks header; TS types generated; validator CLI
- [ ] `config/`: 5 test configs + session config with the values from §8 (unknowns marked `"TBD"` and allowed by the schema)
- [ ] Backend skeleton (FastAPI, SQLAlchemy, Alembic, pytest, ruff); `docker-compose.yml` (api + postgres + minio)
- [ ] `docs/traceability/matrix.md` with the §11 template
- [ ] CI: lint, type check, unit tests (TS, Python), web build, Android debug build, contract validation

**Accept:**
- CI is green.
- `docker compose up` → `/health` returns 200.
- The web app runs in the browser in mock mode and shows a placeholder home screen.
- The Android debug APK installs and opens the same screen.
- An invalid config or contract sample fails validation with a message naming the field.

### M1 — Device qualification and camera spike (≈ 1.5 weeks)
- [ ] CaptureKit Android: open camera, native preview **behind a transparent WebView**, request 60 fps (Camera2 interop `CONTROL_AE_TARGET_FPS_RANGE`), record MP4, per-frame timestamps via CaptureCallback
- [ ] `getCapabilities()` and `runQualificationBenchmark()`: effective fps, drops, timestamp source and offset spread, analysis throughput (with a dummy analyzer), 10-min recording, 30-min thermal run
- [ ] DeviceCheck screen (web) shows the report and the assigned tier (§7)
- [ ] Benchmark at least 3 target phone models; save reports in `tools/device_qualification/reports/`

**Accept:**
- Each tested phone has a saved report and a tier. *(Reduced by decision 006: one phone — OnePlus CPH2649 — benchmarked; ≥ 3 phones deferred with model approval.)*
- On a Tier A phone, a 10-min recording has effective fps ≥ 58 and drops < 1%. *(Deferred with model approval; per-take fps checks in M7 cover data quality.)*
- The WebView overlay draws on top of the live preview.

### M2 — Capture engine (≈ 2 weeks)
- [ ] Full recording path, isolated from analysis (separate threads/executors); AE/AF/AWB lock; stabilization off; orientation lock from config
- [ ] Native fixed-duration timer (`durationS`), independent of JS
- [ ] Timestamp contract (§5.6): `frames.bin`; MP4 PTS ↔ canonical mapping
- [ ] Encryption pipeline (§14): Keystore master key, per-take data key, Tink streaming encryption, plaintext deletion
- [ ] `writeEvidence`, `playTake`, `deleteTake`
- [ ] Sensor capture (gyro, gravity) → `sensors.bin` + `sensorBatch` events
- [ ] Device sharpness calibration routine (3 s of a static target → baseline)

**Accept:**
- With a synthetic 40 ms analysis delay injected, recording still has effective fps ≥ 58 and drops < 1% (Tier A).
- Recorded duration = `durationS` ± 50 ms in 20 of 20 takes, including with the WebView frozen.
- MP4 frame count = `frames.bin` count (±1).
- Mapped MP4 timestamps match canonical within 2 ms.
- `video.mp4.enc` copied off the device does not play.
- In-app playback works.
- A process kill during recording leaves no plaintext after the next start.

### M3 — Session flow and UI (≈ 2 weeks)
- [ ] Screens per the mockup: Session home, Test instructions (demo video, steps, setup checklist, Listen), Framing, Recording (countdown + beep, time-left display), Review, Keep this take, Summary
- [ ] XState session machine (§5.4), persisted after every transition
- [ ] Patient (local, encrypted SQLite), consent, med state, skip/override reasons
- [ ] i18n EN + HI (+ regional placeholder); TTS of instructions
- [ ] Runs entirely in the browser with `MockCaptureKit` (for development and Playwright)

**Accept:**
- A Playwright test completes a full 7-take session in mock mode, including one "Keep this take" override.
- On a device, killing the app mid-session and reopening resumes at the right step.
- The state machine has ≥ 90% branch coverage.

### M4 — Tracking layer (≈ 2 weeks)
- [ ] MediaPipe Hand / Pose / Face inside CaptureKit, live-stream mode, GPU with CPU fallback; only the trackers listed in config
- [ ] Frame stats: luma mean, clipped fraction, Laplacian variance (central crop), face L/R luma
- [ ] `analysisFrame` events with binary-packed landmarks (§5.3); TS decoder → `LandmarkFrame`
- [ ] `previewTransform`; overlays drawn correctly for both cameras and both orientations, including mirroring
- [ ] `landmarks.bin` writer; debug overlay toggle
- [ ] `WebcamCaptureKit` (Tier W) with MediaPipe Web, for browser demos

**Accept:**
- On Tier A while recording at 60 fps:
  - analysis ≥ 20 fps
  - event latency p95 ≤ 80 ms
  - event size ≤ 20 KB
  - recording still meets the M2 criteria
- Overlay points land within 2% of the frame size of the true landmark positions (checked against a printed hand/pose target).

### M5 — Positioning gate and guidance (≈ 2.5 weeks)
- [ ] All §9.2 checks as pure functions, plus unit tests with synthetic fixtures (correct, plus every failure condition)
- [ ] Rule engine (§9.3): windows, hysteresis, UNKNOWN handling, gate, severity, prompt priority, TTS cooldown, haptics
- [ ] Per-test overlays (hand outline, upper body, full body, face oval) that change colour with gate state; checklist chips as in the mockup
- [ ] Locking AE/AF/AWB is triggered when the gate passes

**Accept:**
- For each test, every scenario in the QA checklist (§17) produces the correct **single** prompt within 1.0 s, and Record stays disabled.
- A correct setup enables Record within 2.0 s.
- An injected tracker error shows "tracking…" (UNKNOWN), not an error prompt.
- Quality evaluation takes ≤ 5 ms p95 in the WebView.

### M6 — In-recording monitoring and task detectors (≈ 2.5 weeks)
- [ ] Live checks during recording; timestamped events; CRITICAL handling
- [ ] Detectors: `tap_counter`, `rotation_counter`, `ftf_cycle_counter`, `saw_phases`, `expression_sequence`
- [ ] Live time-left display and progress bar; no-motion detection; movement window
- [ ] Fixture library: for each test, at least 15 recorded fixtures (normal, slow, fast, interrupted, wrong execution), with manual ground-truth labels

**Accept:**
- The §9.4 detector targets are met on the fixture library.
- A no-motion window longer than `noMotionTimeoutS` is detected in ≥ 95% of "movement stops halfway" fixtures.
- Every CRITICAL condition is triggered by its fixture.

### M7 — Verdict, upload and recovery (≈ 2 weeks)
- [ ] Verdict (§9.5) with reasons, including retake-fixable readiness failures; Review screen per the mockup; "Keep this take" override with audit and `flaggedForReview`
- [ ] `quality.json` and `meta.json` written through `writeEvidence`
- [ ] Backend: models (§13.1), migrations, API (§13.2), presigned multipart upload, SHA-256 verification
- [ ] CaptureKit upload worker (WorkManager): chunked, resumable, Wi-Fi-only option, backoff
- [ ] All failure/recovery tests in §15

**Accept:**
- A full session uploads.
- Network loss mid-upload, then reconnection, resumes with matching checksums on the server.
- Every §15 test passes.
- Local files are deleted only after server confirmation and the retention time.

### M8 — Replay and biomarker readiness (≈ 2 weeks)
- [ ] `tools/replay`: a Node CLI that decrypts a take (dev keys) or reads fixtures, runs the **same** `quality-core` build, and outputs `quality.json`
- [ ] Parity test: replay verdict equals device verdict for the same input and config version
- [ ] `backend/analysis`: biomarker registry (`registryVersion`, each ID with its required inputs; `formula: null` until defined); readiness computation; mapping of missing inputs back to quality rules
- [ ] Readiness report per take and per session (reviewer role only)

**Accept:**
- 100% verdict parity on 50 recorded takes.
- The readiness report lists every registered biomarker ID for each test, with a status and reason.

### M9 — Pilot hardening (≈ 2 weeks)
- [ ] Performance pass on all approved devices; thermal policy (lower the analysis fps first, then disable non-essential overlays, never the recording fps)
- [ ] Training mode (practice takes, never uploaded); PII-safe crash reporting; audit events; accessibility (≥ 48 px targets, high contrast, TTS on all instructions)
- [ ] Private distribution: Firebase App Distribution for testers; Play Console internal or closed testing track for the pilot

**Accept:**
- A 7-take dry-run session takes ≤ 15 min.
- 20 consecutive sessions with no crash.
- Every Tier A device meets the M2 and M4 criteria in a 30-minute session.

### M10 — iOS plugin (later, after the pilot)
- [ ] CaptureKit Swift implementation (AVFoundation, MediaPipe iOS, CoreMotion), same TS interface and contracts
- [ ] iOS device qualification and tiers

**Accept:** the same M1–M7 device criteria on qualified iPhones; replay parity holds.

---

## 17. Testing and validation strategy

| Layer | What | Tooling | When |
|---|---|---|---|
| Unit | Checks, rule engine, detectors, verdict, state machine, timestamp mapping, decoders | Vitest, JUnit | Every commit (CI) |
| Contract | Schemas, old samples still valid, generated types compile | ajv + CI | Every commit |
| Replay / regression | Whole fixture library through `quality-core`; expected verdicts unchanged | `tools/replay` | Every commit touching quality-core or config |
| Web UI | Full session in mock mode | Playwright | Every PR |
| Plugin | Recorder isolation, duration timer, encryption, timestamps, upload worker | Robolectric + on-device instrumentation | Per milestone, on a real phone |
| Device | Qualification benchmark, thermal, 30-min session | `runQualificationBenchmark` | Each new device or OS version |
| Scenario QA | For each test: correct setup + every failure scenario (below) | Manual checklist sheet | M5, M6, M9 |
| Volunteers | 10–20 healthy people, varied age, height, skin tone; 3+ operators; test–retest on 2 days | Pilot sheet | Before the pilot |
| Clinical agreement | 100–200 takes; neurologist labels usable/unusable blind; compare with the verdict | Agreement report | Before the pilot |
| Recovery | All §15 tests | Manual + scripted adb | M7, M9 |

**Agreement targets before the pilot:**
- app verdict agrees with the neurologist on ≥ 90% of takes
- "PASS but clinically unusable" on ≤ 3% of takes

**Scenario QA checklist (per test; extend in `docs/qa/`):**
- **FT / FR:**
  - correct setup
  - wrong hand
  - too close
  - too far
  - fingers cut off
  - dark room
  - window behind the patient
  - phone tilted
  - phone shaken
  - hand leaves the frame for 3 s while recording
  - movement stops halfway
  - operator stops early
  - full 15 s reached (timer stop)
- **FTF:** one hand out of frame at full extension; second person enters; arms not extended
- **SAW:**
  - front view instead of side view
  - feet cut off at the far end
  - someone walks through the frame
  - patient uses a walker (records an assistive-device flag)
  - short room (3 m variant)
  - patient does not finish all phases within 30 s
- **FA:** head turned 20°, looking down, half the face in shadow, glasses on, hair covering the eyes, too close

---

## 18. Definition of done (every milestone)

- All acceptance criteria pass, with measured values reported.
- Relevant unit, integration and E2E tests pass; coverage of `quality-core` stays ≥ 90%.
- Lint, format and type checks pass.
- Known critical defects are fixed or explicitly waived in `docs/decisions/`.
- Docs, assumptions and decision records are updated.
- Schema and config versions are bumped when behaviour or a contract changes, and compatibility tests are updated.
- A reproducible demo artifact exists: an APK + a short screen recording, or a test report.

---

## 19. Open items (fill before or during development)

- [ ] Formal biomarker definitions and required inputs: FT1–FT12, FTF1–FTF18, FR1–FR12, SAW1–SAW15, FA list
- [ ] Exact FTF protocol (movement, target positions) and FA expression sequence (must fit in 15 s)
- [ ] SAW walkway: 5 m standard; whether a 3 m variant is allowed and how it is flagged; what happens when a slow patient does not finish within 30 s
- [ ] Approved target Android devices (benchmark 3–5 candidates in M1)
- [ ] Instruction and prompt languages beyond EN and HI
- [ ] Backend hosting provider and India region; KMS choice
- [ ] Clinical validation protocol and the ground-truth strategy for biomarkers
- [ ] Ethics committee approval and consent text (needed before any patient recording)
