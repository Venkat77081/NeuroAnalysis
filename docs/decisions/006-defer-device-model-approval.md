# 006 — Defer device-model approval (tier gating)

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M1 (affects M3, M7, M9)

## Context

DEV_PLAN §7 qualifies each phone model + Android version, ships an approved-devices list, and blocks
clinical capture on unlisted models. The product owner asked to build the rest of the app first and add
model approval at the end only if the client needs it.

## Decision

- **Deferred:** the approved-devices list, the startup tier lookup, blocking unlisted models, and the
  "qualify ≥ 3 phones" part of M1 acceptance.
- **Kept:** the Device check screen and the qualification benchmark as an engineering tool;
  `assignTier`, `config/device-tiers.json` and `tools/device_qualification` stay in the repo, unused by
  the session flow.
- **Safety net (unchanged, required):** every take is checked for effective fps and dropped frames
  against its test config (`frame_drops`, §9.2/§9.5). A phone that cannot sustain 60 fps gets RETAKE
  on that take, so inadequate data never passes silently. What is lost is only the up-front warning.
- **Until gating returns:** the session flow treats the device as allowed for all tests, but shows a
  non-blocking notice when `getCapabilities()` reports < 60 fps at 1080p on the back camera (FT, FTF, FR
  need 60 fps). Tier recorded in `meta.json` is `"A"` only from a qualification report, otherwise the
  capability-based value is noted as unqualified (to be specified in M3).

## M1 result on the first real device

OnePlus CPH2649, Android 17, Quick check (provisional): 60 fps run 59.3 fps with 1.25 % dropped
(Tier A needs < 1 %), 30 fps run 29.8 fps with 0.61 % dropped, analysis ≈ 29.7 fps, REALTIME timestamps,
AE/AF/AWB lock supported → provisional Tier B. A 10-minute run is needed to judge whether the 1.25 % is
real or start-up effect / MP4 duration rounding (open question, see assumptions A17).

## Revisit when

The client asks for approved devices, or pilot data shows frequent fps-related RETAKEs.
