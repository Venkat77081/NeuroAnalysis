# Biomarker analysis at the hospital (M15, decision 057)

`biomarkers/` (package `ncbio`) turns a decrypted 60 fps take into DNE biomarker values. It runs
at the hospital, next to the connector: NeuroCapture's servers never see a decryptable video
(decision 027). The output is decision support for clinicians, never a diagnosis, and it holds no
patient identity.

## Pipeline

1. **Keypoints** from every frame of the MP4 with **MediaPipe** (Apache 2.0):
   - pose 33 (`pose_landmarker_heavy`), with 3-D world points for SAW;
   - hands 21 each (`hand_landmarker`), named by the patient's side by matching each hand's wrist
     to the nearest pose wrist (never by MediaPipe's handedness label, which flips with mirroring);
   - face 478 (`face_landmarker`) for FA.
     Missing points are NaN. Keypoints can be saved (`.npz`) and analysed again later.
2. **Pre-processing** (paper Sec. IV-C), values in `config/analysis.json`:
   - gaps up to `maxGapS` are filled by linear interpolation; longer gaps stay missing;
   - median filter (`medianKernel` frames), then Savitzky–Golay (`savgolWindowS`, `savgolOrder`);
   - normalisation by a reference length: the forearm (pose elbow → wrist, median over frames).
3. **Cycles:** minima with a prominence of at least `minProminenceFrac` of the 5–95 % range and at
   least `minPeriodS` apart. A cycle never crosses a gap. Fewer than `minCycles` cycles makes the
   biomarker NOT_COMPUTABLE.
4. **Formulas** from `config/biomarker-registry.json` (REG@0.3.0; JBHI 2024 Table A-II and
   Hoang et al. 2022).
5. **Checks** from the registry inputs: frame rate (`minEffectiveFps`) and length (`minDurationS`),
   then the share of frames where the needed points are found (`minValidFrac`).

The result follows `contracts/biomarker-result.schema.json`: one entry per registry ID, with
`COMPUTED` and a value and unit, `NOT_COMPUTABLE` and a plain reason, or `NOT_IMPLEMENTED`.

## Run it

```bash
cd biomarkers && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
sudo apt-get install -y libegl1 libgles2      # MediaPipe needs EGL even on the CPU (Linux)
.venv/bin/python -m ncbio models              # download the models once (prints SHA-256)
.venv/bin/python -m ncbio analyse take.mp4 --test FT --out result.json --keypoints kp.npz
.venv/bin/python -m ncbio analyse kp.npz --test FT     # again from saved keypoints
.venv/bin/pytest -q && .venv/bin/ruff check .
docker build -f biomarkers/Dockerfile -t neurocapture-biomarkers .   # from the repo root
```

## Plan

| Step  | What                                                                                             | State |
| ----- | ------------------------------------------------------------------------------------------------ | ----- |
| M15.1 | Package, config, result contract, MediaPipe keypoints, pre-processing, **FT1–FT12**              | done  |
| M15.2 | **FR1–FR12** (wrist vertical position, pose 15/16)                                               | next  |
| M15.3 | **FTF1–FTF18** (index middle joint, hand 6: period, speed, smoothness, velocity angle, symmetry) |       |
| M15.4 | **FA1–FA18** (face mesh distances of Table A-III, normalised by the inner eye corners)           |       |
| M15.5 | **SAW1–SAW15** (3-D ankles, knee angles, pelvis; walking and turning segments)                   |       |
| M15.6 | Run at the connector: analyse each new take, store results at the hospital under the NCID        |       |
| M15.7 | Doctor's report on the patient page (labelled decision support), trends between visits           |       |
| M15.8 | Check on real recordings: keypoints by eye on sample takes, repeat-take agreement                |       |

## The report (FT)

`--report report.html` writes one self-contained HTML file (inline charts, no scripts), in the
dashboards' colours and in light and dark. Text is in `config/messages/report.en.json`.

1. **Results:** each measure for the right hand, the left hand and the asymmetry, with units and
   registry IDs; a value that cannot be computed shows the reason instead.
2. **Points found:** how often each hand was found, and the forearm length (the median
   elbow-to-wrist distance, with the number of frames).
3. **The tapping signal:** the formula, the filter settings, and each hand's signal before and
   after smoothing, with every closing of the fingers marked.
4. **Taps:** how a tap is found; one tap drawn with its amplitude, period and fastest point; the
   amplitude of every tap for both hands (a decrement shows as a falling line).
5. **Calculations:** each biomarker with its rule and its numbers put in, for example
   "mean of 46 taps = (0.453 + 0.472 + 0.463 + … + 0.362) ÷ 46 = 19.2 ÷ 46 = 0.417", and each
   asymmetry as "|R − L| ÷ (R + L)" with the values.
6. **Every tap:** a table per hand (start, period, amplitude, max speed, max acceleration).

`python -m ncbio demo-report demo.html` makes the same report from a synthetic take (no patient).
It shows a "Synthetic demo" note.

## Accuracy on synthetic tapping (tests/test_ft.py)

Both hands tapping at 3 Hz with an amplitude of 0.5 forearm, 60 fps, 15 s:

| Biomarker               | Expected | Computed | Note                                                |
| ----------------------- | -------- | -------- | --------------------------------------------------- |
| Amplitude (FT1)         | 0.500    | 0.488    | the median filter trims the peaks a little          |
| Period (FT4)            | 0.333 s  | 0.333 s  |                                                     |
| Max speed (FT7)         | 4.71 /s  | 4.65 /s  |                                                     |
| Max acceleration (FT10) | 88.8 /s² | 83.0 /s² | smoothing lowers the peaks of the second derivative |

These are the paper's own pre-processing effects, so values stay comparable with the DNE
dataset. Faster tapping is smoothed more; the filter sizes are in `config/analysis.json`.

## Speed

Pose (heavy) and hands together take about 25 ms per 1080p frame on 4 CPU cores in the test
container, measured on frames with no person in them, so real takes will be slower. A 15 s take
(900 frames) therefore takes 20–60 s on a small CPU server. A GPU is not needed.
