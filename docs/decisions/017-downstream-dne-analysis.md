# 017 — Downstream analysis (DNE biomarkers, pyDNE, classifiers) stays outside the app

- **Status:** accepted (user, 14 Nov 2026)
- **Date:** 2026-11-14

## Context

The DNE paper (Sections IV–V) processes recordings in four steps: record acquisition, automated
keypoint detection (OpenPose hand 21 + body 25 for FT/FTF/FR/SAW, VideoPose3D for SAW,
MediaPipe 478 face points for FA), pre-processing (median + Savitzky–Golay smoothing,
truncation, normalisation by a reference length: forearm for FT/FR, shoulder for FTF, trunk for
SAW, intercanthal distance for FA), and biomarker extraction (75 biomarkers: FT 12, FTF 18,
FR 12, SAW 15, FA 18). pyDNE then analyses biomarkers (Mann-Whitney U, recursive feature
elimination) and trains classifiers: per-test models, a "mixture of DNE tests" (majority vote;
missing tests allowed) and a hierarchical HC → ND → PD/OD classifier.

The user will either reuse that model or train one on the collected dataset. **The model part
is kept aside.** The app and backend must produce data that this pipeline can consume as is.

## Decision

The app does **capture and capture quality only** (no biomarkers, no diagnosis, no scoring —
CLAUDE.md). What it guarantees for the downstream pipeline:

| Paper step                                               | What we provide                                                                                                                                                                                                                                                 | Milestone                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Record acquisition                                       | One **DNE record = one session**: FT, FTF, FR, SAW, FA takes; 60 fps 1080p MP4 per test; fixed durations (15 s / 45 s); seated front view, SAW sagittal; skipped/aborted tests recorded with a reason (the mixture-of-tests classifier tolerates missing tests) | done (M2–M5)                          |
| Follow-up recordings                                     | Same patient across sessions via the local patient ID → pseudonymous subject ID on the server, so repeat records link to one subject                                                                                                                            | M7–M8                                 |
| Keypoints                                                | The **MP4 is the primary input**: the server can run OpenPose / VideoPose3D / MediaPipe at 60 fps. Our on-device `landmarks.bin` (MediaPipe hand 21, pose 33, face 478, ~10–30 fps) is kept for quality gating and as an optional fast path                     | done (M4)                             |
| Pre-processing reference lengths                         | Framing requires the reference landmarks in view (elbows + wrists, shoulders, hips, inner eye corners)                                                                                                                                                          | done (M5)                             |
| Truncation to "appropriate segments"                     | `quality.json` carries the **movement window** and event timestamps from the M6 detectors, so the extractor can cut the active part                                                                                                                             | M6                                    |
| Quality filtering ("videos removed due to poor quality") | Capture verdict PASS / RETAKE / Kept · flagged per take, with reasons, before upload                                                                                                                                                                            | M6–M7                                 |
| Clinical annotation for training                         | A **record-level label field** (e.g. HC / PD / OD and sub-diagnosis), entered by a clinician on the server, never shown or inferred in the app                                                                                                                  | backend (M7+), needs product decision |
| Biomarker definitions                                    | Test configs list the paper's IDs: FT1–12, FTF1–18, FR1–12, SAW1–15, FA1–18                                                                                                                                                                                     | config                                |
| Export for pyDNE                                         | A dataset export per record: videos, keypoints, `meta.json`, `quality.json`, label                                                                                                                                                                              | backend (M8)                          |

## Consequences

- Detectors in M6 are for **capture quality** (movement present, counts plausible, SAW phases,
  movement window), not biomarkers. Their outputs are evidence for the verdict and for
  truncation downstream.
- Using MediaPipe on the device while the paper used OpenPose is fine because the server
  re-extracts keypoints from the MP4; if the on-device landmarks are used for biomarkers, the
  biomarkers must be re-validated on MediaPipe (`docs/dne-coverage.md`, open question 2).
- Open for the product owner: the export format expected by the client's analysis code.
