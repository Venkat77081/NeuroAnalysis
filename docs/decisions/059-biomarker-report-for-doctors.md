# 059: Biomarker report on the doctor's patient page

- **Status:** accepted. Merged into `main` and into `claude/new-ui-for-app`.
- **Asked by the user (20 Nov 2026):** "include the report in the doctor's patients page and merge
  this with main and new UI so that this report is available in both old and new UI". This lifts
  "no scoring UI" (CLAUDE.md) for this report, as asked.

## How it works

1. **Ask:** a doctor clicks **Biomarkers** on a Finger Tapping recording on the patient page.
2. **Analyse at the hospital:**
   - the dashboard calls the hospital connector (`POST /v1/takes/{id}/biomarkers`);
   - the connector checks access, decrypts the video with the hospital's take key and runs the
     analysis package (`ncbio`, decision 057) in the background;
   - only one take is analysed at a time, and the decrypted copy is deleted afterwards.
3. **Store at the hospital:** the result (values) and the report (HTML with the working) are kept
   in the connector's database (`nc_biomarker_runs`). The platform never receives the video, the
   values or the report.
4. **Wait:** the page checks every few seconds while the analysis runs. The button then reads
   **Biomarker report**.
5. **Read:** the report opens in a dialog, in a sandboxed frame. The connector serves it with a
   strict CSP: no scripts, nothing loaded from elsewhere.
6. **Activity log:** `biomarkers_requested` and `biomarker_report_viewed`.

## Rules

- **Once per take:** a take is analysed once. "Try again" appears only after a failed run, and
  runs cut short by a restart are marked failed.
- **Finger Tapping only:** the button is shown only for the tests the installed analysis package
  has a report for (FT for now).
- **Optional install:** the analysis is optional at the connector (`connector/Dockerfile.analysis`).
  Without it the card says "not installed yet" and no button is shown.
- **Decision support:** the report is labelled "Decision support, not a diagnosis". It shows
  values and how they were worked out; it gives no score or verdict.

## Tests

- **Connector:** `connector/tests/test_biomarkers.py`.
  - The decrypted video reaches the analyser and its temporary copy is deleted.
  - The report and its CSP are served; a finished run is not repeated unless asked.
  - A failed run, "not installed" and runs cut short by a restart are handled.
  - The activity log has both entries, and the platform holds nothing of it.
- **Dashboards e2e (`doctor.spec.ts`):**
  - The real analysis runs at the connector on the sample video, and the report opens.
  - The no-identity scan of the platform still passes.
