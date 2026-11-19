# 051 — Dashboard look "Horizon+" (v28)

- **Status:** built on branch `claude/new-ui-for-app`, not merged (user, 19 Nov 2026: "Build v28
  and push to the new UI branch"). Mockups: canvas page v28 (and v27 before it).

## What changed

- **Theme:**
  - indigo and violet for actions, coral for "now", larger type, rounded 24 px cards with soft
    shadows;
  - every colour is a token in `src/index.css`, and the pages no longer contain hex colours;
  - status chips show darker text on a soft colour, and each has an icon drawn by CSS
    (✓ ◷ ! •). The icon is not part of the text, so a chip is never colour alone and tests that
    read the words do not change.
- **Dark mode:**
  - it has its own colours, not an inverted page, and follows the computer by default;
  - the round button in the top bar cycles "same as this computer → light → dark"
    (remembered on this computer: `nc.dash.theme`).
- **Top bar:**
  - a floating bar replaces the sidebar. It holds the logo and hospital name, pill tabs
    (red counts for appointment requests and tests to choose), search, the theme button, the
    person's name and role, and Sign out;
  - on narrow windows the tabs scroll sideways.
- **⌘K search** (also Ctrl+K and the search button):
  - finds pages and actions from this person's own menu;
  - for people with `patients.search`, it also finds patients live in the hospital's records
    (connector `/v1/patients`, 5 results, nothing stored);
  - choosing a patient opens the profile for a doctor, and otherwise the invite page with the MRN
    already searched.
- **Sunrise greeting:**
  - Overview opens with the same time-of-day card as the phone app (decision 050): morning or
    afternoon sun, evening moon. It shows the person's first name, a summary line, the first
    three tiles as chips and, for desk and doctor, the next appointment;
  - the sign-in page puts the same sunrise on its left.
- **Appointments:**
  - **List, Day, Week** switch (remembered: `nc.appointments.view`);
  - **Day** shows the doctors side by side, and **Week** runs Monday to Sunday, coloured by
    doctor. Cancelled appointments are striped and crossed out;
  - times are in the hospital's time zone. An appointment is drawn as 30 minutes because the
    platform keeps no end time;
  - clicking one opens its history, and from there it can be moved;
  - the calendar loads the last 30 and the next 60 days (two calls), so it has no range picker;
  - a coral **Now** line runs through today, in the calendar and in the list (between the
    appointments already past and those still to come);
  - "Did not come" is still offered from the appointment time (decision 049);
  - the "Add an appointment" form now sits under the list.
- **Hospitals (platform):**
  - cards replace the table, with filter chips (All, Needs you, Suspended);
  - Set-up opens a **side panel** with the steps, the hospital admins, Suspend or Resume, and
    Roles and permissions.
- **Data connections:**
  - a picture of how data flows sits at the top of the page. "Inside your hospital" holds the
    records and the connector. NeuroCapture holds patient codes, schedules and counts. Phones
    send encrypted video to the hospital's own storage;
  - each part shows its live state from the existing connector, keys and storage endpoints.
- **Connector offline:**
  - when the browser cannot reach the connector, a note under the top bar says that names are
    hidden until it answers again;
  - pages then show patient codes (NCIDs), as they already did when a name lookup failed;
  - the API layer keeps this state (`connectorReachable`, `onConnectorReach`).
- **Doctor:**
  - patient rows have avatars (colour fixed by name);
  - the patient page has a profile header with the MRN line and "Live from your records".
- **Motion:**
  - cards fade up, the sun rises, the Now dot pulses, and dots flow along the data
    connections;
  - all of it stops with "reduce motion".

## Not built from the v28 mock

These need data the platform does not have:

- the 24-hour connector history strip;
- clinic-phone QR registration (phones keep their registration code);
- the "Undo" toast;
- the bell.

## Tests

- Unit tests (`test/v28.test.ts`) cover:
  - parts of the day;
  - avatar colour;
  - theme cycling;
  - greeting chips and the next appointment;
  - where the Now line goes;
  - calendar lanes, hour range, pixel offsets, weeks and doctor columns.
- One e2e test changed: the platform admin closes the new side panel before onboarding the next
  hospital.
