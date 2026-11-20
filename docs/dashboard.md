# Web dashboards — deploy and run (M14)

One web app for platform admins, hospital admins and doctors (`apps/dashboard`).

## Build and deploy

```bash
pnpm --filter @neurocapture/dashboard build     # → apps/dashboard/dist (static files)
```

1. Serve `dist/` from any static host (nginx, S3 + CloudFront, the API's reverse proxy) with an
   SPA fallback to `index.html`. Staff invite links are `<dashboard>/invite?t=…`.
2. Point the dashboard at the API: edit `dist/config.json` → `{ "apiUrl": "https://api.example.in" }`.
3. On the API, set `NC_CORS_ORIGINS` to the dashboard's origin and `NC_DASHBOARD_URL` to its
   address (used in invite e-mails).
4. On each hospital connector, set `NCC_CORS_ORIGINS` to the same dashboard origin.

## How data flows

- **The platform API** gives the dashboard accounts, phones, NCIDs, sessions, plans and
  pass/fail health, and never patient identity.
- **The hospital connector** is called by the browser directly, with a 10-minute connector token
  from the platform. It serves names, MRNs, live history, decrypted recordings, reviews (notes
  stay at the hospital), invites and the clinical activity log. Doctors therefore need network
  access to their hospital's connector (hospital network, VPN or a hospital-controlled HTTPS
  address).
- **Tokens:** the access token is held in memory only. The refresh token is kept in the tab's
  `sessionStorage`, so closing the tab signs out. Decrypted videos exist only as in-memory blob
  URLs while they are open.

## Who sees what (decisions 031, 033)

The lists below are the defaults. A platform admin can change them for one hospital under
Hospitals → Roles and permissions.

- **Hospital admin:** set-up only (overview, data connections, team, phones, activity).
- **Front desk (receptionist):** appointments, join invites (e-mail, SMS or printed QR) and
  the doctor of each appointment (decision 038; there is no separate "Assign patients" page).
  A doctor sees a patient with a booked appointment with them today or later, or a completed one
  (decision 040). The doctor's patient page has a past-appointments period and visit remarks,
  stored at the connector.
- **Doctor:** choose tests, my patients (history, recordings, reviews, plan).

## Doctors and access (decision 038)

- **Each appointment has its own doctor.** A patient can see Dr. Rao one day and Dr. Iyer another.
- **A doctor sees a patient** (history and all recordings) once they have an appointment with
  them, or have sent them a recording request.
- **Appointments has a date range:** next 7, 30 or 60 days, or the past 30 days.

## Staff sign-in reset (decision 039)

- **Team → Reset sign-in** (hospital admin) and **Hospitals → Set-up → Hospital admins**
  (platform admin).
- The person is signed out everywhere and gets a link (24 hours) to choose a new password and set
  up the authenticator again.

## Appointments and record links (v3, decision 030)

- **Reception → Appointments** lists the next 7 days. Appointments are added by hand (decision
  034); nothing is read from the hospital's appointment system. Reception chooses the doctor of each appointment and sends join
  invites to patients who have not joined the app.
- **Doctor → Choose tests** lists the appointments waiting for that doctor. The doctor chooses the
  tests, the medicine state, the record-by date and, if wanted, "repeat every N days", then sends
  the record link. The patient gets nothing before that.
- **Doctor → patient page → Appointments and record links** shows each appointment, the links sent
  for it and what was recorded.

## Appointment changes and hospital settings (v13, decision 045)

- **Front desk:**
  - Every appointment has "Change date or doctor": a calendar, then each doctor's free times
    (clinic hours minus their booked appointments, in the hospital's time zone), a reason and
    "tell the patient".
  - Patients' requests from the app are in Appointments → **Change requests**, with a count in
    the menu. "Choose new date" opens the same panel, on the patient's first chosen day. "None of
    these dates work" answers "Please call us" or "Keep the booked date".
- **Hospital admin:**
  - **Settings:** the phones' camera-check pass level (55–59 fps), whether patients may ask to
    change appointments, until how many hours before, and the hospital's time zone.
  - **Team → Doctors' clinic hours:** weekly hours, appointment length and leave for each doctor.

## Offers, cancellations and booking from the app (v14, decision 046)

- **Front desk:**
  - "Change date or doctor" has two modes: **Move it now**, or **Offer choices**. Offer choices
    sends up to 3 held times (date, time, doctor) for the patient to choose in the app.
  - **Cancel…** on every appointment asks for a reason.
  - **Requests tab:** new bookings and change requests (each time checked now: free, taken,
    doctor on leave), offers waiting or without an answer (or "asked to be called"), and
    appointments the patient cancelled.
- **Doctor:** after a move to them before the patient recorded, "Choose tests" shows the earlier
  tests to confirm.
- **Hospital admin → Settings:** booking from the app (dates, times, how far ahead), choices
  offered and the reply time, and how long a recording counts after a move. Team → clinic hours:
  "Bookable in the app" for each doctor.

## Consent for clinic recordings (v16, decision 047)

- **Hospital admin → Settings → Consent for clinic recordings:** whether patients without the app
  may agree on the clinic phone (on by default).
- **Doctor → patient timeline:** each clinic recording shows how consent was given: in the app
  (QR scanned) or on the clinic phone, with the reason.
- **Activity:** consent given, checked by the clinic phone, and withdrawn.

## Did not come (v18, decision 049)

- **Front desk:** "Did not come…" on a booked appointment once its time has passed. It cancels
  the appointment, tells the patient (optional, on by default) and e-mails the doctor (NCID and
  time only).
- **Desk and doctor:** the appointment shows "Did not come".

## Dialogs on the front desk (v15)

History, Change date or doctor (move or offer), Check times (Requests) and Cancel open as dialogs
over the appointment list instead of expanding a row:

- Close with ✕, Esc or a click outside; with times or a reason already chosen, the dialog asks
  "Discard what you chose?" first.
- Focus stays in the dialog and returns to the button that opened it.
- The buttons at the bottom stay visible while the dialog scrolls; on a narrow window it fills the
  screen.

## Look and navigation (v28 "Horizon+", decision 051)

- **Top bar:** a floating bar instead of the sidebar, with pill tabs and red counts.
- **Search:** ⌘K or Ctrl+K finds pages, actions and, for people allowed to search, patients live
  in the hospital's records.
- **Theme:** the round button switches between "same as this computer", light and dark.
- **Overview:** opens with a sunrise greeting by time of day.
- **Appointments:**
  - a List, Day or Week switch. Day shows the doctors side by side, and Week runs Monday to
    Sunday;
  - a coral Now line;
  - clicking an appointment opens its history.
- **Hospitals (platform):** cards with a set-up side panel.
- **Data connections:** starts with a picture of how data flows, with the live state of each part.
- **Connector offline:** when the connector cannot be reached, a note says that names are hidden
  and patient codes are shown instead.
- **Motion:** all of it stops with "reduce motion".
- **Connector history (v29, decision 052):** the platform's hospital side panel and Data
  connections show the connector's last 24 hours, one bar per hour, and "Online" or "Offline since".
- **Undo (v29):** booking, moving, offering, declining, cancelling and "Did not come" wait a few
  seconds with an Undo toast before anything is sent (`appointmentChanges.undoSeconds`).
- **Bell (v29):** what needs you now, with a dot for anything new since you last opened it.
- **Phones (v29):** the registration QR is scanned on the new clinic phone ("Scan the QR code").

## Pages as drawn in canvas v28 (v30, decision 053)

- **Front desk:**
  - pages are **Today**, **Appointments**, **Book appointment**, **Requests** (red count) and
    **Invite patients**;
  - Today lists the day's patients in time order with one action each: "Did not come" from the
    appointment time, Choose doctor, or Open;
  - ⌘K finds a patient with their MRN and next visit, then offers "Book an appointment for X" (⌘B)
    and "Invite X to the app" (⌘I).
- **Doctor:**
  - **Today** has "Your clinic today" and New recordings;
  - **My patients** has status chips (cards since v33, below);
  - the patient page starts with the journey, the latest recordings, the last remark and the next
    visit;
  - recordings play full screen with speeds, frame steps and the review.
- **Platform:**
  - **Hospitals** has filter chips and a set-up ring on each card;
  - "+ Onboard a hospital" opens a pop-up;
  - the side panel shows the connector, storage, messages and phones.
- **Hospital admin:**
  - Team and Phones are cards; adding an operator and inviting staff happen in pop-ups;
  - clinic hours are on **Settings**.
- **Both settings pages and Activity:** settings pages have a section menu. Activity is grouped by
  day, with kind chips and Export CSV.

## Hours, times, test lengths, evening (v31, decision 054)

- **Clinic hours** (Settings): one doctor at a time, an Open/Closed grid of time blocks by
  weekday. Team cards show each doctor's week (M–S) and hours.
- **Picking a time:** the move/offer dialog, "Free on this day" and Book appointment share one
  month calendar with green dots on days with free times (`GET /hospital/free-days`). A doctor's
  day shows as Morning / Afternoon chips, with taken times struck through.
- **Invite from Appointments** opens in a pop-up.
- **Test lengths:**
  - Settings → Test lengths sets each test's length (options from `config/tests`, never shorter
    than the default);
  - a doctor may change a test's length when choosing tests;
  - the request carries the lengths to the phone.
- **Appearance:** Automatic (the default) is dark from 18:00 to 06:00 (`config/platform.json`
  `appearance`).

## Local run

```bash
pnpm --filter @neurocapture/dashboard dev         # http://localhost:5174, API at public/config.json
pnpm e2e:dashboard                                # real platform + connector + FHIR stand-in, then the identity scan
```

## Overview (v10, decision 042)

Every role starts on **Overview**: five cards, one chart (hover for values, **Table** for the numbers) and a short list. The platform admin's page holds counts and hospital names only. The hospital admin's **Data connections** page has **Messages to patients: e-mail and SMS**, saved at the hospital connector (encrypted), with "Send a test".

## Choose tests as cards (v32, canvas page v32)

The doctor's **Choose tests** page works like the platform's Hospitals page:

- filter chips (All, This week, Moved to you, Not in the app) and a visit-date order;
- one card per appointment waiting for tests, with a ring counting the days to the visit and
  chips for the patient's state;
- a card opens a side panel with the tests as tick rows (each with its length, never shorter than
  the default), where to record (Home / Clinic / Both), medicine state, record-by date,
  **Repeat at home** every N days, the medical history and **Send**.

## My patients as cards (v33, canvas page v33, decision 056)

The doctor's **My patients** page works like Choose tests:

- filter chips (All, New recordings, Needs tests, Flagged, Visit today) and an order (next visit,
  latest recording, name);
- one card per patient with the name and MRN, a status chip, the next visit and the last
  recording, and a ring for the days since the last recording (full right after one, empty at
  `myPatients.ringDays`; green, amber and red limits in `config/platform.json`);
- a card opens a side panel with the journey, the latest recordings (they play full screen), the
  last remark and the next visit, and buttons for **Watch**, **Add remark** (opens the patient page
  at the timeline), **Choose tests** and **Open full page**.

## Biomarker report (M15, decision 059)

- **Doctor's patient page:** each Finger Tapping recording has **Biomarkers**. It is analysed at
  the hospital's connector in about a minute; the button then opens the **Biomarker report** (each
  value and how it was worked out) in a dialog.
- **Where it is kept:** the report stays in the hospital's database; the platform never receives
  it.
- **Not installed:** without the analysis at the connector, the patient page says so and shows no
  button.

## Reports without a click (decision 060)

- **After upload:** Finger Tapping and Forearm Roll recordings are analysed at the hospital's
  connector soon after they upload. The patient page then shows **Analysing…** and **Biomarker
  report**.
- **Where the report is kept:** encrypted in the hospital's own cloud storage, next to the video.
- **Older recordings:** they keep the **Biomarkers** button.
