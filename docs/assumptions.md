# Assumptions

Ambiguities found during development, and what was assumed so work could continue. Review these.

| # | Milestone | Assumption | Why | Review with |
|---|---|---|---|---|
| A1 | M0 | FTF, FA durations are 15 s like FT/FR, even though the FTF protocol and FA expression sequence are still TBD. | Agreed in the mockup review: "each video recorded for 15 s"; SAW = 30 s. | Neurologist |
| A2 | M0 | SAW PASS still requires all six phases within the 30 s take; a slow patient who does not finish gets RETAKE (or "Keep this take" with a reason). | Sit-to-stand and turn biomarkers need all phases. | Neurologist |
| A3 | M0 | Unknown protocol values are the string `"TBD"` in config; the schema allows `"TBD"` only on fields listed as TBD-able (FA biomarkers, FTF/FA expression details, instruction demo videos). | DEV_PLAN M0: "unknowns marked TBD and allowed by the schema". | — |
| A4 | M0 | Skip and override reasons with value `other` require free text; enforced in the app (M3), not in the session-config schema. | The schema describes config, not operator input. | — |
| A5 | M0 | The backend targets Python 3.12 in Docker and CI; local dev here ran on Python 3.13. | DEV_PLAN §4 says 3.12. | — |
| A6 | M0 | Mock fixture `ft-r-sample` is synthetic (generated hand landmarks of a tapping motion), not a real recording. | No device recordings exist before M1/M4. Real fixtures come in M6. | — |
| A7 | M0 | FR `requiredLandmarks.pose` lists both elbows and wrists (13–16); quality-core (M5) will keep only the tested side's points. | Config is per test, not per side. | — |
| A8 | M0 | SAW and FA record at 30 fps (`targetFps: 30`, `minEffectiveFps: 29`), since they are the Tier B tests "validated at 30 fps" (§7). FT, FTF, FR record at 60 fps. | §8.2 does not give fps per test. | Neurologist / biomarker owner |
| A9 | M0 | FTF subject size 45–85% upper-body height, FR 40–80%, SAW 30–90% body height, FA 35–65% face height are first guesses; tuned in the pilot. | Only FT had a size range in §8.2. | — |
| A10 | M0 | `captureReasons` are objects `{code, messageKey, params}` instead of plain strings, so the Review screen can show them in any language. | i18n requirement (§4). | — |
