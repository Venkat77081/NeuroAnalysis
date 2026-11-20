# 061: After a move to another doctor, the first doctor may only view

- **Status:** accepted. Built on branch `claude/biomarker-analysis`.
- **Asked by the user (20 Nov 2026):** "keep access for the original doctor but the patient card
  shows it as moved, and they cannot give remarks or reviews if not already given before moving the
  appointment; the next doctor can also give remarks or reviews, saying who gave the remark, and
  that should be logged."

## Rules

- **Who becomes view-only:** a doctor whose appointment was moved to another doctor, and who has no
  other way to the patient (no upcoming appointment, no completed one of their own).
- **What view-only means:**
  - they still see the patient, the record, the recordings and reports, and every remark and review;
  - they cannot add or change a remark or review, change the home plan, or send record links (403
    `moved_view_only`, on the platform and at the connector).
- **What they see:** the patient list shows **Moved to Dr. X · view only**, and the patient page
  says why it is view-only.
- **The new doctor:** has full access, and writes their own remark on the moved appointment. The
  first doctor's remark stays and is shown next to it. Each remark and each review shows who gave
  it.
- **Activity log:** the hospital's activity log records every remark and review with its author
  (`by`): `visit_remark_written`, `visit_remark_cleared`, `take_reviewed`.

## How

- **Platform:**
  - `moved_away_clause()` and `doctor_view_only_ids()` (in `assignments.py`) find view-only
    patients;
  - `check_patient_access(view=True)` is used only where the page reads (history, appointment
    history), and every other clinical call needs full access;
  - `/connector/v1/access` returns `view_only`;
  - the connector token carries the staff member's display name (`name`).
- **Connector:**
  - remarks are one per doctor per appointment (`nc_remarks`, with the author's name); the old
    `nc_visit_remarks` rows are copied over at start-up;
  - reviews keep `reviewer_name` (a column added at start-up).
- **Tests:**
  - backend: `test_moved_to_another_doctor_leaves_the_first_doctor_view_only`;
  - connector: `test_after_a_move_the_first_doctor_only_views_and_each_remark_names_its_author`;
  - dashboards e2e: `view-only.spec.ts`.
