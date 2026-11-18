# 048 — Patient app: a menu for each hospital, and a calendar for dates

- **Status:** accepted (user, 18 Nov 2026: mockups "v17 · Hospital screen with a menu; calendar
  instead of date bubbles"; "1. Recommended 2. A").
- **Why:** one hospital's page had grown into one long screen (recording requests, clinic visits,
  appointments, booking, history, leaving). Dates were a long row of bubbles that was hard to
  scan.

## The hospital screen

- **Needs you now** at the top lists what is waiting:
  - a recording to make (**Start** goes straight to consent);
  - a time to choose from the hospital's offer;
  - consent to give for a clinic recording.
- **The menu** below it, with counts where something is waiting:
  - **Your appointments:** upcoming ones with their actions (ask to change, cancel, choose a new
    time). A clinic recording's consent and QR sit inside the appointment it is for.
  - **Book an appointment:** the three-step form (doctor, dates and times, check and send).
  - **Appointment history:** past and cancelled visits, newest first, filtered by All, Past or
    Cancelled. It shows dates, doctors and what happened, never notes or results.
  - **Recordings:** what is still to record, then what was sent.
  - **Hospital details:** about the data, and **Leave this hospital** (moved off the main
    screen).
- Coming back to the menu fetches its data again, so its counts follow what was done in a
  section.
- Tabs were considered and not chosen (user).

## Picking dates (option A)

- A month calendar, Monday first:
  - days with free times have a green dot;
  - full, closed and out-of-range days are grey;
  - chosen days are labelled PREF or ALT.
- A Preferred / Alternatives switch shows how many of each are chosen. The hospital's settings
  still set how many dates and times there are.
- Tapping a day shows its free times as a grid, split into morning and afternoon, with
  **Remove this date**. A list below sums up the dates and times chosen.
- It is used for **Book an appointment** and **Ask to change**. The desk's offers stay a short
  list.
- **Platform:**
  - `GET /patient/free-days?from&to[&doctor_id][&appointment_id]` returns the number of free
    times per day. It follows the same rules as `/patient/free-times` and covers at most
    `appointmentChanges.freeDaysMaxSpan` days (62).
  - `GET /patient/appointments/history` returns up to `patientHistoryMax` (50) past or cancelled
    appointments.
- **Offline:** every day in range stays tappable, and the chosen day's times show the network
  error.
