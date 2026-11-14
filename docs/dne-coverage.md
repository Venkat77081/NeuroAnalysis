# DNE protocol coverage (as of M4, 14 Nov 2026)

Checked against the DNE-113 paper the user shared (Sections III–IV: protocol, record acquisition,
keypoint detection, pre-processing, biomarkers). ✅ covered · 🟡 partly / later milestone ·
❌ gap.

## A. Record acquisition

| Paper requirement                                                              | Status                                                                                                 | Where                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| FT: both hands, thumb–index tapping, big and fast, 15 s                        | ✅                                                                                                     | `config/tests/FT.json`, steps `ft.*`                  |
| FTF: index fingers to ceiling, then touch together in front of the chest, 15 s | ✅                                                                                                     | `FTF.json`, steps `ftf.*`                             |
| FR: hands gently clenched, forearms horizontal, roll hands around, 15 s        | ✅                                                                                                     | `FR.json`, steps `fr.*`                               |
| SAW: stand from chair, walk back and forth 15 ft, 45 s                         | ✅                                                                                                     | `SAW.json` (45 s, walkway 4.6 m)                      |
| FA: head still; eyebrows up, big smile, relax, repeated                        | ✅ steps · 🟡 spoken cue per expression during the take (M6 `expression_sequence`)                     | `FA.json`, steps `fa.*`                               |
| Patient seated for all tests except SAW                                        | ✅                                                                                                     | setup checklist, guides                               |
| Tripod with the phone, subject in view                                         | ✅                                                                                                     | checklist `phone_on_stand`; M5 checks subject in view |
| Investigator describes and demonstrates; app gives audio or visual cues        | ✅ steps, Listen (TTS), guides · 🟡 demo videos (`demoVideo: "TBD"`, content needed)                   | TestIntro                                             |
| Each exam recorded individually                                                | ✅                                                                                                     | one take per test, fixed duration                     |
| SAW in sagittal (side) view                                                    | ✅                                                                                                     | `side_90deg`, guide `full_body`; M5 `side_view` check |
| Everyday clothing / walking aids allowed                                       | ✅                                                                                                     | no restriction in the app                             |
| 60 fps                                                                         | ✅ all five tests target 60 fps (SAW and FA raised from 30 today); interim floor 30 fps (decision 007) | `camera.targetFps`                                    |
| Resolution "1080 × 720"                                                        | ✅ we record 1920×1080, which contains it; 720p is available in config if storage matters              | `camera.resolution`                                   |
| Upload to cloud storage for processing                                         | 🟡 encrypted local storage done; upload is M7–M8                                                       |                                                       |
| Home use (self-recording or with family)                                       | 🟡 not in scope of this plan; the app works the same                                                   |                                                       |

## B. Keypoints

| Paper                                | Ours                                                                                  | Status                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Hand 21 keypoints (OpenPose)         | MediaPipe Hand, 21 keypoints, both hands per take, L/R from handedness (decision 012) | ✅                                                                  |
| Body 25 keypoints (OpenPose BODY_25) | MediaPipe Pose, 33 keypoints (covers BODY_25 joints incl. heels and toes)             | ✅ (different model; mapping needed if biomarkers are reused as-is) |
| VideoPose3D for SAW (3D from 2D)     | not on the phone; the server can run it on the MP4                                    | 🟡 backend                                                          |
| Face 478 landmarks (MediaPipe)       | MediaPipe Face Landmarker, 478 points + 52 blendshapes                                | ✅ same model family                                                |

## C. Pre-processing (needs the right landmarks in view; computed on the server)

| Reference length           | Landmarks needed                  | Required in framing         |
| -------------------------- | --------------------------------- | --------------------------- |
| Forearm (FT, FR)           | elbow + wrist (pose 13–16)        | ✅ `requiredLandmarks.pose` |
| Shoulder (FTF)             | shoulders (pose 11, 12)           | ✅                          |
| Trunk (SAW)                | shoulders + hips (11, 12, 23, 24) | ✅ all 33 at start          |
| Intercanthal distance (FA) | inner eye corners (face 133, 362) | ✅ full face mesh           |

Median + Savitzky-Golay smoothing and truncation are analysis steps, outside the app (no
scoring in the app, CLAUDE.md).

## D. Biomarkers (not computed in the app; the app must capture what they need)

- **L/R symmetry** (most discriminative in Table II): needs both hands in one take, each labelled
  — ✅ since decision 013 and the handedness fix.
- **Period, amplitude, velocity, acceleration** (e.g. max tapping acceleration, rolling period):
  need good temporal resolution. The MP4 is 60 fps ✅. The on-device `landmarks.bin` is sampled
  at the analysis rate (30 fps) and is meant for quality gating; for biomarkers the server should
  re-run keypoints on the 60 fps MP4 (🟡 backend decision — see open questions).
- **SAW gait** (step length, walking speed, turning time): side view, feet visible, floor marks ✅;
  real-world scale needs the 4.6 m walkway marks visible (M5 check) 🟡.
- **FA** (mouth/eye opening, eyebrow lift, symmetry, IQR): face landmarks ✅; the expression
  sequence timing benefits from per-expression cues (M6) 🟡.

## Open questions for the client

1. Biomarkers from on-device landmarks (30 fps) or from server re-extraction on the 60 fps MP4?
2. OpenPose BODY_25 vs MediaPipe 33-point pose: is re-validating the biomarkers on MediaPipe
   acceptable, or must the server run OpenPose?
3. Demo videos for each test (the paper's investigator demonstration).
