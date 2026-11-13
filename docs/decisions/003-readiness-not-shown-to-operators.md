# 003 — Biomarker readiness is not shown to operators; override is "Keep this take"

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M0 (affects M3, M7, M8)

## Decision

1. The Review screen shows only the capture verdict. Readiness failures a retake can fix become plain RETAKE reasons; the rest stays in `quality.json` for reviewers.
2. Overriding a RETAKE is "Keep this take…": failure reasons repeated, reason required (free text for `other`), confirm "Keep and flag for review". The take gets `flaggedForReview: true` and shows as "Kept · flagged".

## Why

Biomarker names next to a patient look like results (scope: no diagnostic output). Operators can act only on "retake because X". A two-step, flagged override discourages overriding without reading the reasons while still allowing it in real clinical situations.
