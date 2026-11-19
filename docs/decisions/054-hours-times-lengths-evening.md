# 054: Clinic hours grid, time picking, test lengths, evening dark mode (v31)

- **Status:** built on branch `claude/new-ui-for-app`, not merged.
- **What the user asked for (19 Nov 2026):**
  - make clinic hours, the doctors' Team cards and moving or offering a time match the v28 mocks;
  - send the invite from Appointments in a pop-up;
  - make "Free on this day" a short card with an Open option that shows each doctor's morning
    and afternoon times;
  - move take length from platform to hospital settings, and let doctors change it per test;
  - turn the platform dark automatically in the evening;
  - give the app the same theme, shown as mocks first.

## Clinic hours and Team (canvas V28AdminSettings, V28AdminTeam)

- **Settings → Doctors' clinic hours:**
  - shows one doctor at a time, picked from a list;
  - rows are time blocks: the default blocks from `appointmentChanges.clinicBlocks`, plus any
    block a doctor already has;
  - columns are Mon–Sun, and each cell is Open or Closed;
  - clicking a block's times opens or closes it on every day;
  - opening a cell closes any block that overlaps it on that day;
  - "Add a time block" adds a new row from a start and an end time;
  - department, appointment length, "bookable in the app" and leave stay as before.

  The saved data is unchanged: per weekday, a list of spans.

- **Team:** each doctor's card shows M–S chips with the days they work, then one of:
  - "9–1, 2–5 · bookable in the app";
  - "Clinic hours not set", with a **Hours?** chip;
  - "On leave …", with a **Leave** chip.

## Picking a time (canvas V28DeskMove, V28DeskDay)

- **New endpoint:** `GET /hospital/free-days?from&to[&doctor_id][&appointment_id]` returns the
  free times per day (at most `freeDaysMaxSpan` days).
- **Doctor days:** each doctor day from `/hospital/availability` now also carries `slot_minutes`.
- **Move/offer dialog:**
  - the month calendar has green dots on days with free times for the chosen doctor;
  - a doctor list reads, for example, "Dr. Rao (same doctor) · 6 free times";
  - times are grouped under Morning and Afternoon; the split is `appointmentChanges.afternoonFrom`;
  - taken times are struck through, and times held for another patient's offer are dashed;
  - the footer has "Book it now / Offer up to N times", the reason, "tell the patient", and the
    button.
- **Free on this day (Day view and Book appointment):**
  - one row per doctor, with how many free times they have and the first one;
  - **Open** shows that doctor's day in a pop-up;
  - choosing a time opens Book appointment with the date, time and doctor filled in.
- **Book appointment:** its month calendar has the same green dots.
- **Invite from Appointments:** the join invite opens in a pop-up instead of a card under the
  list.

## Test lengths (supersedes "fixed 15 s / 45 s" in CLAUDE.md)

- **Config:**
  - `config/tests/<code>.json` gains `task.durationOptionsS`: FT, FTF, FR and FA allow 15, 20 or
    30 s; SAW allows 45, 60 or 90 s;
  - nothing shorter than the default is offered, because the biomarker registry needs at least
    14.9 s and 44.9 s;
  - a unit test checks the options against the registry.
- **Hospital Settings → Test lengths:** a hospital admin picks one length per test (stored in
  `test_durations`). Platform settings no longer show take length.
- **Doctor:** in Choose tests, each chosen test card has a length list. It starts at the
  hospital's length and applies to that request only.
- **Recording requests:**
  - each request stores `durations` (migration 0025): {test: seconds} at the time it was sent;
  - older requests use the config lengths;
  - the patient's `/patient/requests` and the clinic `/clinic/queue` return them.
- **Phones:**
  - each plan step carries `durationS`;
  - the app passes it to `startRecording`, so the native timer stops the take at that length;
  - the camera's progress bar, the session totals and `quality.json` (`durationTargetS`) use it;
  - the capture verdict compares against the recorder's requested length, which is now the
    request's.

## Evening dark mode

- **Default:** the dashboards' new default appearance is Automatic. It is dark from
  `appearance.darkFromHour` (18) until `appearance.lightFromHour` (6), on the computer's clock,
  and the page checks every minute.
- **Theme button:** the cycle is Automatic → Same as this computer → Light → Dark.
- **Stored choice:** it is kept under a new key, so every computer starts on Automatic.

## App in the Horizon+ look (canvas page v31, for approval)

- **Mock boards:** four boards: patient app, test page and camera, clinic phone, and evening.
- **What changes:** the look only (colours, cards, buttons, sunrise or moon greeting). Steps and
  the native recording stay the same.
- **Status:** the app is not changed until the user approves.

## Tests

- **Backend:** `test_test_lengths.py` (settings, doctor override, patient and clinic outputs,
  validation); `test_appointment_changes.py` (free days, slot length).
- **Dashboard unit tests (`test/v31.test.ts`):**
  - evening hours;
  - clinic grid helpers;
  - slot list and Morning/Afternoon split;
  - month cells;
  - chip times;
  - test-length options against the registry.
- **App unit tests:** `test/lengths.test.ts`.
- **Dashboard e2e:**
  - the clinic hours grid and the Team week line;
  - the move dialog's doctor list and month navigation.
