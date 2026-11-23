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

## Testing with a phone recording (decision 058)

1. **Phone:** install the debug APK and turn on test mode.
2. **Record:** record Finger Tapping as usual (both hands, elbows in view).
3. **Save:** on the take's review screen, tap **Save video to phone**. The video goes to
   `Movies/NeuroCapture`.
4. **Copy:** copy it to the computer, then run:
   `python -m ncbio analyse NeuroCapture_FT_take1_….mp4 --test FT --report report.html`.

Release builds and phones set up to upload to a real server refuse to save videos.

### Checking right and left

- **Overlay video:** `--overlay check.mp4` writes a copy of the take with each hand's thumb tip,
  index tip, tapping line and forearm drawn in its report colour. Labels: **R** = patient's right
  (indigo), **L** = patient's left (orange). If R sits on the patient's left hand, the sides are
  swapped, for example because the video is mirrored. The copy shows the patient like the video
  itself, so it stays at the hospital with it.
- **One-hand take:** tap with the right hand only and hold the left still. The report must show
  taps for the right hand and none for the left.

## Plan

| Step  | What                                                                                              | State                        |
| ----- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| M15.1 | Package, config, result contract, MediaPipe keypoints, pre-processing, **FT1–FT12**               | done                         |
| M15.2 | **FR1–FR12** (wrist height above its lowest point, pose 15/16, in forearm lengths)                | done                         |
| M15.3 | **FTF1–FTF18** (index middle joint, hand 6: period, speed, smoothness, direction match, symmetry) | done                         |
| M15.4 | **FA1–FA18** (face mesh distances of Table A-III, normalised by the inner eye corners)            | done                         |
| M15.5 | **SAW1–SAW15** (3-D ankles, knee angles, pelvis; walking and turning segments)                    | done                         |
| M15.6 | Run at the connector after each upload; report kept encrypted in the hospital's storage           | done (decisions 059, 060)    |
| M15.7 | Report on the doctor's patient page (decision support); trends between visits                     | FT report done; trends to do |
| M15.8 | Check on real recordings: keypoints by eye on sample takes, repeat-take agreement                 |                              |

## The report (FT, FR, FTF, FA, SAW)

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

`python -m ncbio demo-report demo.html [--test FR|FTF|FA|SAW]` makes the same report from a synthetic take (no patient).
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

## Forearm Roll (FR1–FR12)

- **Signal:** h(t) = how high each wrist (pose 16 right, 15 left) is above its lowest point (the
  95th percentile of image y), divided by that side's forearm length. Only the body model is
  needed.
- **Measures:** the same four as tapping (`ncbio/cyclic.py`): each roll runs from one lowest point
  to the next, with amplitude, period, max speed and max acceleration as means over rolls, and
  Asym(R, L).
- **On synthetic rolling** (2 Hz, 0.4 forearm, 60 fps, 15 s), against the true values:

  | Measure      | Without jitter | With 2 px jitter |
  | ------------ | -------------- | ---------------- |
  | Amplitude    | −1 %           | −2 %             |
  | Period       | exact          | exact            |
  | Speed        | −2 %           | +5 %             |
  | Acceleration | −4 %           | +17 %            |

  Acceleration is the value most affected by jitter in the points.

## Finger-to-Finger (FTF1–FTF18)

- **Point:** each index finger's middle joint (hand point 6), in forearm lengths. A cycle runs from
  one top of its vertical movement to the next (top, bottom, top).
- **Per hand** (left first, as in the registry):
  - **period:** mean and STD of the cycle times;
  - **speed:** distance travelled in each half cycle ÷ its time, mean and STD;
  - **path smoothness:** per half cycle, path length ÷ length of a 2nd-order curve fitted along the
    path's main direction (1 = perfectly smooth), mean and STD;
  - **direction match:** the movement direction θ along each cycle, compared between every pair of
    cycles (Pearson CC of cos θ and sin θ, only where the joint moves), mean and STD.
- **Both hands:** per right-hand cycle, the CC of the two joints' distances from the body midline
  (horizontal, FTF17) and of their heights (vertical, FTF18).
- **On synthetic movement** (1 Hz, 0.6 × 0.3 forearm, 60 fps, 15 s):
  - period, speed and smoothness come out exact, and direction match and symmetry are 1.00;
  - with 2 px of jitter, direction match is 0.99;
  - with a slower left hand, symmetry falls to about −0.1.

## Facial Activation (FA1–FA18)

- **Points:** the MediaPipe face mesh (478 points). Each distance is Eq. A-I of the paper: the root of
  the summed squared distances between the paired points of two groups (Table A-III): eye opening
  (R, L), eyebrow height (R, L), mouth opening (left and right halves; their mean is "mouth"),
  mouth width (corners 78/308) and jaw opening.
- **Scale:** every frame is divided by that frame's distance between the inner eye corners (points
  133/362, "IED"), so head size and distance to the camera drop out. Then the shared smoothing.
- **Measures:**
  - FA1–FA5: STD of eye opening (R, L), mouth opening, mouth width, jaw opening (IED);
  - FA6–FA10: STD of the speed (change per second, IED/s) of eye opening (R, L), eyebrow height
    (R, L) and mouth opening;
  - FA11–FA14: NIQR = (P90 − P10) ÷ P90 of eye opening (R, L), mouth opening, mouth width;
  - FA15–FA18: Pearson CC of left and right eye opening, mouth halves, and their speeds.
- **Not computable** when the face is found in fewer frames than `minValidFrac`, or when a signal does
  not move at all.
- **Report:** results grouped by kind; how often the face was found and the IED; charts of each
  distance over the take; every calculation with its numbers.
- **On synthetic movement** (60 fps, 15 s): every value equals the formula on the known signals;
  left in step gives symmetry 1.00, a quarter cycle late 0.00, half a cycle −1.00; a bigger head
  changes nothing once divided by the IED. With 0.25 px jitter, the speed-based values are the most
  affected (FA6 about +11 %, FA17 about 0.85), since differencing amplifies noise.

## Stand and Walk (SAW1–SAW15)

- **Setup:** the patient stands up from a chair and walks back and forth along 15 ft (4.6 m),
  filmed from the side (`config/tests/SAW.json`, `side_90deg`). 45 s.
- **Points:** MediaPipe's body model gives every point twice from the same video: in the picture
  (px), and as a 3-D estimate in metres around the hips. There is no depth camera.
- **Trunk:** middle of the hips (23/24) to middle of the shoulders (11/12). The 3-D median is the
  unit for lengths; the picture's median turns the pelvis's movement across the picture into trunk
  lengths, because the 3-D points are centred on the hips and do not move across the room.
- **Walking and turning:** walking where the middle of the hips moves across the picture at least
  35 % of its 90th-percentile speed (and 0.3 trunk/s) for 1 s or more; a turn is the stretch between
  two walks in opposite directions. Standing up and sitting down are left out (`config/analysis.json`
  `saw`).
- **Steps:** d_saw = 3-D distance between the ankles (27/28) ÷ trunk. A step is a top of d_saw in a
  walk; the lowest d_saw between two steps is the step width.
- **Measures:**
  - SAW1 / SAW15: STD / mean time between steps; SAW2 / SAW3: mean / median d_saw at the steps;
    SAW4 / SAW5: mean / STD step width;
  - SAW6–8: per walk, the correlation of the left and right knee bend (180° − 3-D hip–knee–ankle
    angle), the left shifted in time (up to one stride) to line up best; median, mean, STD;
  - SAW9: per stride, the same for the ankles' forward positions relative to the hips; mean;
  - SAW10 / SAW11: mean / STD cadence over the walks (steps ÷ walk time × 60);
  - SAW12: mean walking speed (trunk lengths per second); SAW13 / SAW14: mean / STD turning time.
- **Report:** results by group; the walks and turns drawn over the take with a table per walk;
  the ankle distance with every step and pass marked; both knees; every calculation.
- **Check video:** `--overlay` draws each leg (hip, knee, ankle) in its colour with R/L. Side views
  are where the body model most often swaps the legs, so check this on the first real takes.
- **On synthetic walking** (side view, 1.15 m/s, 105 steps/min, 1.5 s turns, 45 s):
  - cadence 105.0, step time 0.572 s, speed within 0.3 %, turning time 1.50 s, step length within
    1 % of the 3-D truth;
  - knee and foot symmetry 1.00; a left knee that bends differently gives about 0.8;
  - a 30 % bigger body changes nothing; 1 cm of 3-D jitter leaves knee symmetry above 0.98.
- **Limits:** a front view gives "no walking found" (the hips hardly move across the picture).
  Step width relies on depth, the least accurate direction of single-camera 3-D in a side view.
