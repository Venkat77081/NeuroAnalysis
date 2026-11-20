# 057: Biomarker analysis with open-source libraries (M15)

- **Status:** started on branch `claude/biomarker-analysis` (from `main`), not merged.
- **Asked by the user (20 Nov 2026):** "start with the biomarker analysis with open source
  libraries … in a separate branch from main; keep the new UI branch separately".

## Decision

- **Keypoints: MediaPipe Tasks** (Apache 2.0) for pose 33, hands 21 and face 478.
  - The paper's OpenPose is non-commercial only and VideoPose3D is CC BY-NC (decision 017).
    MediaPipe is free for commercial use and is already on the phone, and the registry already
    uses MediaPipe point numbers.
  - Server side, at full rate: every frame of the 60 fps MP4, with the heavy pose model. The
    phone's landmarks stay for guidance and capture quality only.
  - **RTMPose / MMPose** (Apache 2.0) is the fallback if MediaPipe's hands prove too unsteady on
    real takes. The keypoint step is one module (`ncbio/keypoints.py`), so it can be swapped.
- **Signals: NumPy and SciPy** (BSD): `medfilt`, `savgol_filter`, `find_peaks`. **Video: OpenCV**
  (Apache 2.0).
- **Where it runs:** a separate package `biomarkers/` and image, at the hospital next to the
  connector (decision 027). It reads decrypted takes only there, and writes values with no
  identity.
- **Config:** models, thresholds and filter sizes in `config/analysis.json`
  (`contracts/analysis-config.schema.json`). Results follow
  `contracts/biomarker-result.schema.json`.
- **Statuses:** every registry ID is listed in each result as COMPUTED (value and unit),
  NOT_COMPUTABLE (plain reason, such as "left hand found in 31 % of frames") or NOT_IMPLEMENTED.
- **Order of work:** FT first (M15.1), then FR, FTF, FA and SAW, then running at the connector and
  the doctor's report (docs/biomarkers.md).

## Not decided here (needs review)

- Whether results are shown to doctors, and how (CLAUDE.md: no scoring UI unless asked).
- Clinical validation on real recordings: the formulas are tested on synthetic movement only so
  far.
- Units: values are in forearm lengths (normalised, as in the paper), seconds, or ratios.
