# 013 — Capture protocol follows the DNE dataset (both hands, seated, front view)

- **Status:** accepted (user, 14 Nov 2026)
- **Date:** 2026-11-14
- **Milestone:** M4 (affects configs used from M3 on)

## Context

The first protocol (DEV_PLAN v3.1) filmed FT and FR one hand at a time, FTF as an
examiner-finger task, and SAW for 30 s. The user pointed to the DNE-113 dataset paper
(IEEE Xplore, "DNE protocol") as the way the client wants takes captured:

- **FT:** both hands raised; touch thumb and index finger of each hand together and tap as big
  and fast as possible, 15 s.
- **FTF:** point both index fingers to the ceiling, then touch the fingertips together in front
  of the chest, repeatedly, 15 s.
- **FR:** gently clench the hands, hold the forearms horizontally and roll the hands around each
  other as fast as possible, 15 s.
- **SAW:** stand up from a chair and walk back and forth 15 ft, 45 s.
- **FA:** head still; eyebrows up, big smile, relax; then the same again.

The paper's figure shows the patient seated, facing the camera, upper body and both hands in
view for FT, FTF and FR; side view for SAW; face close-up for FA.

## Decision

- Session order: **FT, FTF, FR, SAW, FA**, one take each, none sided (`SESSION@2.0.0`).
- FT, FTF, FR: front-centred, seated, landscape, 1.5–2 m, chest height; trackers hand + pose;
  both hands and upper-body pose points required; guides `upper_body_hands_up` (FT, FTF) and
  `upper_body_forearms` (FR). Still 60 fps target with the interim 30 fps floor (decision 007).
- SAW: **45 s** (replaces 30 s from decision 002), walkway **4.6 m (15 ft)**, turn mark on the
  floor, camera 4–5 m side-on.
- FA: unchanged camera; steps follow the eyebrows / smile / relax ×2 sequence.
- The earlier per-hand protocol (FT and FR per hand with a one-arm guide, side-on
  examiner-finger FTF per hand, SAW 30 s) is kept on branch
  **`claude/variant-per-hand-protocol`** for other clients. Both use the same code; only
  `config/`, i18n texts and guides differ.

## Consequences

- Detectors (M6) must handle two hands in one take: per-hand tap/rotation counts, labelled by
  `sideFromLabel` (decision 012). Biomarkers are computed per hand from the same take.
- `saw_phases` must accept repeated walk-turn cycles within 45 s, not a single out-and-back.
- Takes recorded with the old configs keep their `configVersion` in meta.json, so mixed data
  sets can be told apart.
