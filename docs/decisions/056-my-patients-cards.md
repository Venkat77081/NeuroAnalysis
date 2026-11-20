# 056: My patients as cards with a side panel (v33)

- **Status:** built on branch `claude/new-ui-for-app`, not merged.
- **Approval:** the user asked on 20 Nov 2026 to "make the my patients page cards like this too",
  saw canvas page v33 and asked to build it.

## What changed

- **Cards instead of a table:** the same data as before (platform NCIDs and sessions, the
  doctor's appointments, recordings from the last 4 weeks, names live from the connector).
- **Ring:** days since the last recording. The limits are in `config/platform.json`
  (`myPatients`: `ringDays` 42, `okWithinDays` 7, `warnWithinDays` 28) and in the platform config
  schema. A patient without a recording shows an empty ring and "—".
- **Order:** next visit first (the default), latest recording first, or by name. Patients without
  the date go last; ties go by name.
- **Side panel:** the patient page's first part (journey, latest session, last remark, next
  visit), read with the same calls as the patient page (`useSummary`). Watch opens the same full
  screen player and review. Add remark opens the patient page and scrolls to the timeline.
- **Open full page** keeps the test id `open-<MRN>`; the e2e tests now open the card first.

## Notes for review

- The card's "Next visit" is the doctor's own next booked visit (from `/hospital/appointments`),
  while the panel shows the patient's next booked visit with any doctor (from the history). They
  differ when another doctor sees the patient first.
- Nothing about identity is stored; names and MRNs come live from the connector as before.

## Tests

- **Unit (`test/v33.test.ts`):** days since, ring fill and colour, sorting.
- **Dashboard e2e:** 11/11; `doctor.spec` and `appointments.spec` open the card, then the full page.
