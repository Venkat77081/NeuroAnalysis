# 053 — Dashboards rebuilt to match canvas v28 (v30)

- **Status:** built on branch `claude/new-ui-for-app`, not merged. The user asked for this on
  19 Nov 2026:
  - "ui you built doesnt match with these mock ups"
  - "for onboard hospital on clicking that pop screen"
  - "in front desk under appointments i want book appointment seperately and appointments
    sepereately"
  - "the search option doesnt work as shown in the mock"
  - "make all pages match exactly with v28 version"

## Front desk

- **Pages:** Today, Appointments, Book appointment, Requests, Invite patients. Book appointment
  and Requests are now pages of their own. The red count is on Requests.
- **Today:**
  - the sunrise greeting with the next patient, in the hospital's time zone like the list below
    it;
  - today's appointments in time order, with a doctor filter and the coral Now line;
  - each row has a status and one action:
    - "Did not come" from the appointment time, with the status "Not recorded · 1 h 49 min late"
      (minutes alone under an hour);
    - a locked "Did not come · 11:15" on the next one;
    - Choose doctor;
    - Open, for the history;
  - a Requests card (Check, or Seen for cancellations) and quick actions.
- **Appointments:**
  - the title is the date or week;
  - "+ Add" opens Book appointment;
  - an "All doctors" filter;
  - the Day view has the month and the free times on that day next to it, from the doctors'
    clinic hours.
- **Book appointment:** the form, with the month and that day's free times beside it. Choosing a
  free time fills in the date, time and doctor.
- **Requests:** an inbox on the left. The chosen request is shown on the right with its times
  checked now, Book, "Offer other times" and "Can't change".
- **Invite:** search the records on the left, choose who to send to and how, and see an example
  of the message on a phone on the right. The example is labelled as one; the real wording comes
  from the hospital's message settings.
- **"Did not come":**
  - shows "X did not come?", the time with the doctor and how late;
  - a "This will" list: cancel, tell the doctor, and send the patient a message (switchable);
  - buttons "Yes, did not come" and "Not yet".
- **Search (⌘K):**
  - patients show their MRN and next visit ("next Sat 21 Nov 09:00 · Dr. Rao");
  - actions "Book an appointment for X" (⌘B) and "Invite X to the app" (⌘I), the latter for
    patients not using the app;
  - choosing a patient opens the booking form with them filled in.

## Doctor

- **Today:** the greeting with the next patient. "Your clinic today" (or tomorrow) has Watch,
  Choose and Open, and there is a New recordings card.
- **Patients:** a table with next visit, last recording and status (needs tests, new recording,
  kept · flagged, visit today, new patient, up to date), plus filter chips.
- **Patient page:**
  - header buttons Choose tests, Add remark and Watch;
  - cards for the journey (last points and the next visit), the latest recordings, the last
    remark and the next visit;
  - the full history, recordings and plan follow below.
- **Watching a recording:**
  - full screen on dark: the session's takes on the right, 0.25×/0.5×/1× speed and frame steps;
  - the review form;
  - "No scores here".
- **Choose tests:**
  - steps (Patient, Tests, Where and when, Send);
  - one card per test with its length from `config/tests`;
  - a summary bar ("4 tests · about 7 min · every test records at 60 fps").

## Hospital admin and platform

- **Overviews:**
  - platform: chart and tiles on the left; "Needs you" and "What's happening" (latest log rows)
    on the right;
  - hospital admin: tiles, a set-up ring with its checks, and "Today at your hospital".
- **Hospitals:**
  - filter chips All, Needs you, Onboarding and Live;
  - "+ Onboard a hospital" opens a pop-up with the steps (the hospital's admin does the last
    three);
  - each card shows a set-up ring and Connector, Storage and Messages chips;
  - the side panel shows:
    - "Connector offline · 2 h 28 min" when it is;
    - the 24-hour strip;
    - Connector, Video storage, Messages and Clinic phones;
    - E-mail the hospital admin and Open their activity;
    - the set-up steps, Roles and permissions, and Suspend.

  The hospital list now returns set-up steps done, storage kind, e-mail/SMS state and the first
  admin's e-mail.

- **Team:** people as cards with role chips. Inviting staff and adding an operator happen in
  pop-ups; the operator pop-up says they sign in on the clinic phones with a temporary password.
- **Phones:** device cards (camera check fps, use in the last 30 days, Remove) next to the
  "Register a phone" QR card.
- **Settings:**
  - both settings pages have a menu of sections on the left;
  - clinic hours moved from Team to the hospital's Settings;
  - platform settings show the platform's rules (pass level, 60 fps, take length, consent
    version, two-step, invite and PIN limits) from `config/platform.json`.
- **Activity (both):** kind chips and Export CSV, with rows grouped by day (Today, Yesterday, date)
  under an icon and colour that match their wording.
- **Sign-in:**
  - the page says "Use the e-mail your hospital invited." and the button reads "Continue";
  - "Forgot password?" explains who resets a sign-in;
  - the code step is "Enter your code" with large digits and a link back to the e-mail.

- **Pop-ups** fit their content instead of filling the screen height; the hospital side panel
  stays full height.

## Kept on purpose

- The appointment list (table) is unchanged; v28 drew only the Day and Week views.
- Clinic hours keep their text fields per weekday, because hours are free spans (for example
  09:00-13:00, 14:00-17:00). The v28 mock showed only two fixed blocks.

## Tests

- **Unit tests:** `test/v30.test.ts` covers:
  - Today statuses and "Did not come";
  - next visits and "not in the app";
  - hospital card state;
  - the patient journey;
  - activity grouping and tone;
  - the doctor's rows;
  - patient states;
  - take lengths.
- **Backend:** the hospital list carries the card details.
- **e2e:** updated for the new pages:
  - Book appointment and Requests in the menu;
  - the onboarding pop-up;
  - the hospital side panel;
  - operators added in a pop-up;
  - clinic hours on Settings;
  - "Today" for the desk and the doctor.
