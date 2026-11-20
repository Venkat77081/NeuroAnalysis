# 060: Analyse each take after upload; keep the report in the hospital's cloud storage

- **Status:** built on branch `claude/biomarker-analysis`, not merged yet.
- **Asked by the user (20 Nov 2026):** "As soon as the upload successfully completed do the analysis
  and store in the cloud so when the doctor clicks, fetch the report from the cloud and show."

## Where "the cloud" is

**The hospital's own cloud storage** (its S3 bucket or Azure container), next to the take's video.
It is not NeuroCapture's servers. Decisions 023 and 027 keep biomarker results with the
hospital, and NeuroCapture never holds a readable recording or result.

- **Encrypted:** the platform can write to that storage for uploads, so the result and the report
  are encrypted with the hospital's take key, in the same way as the videos. Only the hospital's
  connector can read them.
- **File names:** they sit in the take's folder as `biomarkers-result.json.enc` and
  `biomarkers-report.html.enc`.
- **Index:** `nc_biomarker_files` in the connector's database records where they are and the
  wrapped key.
- **Development storage:** when a take is in development storage (no hospital bucket), the result
  and report stay in the connector's database, as before.

## How it runs

1. **Listing new uploads:** the platform has a new call, `GET /connector/v1/takes?since=`, listing
   the takes whose upload completed after a given time, with their NCIDs and test codes only.
2. **Checking:** the connector checks every `NCC_ANALYSIS_INTERVAL_S` seconds (60 by default; 0
   turns it off). The first check also covers the last `NCC_ANALYSIS_BACKFILL_DAYS` days (7).
3. **Analysing:** each new Finger Tapping or Forearm Roll take is decrypted, analysed in the
   background (one take at a time), then written to the hospital's storage. The decrypted video
   copy is deleted.
4. **Activity log:** a `biomarkers_computed` entry is written.
5. **Doctor's page:** the patient page shows **Analysing…**, then **Biomarker report**. Opening
   the report reads it from the hospital's storage and decrypts it at the connector
   (`biomarker_report_viewed` in the log).
6. **Older takes:** a take uploaded before the analysis was switched on still has **Biomarkers**,
   to analyse it on request (decision 059).

## Tests

- **Connector:**
  - The platform lists a new take; the connector analyses it once.
  - The report and result are in the hospital's S3 bucket (moto), encrypted, and the doctor's
    request reads them back.
  - In development storage the report stays in the database, and a take uploaded before the
    first check is covered by the backfill.
- **Dashboards e2e:** the sample take is analysed with nobody clicking, and the report opens.
