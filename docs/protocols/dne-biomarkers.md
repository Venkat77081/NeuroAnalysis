# DNE biomarkers (from the DNE toolbox paper, JBHI 2024, appendix)

Source: the appendix of "Smartphone-Based Digitized Neurological Examination Toolbox for
Multi-Test Neurological Abnormality Detection and Documentation" (IEEE JBHI 2024), shared by the
user on 14 Nov 2026. The PDF is not stored in the repo (copyright). What we took from it:

- **Table A-II:** the names of all 75 biomarkers. These are in `config/biomarker-registry.json`
  (REG@0.2.0, `name`, `family`). The paper refers to its reference [12] for the detailed
  definitions of FT, FTF, FR and SAW, so those `formula` fields stay null.
- **Appendix B (Facial Activation):** the FA formulas are given in full, so FA1–FA18 carry a
  short formula.
  - Distances between groups of face mesh points (Eq. A-I: the root of the summed squared L2
    distances between paired points of the two groups).
  - Taken after the shared pre-processing: normalised and centred by the inner-eye-corner
    distance.
  - STD of a distance (FA1–FA5); STD of its frame-to-frame difference (speed, FA6–FA10).
  - NIQR = (P90 − P10) / P90 (FA11–FA14).
  - Pearson correlation between left and right (symmetry, FA15–FA18).
  - Mouth opening is the mean of the left and right mouth-opening distances.
- **Table A-III:** the face mesh point groups. They are the `landmarks.face` inputs of each FA
  biomarker, plus the inner eye corners 133/362:

  | Distance | Name               | κ                                 | κ′                                |
  | -------- | ------------------ | --------------------------------- | --------------------------------- |
  | d_oe^l   | Eye opening (L)    | 466, 388, 387, 386, 385, 384, 398 | 249, 390, 373, 374, 380, 381, 382 |
  | d_oe^r   | Eye opening (R)    | 7, 163, 144, 145, 153, 154, 155   | 246, 161, 160, 159, 158, 157, 173 |
  | d_ebh^l  | Eyebrow height (L) | 300, 293, 334, 296, 336           | 388, 387, 386, 385, 384           |
  | d_ebh^r  | Eyebrow height (R) | 70, 63, 105, 66, 107              | 161, 160, 159, 158, 157           |
  | d_om^l   | Mouth opening (L)  | 88, 178, 87                       | 80, 81, 82                        |
  | d_om^r   | Mouth opening (R)  | 317, 402, 318                     | 312, 311, 310                     |
  | d_mw     | Mouth width        | 78                                | 308                               |
  | d_ja     | Jaw opening        | 80, 81, 82, 13, 312, 311, 310     | 170, 140, 171, 175, 396, 369, 395 |

- **Table A-IV:** the biomarkers kept by recursive feature elimination (GBM, 3-class HC/PD/OD).
  This is for the client's model work only; the app does not use it.
  - FT: FT1–FT10.
  - FTF: FTF1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18.
  - FR: FR1, 3, 4, 5, 6, 9, 10, 11, 12.
  - SAW: SAW1–6, 8, 11, 12, 13.
  - FA: FA3, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 17, 18.
- **Table A-I:** the number of tests per record in DNE-113. 64.6 % of the 147 records have all
  five tests. When a record has 4 tests, the missing one is mostly SAW, because many subjects
  have walking difficulty. This supports our "Skip with reason" and the mixture classifier that
  tolerates missing tests.
- **Deep-learning baselines:** CNN/LSTM models train on keypoint time series cut into windows of
  100 or 200 frames. They need full-rate keypoint sequences, i.e. server keypoint extraction
  from the 60 fps video (open item in DEV_PLAN §19).

## How the registry inputs were set (readiness, not formulas)

| Test                             | Landmarks each biomarker needs                                                          | Phases              |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| FT                               | thumb and index tips (hand 4, 8) of both hands; forearms (pose 13–16, reference length) | —                   |
| FTF                              | index tips (hand 8); shoulders 11, 12 (reference); wrists 15, 16                        | —                   |
| FR                               | wrist, index and little-finger bases (hand 0, 5, 17); forearms (pose 13–16)             | —                   |
| SAW gait (step, cadence, speed)  | shoulders, hips, ankles, heels, toes (pose 11, 12, 23, 24, 27–32)                       | walk out, walk back |
| SAW knee angle symmetry (SAW6–8) | shoulders, hips, knees, ankles (pose 11, 12, 23–28)                                     | walk out, walk back |
| SAW turning time (SAW13, 14)     | as gait                                                                                 | turn                |
| FA                               | the Table A-III groups of that biomarker + inner eye corners                            | —                   |

All need ≥ 58 effective fps and the full take (14.9 s; SAW 44.9 s), with landmarks visible in
90 % of the movement window (SAW 80 %).
