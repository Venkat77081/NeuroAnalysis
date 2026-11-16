# Testing NeuroCapture now — app and dashboards

You do **not** need any real credentials: no hospital database, e-mail or SMS account, cloud bucket
or key manager. Everything has a stand-in. There are three levels; start with 1 and 2.

| Level                        | What runs                                                                                          | What you need                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1. App in the browser        | The phone app with a built-in fake server and fake camera                                          | Node + pnpm                                                  |
| 2. Dashboards + real servers | Real platform API, real hospital connector, a FHIR stand-in with two test patients, the dashboards | Node + pnpm, Python 3.12                                     |
| 3. Real phone                | The debug APK on an Android phone, talking to level 2 over your Wi-Fi                              | An Android phone (60 fps camera), same Wi-Fi as the computer |

## Pick a path

| You want to test    | No server at all                                                                                          | Your computer as the server (no cloud, no real accounts)          |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Dashboards          | **Not possible**: the dashboards have no offline mode; use the right-hand column                          | Path D                                                            |
| App on the computer | Path A (built-in fake server, fake camera)                                                                | Not possible: browser modes only talk to the built-in fake server |
| App on a phone      | Path B (phone's browser, fake server) or Path C (installed APK, camera tools only after sign-in: limited) | Path E                                                            |
| Everything together | —                                                                                                         | Path F                                                            |

### Path A — app alone, in the computer's browser (no server)

This is level 1 below:

```bash
pnpm --filter @neurocapture/mobile dev        # open the printed address, e.g. http://localhost:5173
```

Sign-ins are built in. Clinic: server `fake://api`, code `DEMO-SITE-1`, operator `OP-NEW` /
`temp-pass-1234`. Patient: get an invite link from the console (level 1 below).

Useful address flags (add them to the URL):

| Flag                | Effect                                                  |
| ------------------- | ------------------------------------------------------- |
| `?benchFps=48`      | The camera check fails                                  |
| `?benchFps=57`      | The camera check is borderline                          |
| `?scenario=too_far` | Positioning prompts (also `one_hand`, `dark`, `tilted`) |
| `?mockSpeed=20`     | Takes run 20 times faster                               |

### Path B — app on a phone, in the phone's browser (no server)

The app runs with its fake server and fake camera, served from your computer.

1. On the computer:

   ```bash
   pnpm --filter @neurocapture/mobile dev --host     # prints a Network address, e.g. http://192.168.1.20:5173
   ```

2. The app needs a secure page (`https` or `localhost`) for its checksums. Pick one:
   - **USB (simplest when it works):** turn on USB debugging on the phone, connect it, run
     `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` in Chrome on the phone.
   - **Wi-Fi:** in Chrome on the phone, open `chrome://flags`, find _Insecure origins treated as
     secure_, add `http://192.168.1.20:5173`, enable it and relaunch Chrome. Then open that
     address.
3. Use the same sign-ins and flags as in path A.

### Path C — the installed app (APK) with no server: test mode

Install the debug APK ("app-debug-apk" from the CI run of the latest commit on `main`). Then:

1. On the first screen ("How will this phone be used?"), press and hold the logo for about one
   second. The menu opens.
2. Tick **Test mode** and confirm. The app wipes its data and restarts with a purple "Test mode"
   banner. Nothing is sent anywhere; recordings stay on the phone.
3. **Clinic phone:** choose Clinic phone → **Use the test hospital** → camera check → set a
   password. Open the **Test** tab on the right edge: add queue patients or send a clinic
   recording notice.
4. **Patient:** choose Patient app → **Join the test hospital** → choose a PIN. In the Test tab,
   send record links, then record them.
5. **Camera frame-rate check:** the same menu, any time. It records and sends nothing.
6. To leave test mode, untick it in the menu (the app's data is wiped again).

### Path D — dashboards against your computer (no cloud, no real accounts)

This is level 2 below:

```bash
.venv/bin/python apps/dashboard/e2e/stack/run_stack.py --dir /tmp/nc-stack     # Windows: python apps\dashboard\e2e\stack\run_stack.py --dir C:\nc-stack
pnpm dev:dashboard                                                            # http://localhost:5174
```

- **What runs:** your computer runs the real platform (8001), a real hospital connector (8101)
  and a stand-in hospital record system (8180).
- **What the stack prints:** every sign-in, with password `correct-horse-42`.
- **Two-step codes:** `.venv/bin/python apps/dashboard/e2e/stack/codes.py /tmp/nc-stack/stack.json`.
- **Invites:** print them (QR on screen). E-mail and SMS go nowhere unless you add the mail
  catcher below.

### Path E — phone app against your computer

1. Find your computer's Wi-Fi address (Windows: `ipconfig` → IPv4 Address; Mac: System
   Settings → Wi-Fi → Details), e.g. `192.168.1.20`.
2. Start the stack with it, and the dashboards:

   ```bash
   .venv/bin/python apps/dashboard/e2e/stack/run_stack.py --dir /tmp/nc-stack --lan 192.168.1.20
   pnpm dev:dashboard
   ```

3. Install a **debug** APK built after 16 Nov 2026. Debug builds may use `http://` on your Wi-Fi;
   release builds refuse it.
4. Follow level 3 below: a clinic phone (registration code from the dashboard) and a patient
   (printed QR from "Invite patients"). The server address on the phone is
   `http://192.168.1.20:8001`.
5. Allow Python through the firewall on private networks if asked. The phone and the computer
   must be on the same Wi-Fi.

### Path F — everything together

Run path D and path E at the same time:

1. A **clinic phone** records a patient from the clinic queue.
2. A **patient phone** joins with a printed QR and records at home after the doctor sends a
   record link.
3. The **doctor** watches both recordings in the dashboard, decrypted by the local connector.

Optional extras, still with no real accounts:

- **See the e-mails (mail catcher).** Start it in its own terminal, and set these **before**
  starting the stack. Staff and patient invite e-mails then print in the catcher's window.

  ```bash
  python3 -m venv /tmp/mailcatcher && /tmp/mailcatcher/bin/pip install aiosmtpd==1.4.6
  /tmp/mailcatcher/bin/python -m aiosmtpd -n -l 127.0.0.1:1025
  ```

  ```bash
  export NC_EMAIL_PROVIDER=smtp NC_SMTP_HOST=127.0.0.1 NC_SMTP_PORT=1025 NC_SMTP_SECURITY=none NC_MAIL_FROM=no-reply@neurocapture.local
  export NCC_EMAIL_PROVIDER=smtp NCC_SMTP_HOST=127.0.0.1 NCC_SMTP_PORT=1025 NCC_SMTP_SECURITY=none NCC_MAIL_FROM=clinic@neurocapture.local
  ```

  On Windows, use `set NAME=value` for each setting in the same Command Prompt.

- **Test Azure Blob storage locally (Azurite emulator).**

  ```bash
  npx --yes azurite@3.35.0 azurite-blob --location /tmp/azurite --skipApiVersionCheck --loose
  ```

  ```bash
  cd backend && .venv/bin/pytest -q tests/test_azure_storage.py
  cd connector && .venv/bin/pytest -q tests/test_m12_keys_storage.py
  ```

  Phones on Wi-Fi cannot use it as recording storage: Azurite serves plain `http` on your
  computer only.

## Set-up (once)

```bash
pnpm install
python3 -m venv .venv && .venv/bin/pip install -e "backend[dev]" -e "connector[dev]"
```

**On Windows** (Command Prompt): create the venv with `python -m venv .venv`, activate it with
`.venv\Scripts\activate`, then use `python` wherever this guide says `.venv/bin/python`. Write
paths with `\` and use a folder such as `C:\nc-stack` instead of `/tmp/nc-stack`. For example:

```bash
python apps\dashboard\e2e\stack\run_stack.py --dir C:\nc-stack --lan 192.168.1.20
```

For `--lan`, use the **IPv4 Address** under "Wireless LAN adapter Wi-Fi" in `ipconfig` (not the
Default Gateway). If Windows Firewall asks about Python, allow it on private networks.

## Level 1 — app in the browser (mock mode)

```bash
pnpm --filter @neurocapture/mobile dev        # open the printed address, ideally in phone-size view (F12 → device toolbar)
```

- **Clinic phone:**
  - choose "This is a clinic phone";
  - server `fake://api`, code `DEMO-SITE-1`;
  - operator `OP-NEW`, temporary password `temp-pass-1234`, then choose a new password;
  - or `OP-07` / `2468`.
- **Patient:** choose "I am a patient", then tap the **Test** tab on the right edge → **Patient
  invite**. The join screen opens with the invite. (Or, in the browser console:
  `__ncMock.fakeServer.issueInvite()`.)
- **Test tab** (fake mode only): plays the hospital.
  - **Patient invite**.
  - **Doctor sends a home record link**.
  - **Doctor adds a patient to today's clinic queue**: then tap Refresh on the queue.
  - **Start again**.
- **Clinic phones show only the queue:** there is no "New patient"; use the Test tab to add one.
- **The fake server lives in the page:** reloading forgets registered phones and new passwords,
  and sign-in then fails. Use **Start again**.
- **Start again:** clear the site's storage (F12 → Application → Clear storage), then reload.
- The camera is simulated, so every take passes. Add `?scenario=too_far` (or `one_hand`, `dark`,
  `tilted`) to the address to see the guidance prompts.

## Level 2 — dashboards against real servers

```bash
.venv/bin/python apps/dashboard/e2e/stack/run_stack.py --dir /tmp/nc-stack   # leave running; prints every sign-in
pnpm dev:dashboard                                                          # http://localhost:5174
```

- **Sign-in:** every account uses the password printed by the stack (`correct-horse-42`).
- **Two-step codes:** add the printed key to Google Authenticator or Microsoft Authenticator
  ("enter a set-up key", time-based), or print the current codes with:

  ```bash
  .venv/bin/python apps/dashboard/e2e/stack/codes.py /tmp/nc-stack/stack.json
  ```

- **Patients in the stand-in records:**
  - Asha Testpatient, MRN 00012388 (has one uploaded home recording);
  - Ravi Samplename, MRN 00012401 (no e-mail on file).
- **Start again:** stop the stack (Ctrl+C) and run it again; it starts empty each time.

## Level 3 — a real phone

1. Find your computer's Wi-Fi address (for example `192.168.1.20`), then:

   ```bash
   .venv/bin/python apps/dashboard/e2e/stack/run_stack.py --dir /tmp/nc-stack --lan 192.168.1.20
   ```

2. Install the debug APK from CI ("app-debug-apk" artifact, built after 16 Nov 2026). Debug builds
   allow `http://` on your Wi-Fi (release builds do not).
3. **Clinic phone:**
   - in the dashboard, as hospital admin, go to Phones → New registration code;
   - on the phone, choose clinic, server `http://192.168.1.20:8001`, enter the code;
   - in the dashboard, Team → Add operator; the temporary password is shown once.
4. **Patient phone:**
   - in the dashboard, as receptionist, go to Invite patients → search "asha" → tick → Print → Send;
   - on the phone, choose patient → Scan the QR code. Change the server address on that screen to
     `http://192.168.1.20:8001` first.
5. **Allow Wi-Fi uploads:** uploads wait for Wi-Fi by default; the phone and computer must be on
   the same network.

---

## Test list — phone app

Mark each **Pass / Fail / Not tested**, and add a note and a screenshot for each fail. "L1"
means it can be done in the browser; the rest need a real phone (L3).

### A. First run and app modes

| #   | Test                                                | Expected                                                                                                                           | Level  |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1  | First start                                         | "How will this phone be used?" with patient and clinic choices                                                                     | L1     |
| A2  | Register a clinic phone with a wrong code           | "not accepted"; stays on the screen                                                                                                | L1     |
| A3  | Register with a valid one-time code                 | Operator sign-in appears; the same code cannot register a second phone                                                             | L1, L3 |
| A4  | Clinic phone: open a patient invite link or QR      | "This is a clinic phone": patient mode never opens                                                                                 | L1, L3 |
| A5  | Clinic phone after closing and reopening the app    | Still a clinic phone, opens at the lock screen                                                                                     | L1, L3 |
| A6  | Patient phone after accepting an invite             | Can never switch to clinic mode                                                                                                    | L3     |
| A7  | Clinic set-up: camera check (`?benchFps=48` in L1)  | Step 1 "Checking this phone". Below 55 fps: "cannot record well enough", no code field, the code still works after a passing check | L1, L3 |
| A8  | Camera check between 55 and 59 fps (`?benchFps=57`) | "Borderline" warning; the phone can still be registered; Phones list shows "Borderline · 57.0 fps"                                 | L1, L3 |

### B. Operator (clinic)

| #   | Test                                           | Expected                                                                              | Level  |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| B1  | Wrong password                                 | "Operator ID or password is wrong"                                                    | L1     |
| B2  | Temporary password                             | Must choose a new one (≥ 10 characters, letters and digits) before recording          | L1     |
| B3  | 10 wrong passwords in a row                    | Account locked; hospital admin Team → Enable unlocks it                               | L3     |
| B4  | Lock button, then wrong / right password       | Wrong: "not right". Right: back to the session screen                                 | L1     |
| B5  | Leave the phone idle 5 minutes (not recording) | Locks itself                                                                          | L3     |
| B6  | Phone offline at the lock screen               | Cannot unlock (the server checks the password); shows a network message               | L3     |
| B7  | New patient by MRN 00012388                    | Saved; the NCID comes from the hospital connector. The MRN is shown masked (••••2388) | L1, L3 |
| B8  | Unknown MRN                                    | "No patient with this MRN in the hospital records"                                    | L3     |
| B9  | Start without ticking consent                  | Start stays disabled                                                                  | L1     |
| B10 | Practice mode without consent                  | Start stays disabled; with consent it works, and nothing is uploaded                  | L1     |

### C. Patient (home), v3

| #   | Test                                                        | Expected                                                                                                                                                                                         | Level  |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| C1  | Scan the join invite QR with the in-app scanner             | "Choose a PIN" with the hospital name                                                                                                                                                            | L3     |
| C2  | Paste the invite link or SMS code                           | Same as C1                                                                                                                                                                                       | L1     |
| C3  | A used or expired invite                                    | "not accepted … used or expired"                                                                                                                                                                 | L1     |
| C4  | PINs that don't match / too short                           | Clear message. There is no consent box at joining, only "How your recordings are used"                                                                                                           | L1     |
| C5  | My hospitals, right after joining                           | One card, "Joined", "No recording requests"; opening it says there is nothing to record now                                                                                                      | L1     |
| C6  | Doctor sends a record link (dashboard I9)                   | Card shows "1 request" and "Record before your visit on … (by …)"; the hospital page lists the tests                                                                                             | L1, L3 |
| C7  | Start recording, then "Not now" / no tick                   | The consent screen comes first; "Open the camera" is disabled until ticked                                                                                                                       | L1     |
| C8  | Walking test at home                                        | "Someone to help?": Yes records, No skips it with "No helper"                                                                                                                                    | L1, L3 |
| C9  | Full session for the request                                | "Session complete" and "All takes uploaded" (on Wi-Fi); the request moves to the history as "Recorded · uploaded"                                                                                | L1, L3 |
| C10 | Lock, then reopen the app                                   | PIN needed; 5 wrong PINs locks the account (a new invite fixes it)                                                                                                                               | L1, L3 |
| C11 | Join a second hospital ("Join another hospital")            | Same PIN; two cards; each hospital shows only its own requests                                                                                                                                   | L1, L3 |
| C12 | Leave one hospital (withdraw)                               | That hospital shows "Withdrawn", its history read only; the other hospital is not affected                                                                                                       | L1, L3 |
| C13 | Reception sends a new join invite to a withdrawn patient    | Joining again brings the same hospital back, history kept                                                                                                                                        | L3     |
| C14 | Doctor asked "repeat every N days"                          | The hospital page shows the plan with "Due now" or the next date, and "Until your appointment on …"; nothing more is due after that appointment                                                  | L3     |
| C16 | Join with a phone below 55 fps (`?benchFps=41` in L1)       | Camera check fails before the PIN; "Tell my hospital" → "has been told"; reception sees "Phone not suitable · 41 fps" (H11); "Run the check again" on a passing phone joins with the same invite | L1, L3 |
| C15 | Reminder (connector `python -m ncconnector send-reminders`) | The patient gets "please record by …" the day before the record-by date (dummy outbox)                                                                                                           | L2     |

### B2. Clinic queue (clinic phone)

| #   | Test                                         | Expected                                                                                                  | Level  |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| B20 | Doctor adds a clinic request for today (I13) | The clinic phone's home shows "Clinic queue · today" with the patient's name and MRN, time, doctor, tests | L1, L3 |
| B21 | Tap Start                                    | Patient and tests filled in; Start session needs the consent tick                                         | L1, L3 |
| B22 | Record and upload                            | The request shows "Recorded in clinic" on the dashboard, with the operator's name                         | L1, L3 |
| B23 | Not recorded → Did not attend                | "Not recorded: Did not attend" on the phone and the dashboard; in the activity log by name                | L1, L3 |

### D. Recording quality (real phone only; see also `docs/qa/pre-pilot-test-plan.md`)

| #   | Test                                                 | Expected                                                                 |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| D1  | Each test records at 60 fps                          | Takes below 59 fps fail with a plain reason                              |
| D2  | Guidance: too far, one hand, dark room, phone tilted | One clear prompt each; Record is disabled until fixed                    |
| D3  | Incoming call or app switch during a take            | The take stops as interrupted; record it again                           |
| D4  | Fixed lengths                                        | 15 s for FT/FTF/FR/FA, 45 s for SAW; the timer stops recording by itself |
| D5  | Hot phone                                            | Tracking slows; new takes are blocked when critical                      |
| D6  | Airplane mode after recording, then Wi-Fi            | Uploads wait, then complete; nothing is lost                             |

## Test list — dashboards

Run at L2. Sign in with the accounts the stack prints.

### E. Sign-in (all roles)

| #   | Test                            | Expected                                                           |
| --- | ------------------------------- | ------------------------------------------------------------------ |
| E1  | Wrong password / wrong code     | "Wrong e-mail, password or code"                                   |
| E2  | First sign-in (`new.doctor@…`)  | Two-step set-up with a QR code; an authenticator code completes it |
| E3  | 10 wrong attempts               | Account locked; hospital admin Team → Enable unlocks it            |
| E4  | Reload the page / close the tab | Reload stays signed in; a new tab needs sign-in again              |

### F. Platform admin

| #   | Test                                                                                                               | Expected                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Hospitals list                                                                                                     | Sunrise Neuro Clinic, with counts                                                                                                                               |
| F2  | Set-up for Sunrise                                                                                                 | Admin accepted, connector registered, test, take key, storage, team                                                                                             |
| F3  | Onboard a new hospital                                                                                             | Appears as "invited" (the admin invite e-mail goes to the dummy outbox)                                                                                         |
| F4  | Suspend Sunrise, then try the hospital admin                                                                       | Hospital admin and phones are refused; Resume restores them                                                                                                     |
| F6  | Hospitals → Roles and permissions: tick doctor for "Add appointments" and "Assign the doctor", give a reason, Save | "2 changes from the defaults", CHANGED rows; Dr. Rao now has the booking form; the hospital admin sees it read only under Team; "Reset to defaults" restores it |
| F5  | Activity log                                                                                                       | Onboarding and suspension events, no patient names                                                                                                              |

### G. Hospital admin

| #   | Test                                                                                                        | Expected                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Data connections → Test with MRN 00012388                                                                   | All checks "pass"                                                                                                                                                                                                                                                         |
| G2  | Recording keys                                                                                              | One active key                                                                                                                                                                                                                                                            |
| G3  | Team: add operator (ID and full name)                                                                       | Temporary password shown once; "must change password"; the name is shown                                                                                                                                                                                                  |
| G4  | Team: invite a receptionist and a doctor (full name required)                                               | Listed as invited; "Not signed in yet", later "Last signed in …"                                                                                                                                                                                                          |
| G5  | Phones: new registration code                                                                               | 10-character code and QR; it registers one phone (A3)                                                                                                                                                                                                                     |
| G6  | Menu                                                                                                        | Overview, Data connections, Team, Phones, Activity log only (no patients, invites or appointments)                                                                                                                                                                        |
| G8  | Deletion requests (only from phones before v3)                                                              | Shown on Overview when there are any; Mark done                                                                                                                                                                                                                           |
| G9  | Activity log                                                                                                | One table: each row shows the person (name, e-mail, role), what they did and the patient (name live); filter by person; Download CSV                                                                                                                                      |
| G14 | Team → Reset sign-in (another person)                                                                       | Reason asked; they are signed out at once; e-mail with a 24-hour link; with e-mail off, the link shows once instead. Not offered for yourself                                                                                                                             |
| G13 | Data connections → Recording storage → "Your own Azure Blob container" (platform with `NC_AZURE_CLIENT_ID`) | Steps, approval link and custom role shown; a wrong container fails the test and keeps the old storage; a right one says upload pass, read blocked pass                                                                                                                   |
| G12 | Mail server down (wrong `NC_SMTP_PORT`), then invite a doctor                                               | "Saved, but the invite e-mail could not be sent"; the doctor is listed; after fixing the setting, "Resend invite" delivers it                                                                                                                                             |
| G11 | Phones list                                                                                                 | \"Camera check\" column: Passed / Borderline with the fps; phones added before the check say \"Not checked\". \"In use (last 30 days)\": takes recorded and how many were below 59 fps, retakes included (record a session with a retake on a clinic phone, then refresh) |
| G10 | Hospital admin or receptionist tries a patient's history or recording                                       | Refused: medical history, recordings and review notes are for the assigned doctor only                                                                                                                                                                                    |

### H. Receptionist

| #   | Test                                                                                 | Expected                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | Menu                                                                                 | "Appointments" and "Invite patients" only (no team, phones, settings or "Assign patients")                                                                         |
| H2  | Appointments                                                                         | Nothing from the hospital system; "Add an appointment" at the top; find by name or MRN                                                                             |
| H3  | Assign Dr. Rao to Asha's appointment                                                 | "Waiting for doctor's tests"; nothing is sent to the patient yet                                                                                                   |
| H4  | Add an appointment by hand (find "asha")                                             | Listed as "Added by hand"                                                                                                                                          |
| H5  | Ravi: "Send join invite"                                                             | E-mail, SMS or print; with print the QR code shows on screen                                                                                                       |
| H6  | After the doctor sends the link (I9)                                                 | "Doctor sent record link · due …"; after the patient records, "Recorded · uploaded"                                                                                |
| H7  | Book Ravi with Dr. Rao (20 Nov) and Dr. Iyer (27 Nov); then change the 27 Nov doctor | Both appointments keep their own doctor; both doctors can open Ravi; changing one appointment changes only that one ("Doctor changed for …: Dr. Iyer → Dr. Mehta") |
| H12 | Date range: Next 7 / 30 / 60 days, Past 30 days                                      | Appointments beyond 7 days show with 30 or 60; the choice is remembered after reload                                                                               |
| H9  | Invite patients: search "ravi", tick, choose e-mail / SMS / print, Send              | Live results ("Missing" e-mail); print shows a QR; Send is greyed out once sent                                                                                    |
| H11 | Ravi told the hospital his phone is not suitable (seeded in the L2 stack)            | App column: "Not joined" and "Phone not suitable · 41 fps"; the doctor's Choose tests says the phone failed the camera check                                       |
| H10 | Appointments: "History" on a row                                                     | Who added it, invites, doctor assigned and reassigned, the record link, each with name and e-mail; "Last change" column shows the latest step                      |

### I. Doctor

| #   | Test                                                                      | Expected                                                                                                                           |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| I1  | My patients                                                               | Patients with a booked appointment with you (today or later) or a completed one; not cancelled, moved or missed first visits       |
| I2  | Open Asha                                                                 | MRN, birth date, diagnoses, medicines, visits; "fetched just now"                                                                  |
| I3  | Play the recording                                                        | The video plays (decrypted by the connector)                                                                                       |
| I4  | Review: Not usable + note                                                 | "Reviewed: Not usable"; the note stays at the hospital                                                                             |
| I5  | Plan: tick "Also record every N days", change tests, days, medicine; Save | "Plan saved"; the patient's app shows the plan (C14)                                                                               |
| I6  | Ask to record again                                                       | Patient's app: a request "Your doctor asks you to record again" (C6)                                                               |
| I7  | Stop the FHIR stand-in (`pkill -f "port 8180"`), then open Asha           | "Your hospital system is not answering"; recordings still open                                                                     |
| I8  | A patient with no appointment with you                                    | Not in My patients; the connector refuses it (covered by the automated tests)                                                      |
| I9  | Choose tests (v3)                                                         | The menu shows the count; the history is next to the choice; "Same as last time", "Hands only", "All 5"; Send → "Record link sent" |
| I13 | Choose tests for a patient not in the app                                 | "At home" greyed out with a hint; "In the clinic" ticked; button "Add to the clinic queue"                                         |
| I14 | Tick both "At home" and "In the clinic"                                   | Button "Send the link and add to the clinic queue"; Appointments shows Home link and Clinic queue                                  |
| I10 | "Also repeat every 7 days" when sending                                   | The patient page plan shows it ticked with 7 and "Repeats stop at the next appointment, …"                                         |
| I11 | Patient page: "Appointments and record links"                             | Each appointment with its link, the tests, and what was recorded                                                                   |
| I12 | Try to send a link for another doctor's appointment (API)                 | Refused (covered by the backend tests)                                                                                             |
| I15 | Patient page: past appointments 30 / 90 / 180 days, 1 year, all           | Older appointments hidden with a count; upcoming always shown; the choice is remembered                                            |
| I16 | Write a visit remark on your appointment; edit it; clear it               | Shown under the appointment; another doctor cannot write on it; the log says "visit remark written" without the text               |

### J. Privacy check (automated, any time)

```bash
pnpm e2e:dashboard        # includes the scan: no name, MRN, contact or review note at NeuroCapture
```

## Report template

| Test | Result | Phone / browser     | Notes / screenshot |
| ---- | ------ | ------------------- | ------------------ |
| A1   | Pass   | Pixel 7, Android 15 |                    |
