# 050 — New app look: greeting, to-do cards, calm motion

- **Status:** built on branch `claude/new-ui-for-app`, not merged (user, 18 Nov 2026: "To do go
  with option c and plus the time of day greetings and the motion … Build and push this new app
  ui to new branch … don't merge with main until i say"). Mockups: v21 and v22.

## Patient app

- **Greeting by time of day:** morning has a sun rising on a peach sky, afternoon is light blue,
  and evening is navy with a moon and stars. It uses the patient's **first name, kept on this phone
  only** (`settings.firstName`). The name is never sent to NeuroCapture or the hospital, and it is
  not part of the account backup.
- **First name:**
  - asked once after the recovery code when a new account is made (optional, Skip);
  - changeable in Settings;
  - the unlock screen says "Welcome back, Asha".
- **To-dos (option C):** every to-do across hospitals is a swipe card under the greeting:
  - record (Start opens consent, then the camera);
  - regular recording due;
  - choose an offered time;
  - give consent for a clinic recording.

  When nothing is due, the screen shows "All caught up". The home screen fetches again when the
  app comes back to the foreground.

- **Hospital screen:** the menu only. The "Needs you now" list is removed; red counts on the menu
  rows remain.
- **Test page:**
  - one progress segment per test (done, this one, to come);
  - a lighter demo panel;
  - the steps fade in.
- **Camera screen:**
  - the title sits next to Back on one line, with no clipping;
  - Landmarks and orientation are round icon buttons with their names for screen readers;
  - the countdown numbers pop in.

  The recorder, the native timer and the checks are unchanged.

- **Summary:** a tick draws itself when the session is done (not when ended early).

## Clinic phone

- A greeting card with the operator's name. Operator sign-in now returns `name`, which comes from
  the hospital's staff list; staff are NeuroCapture users, not patients.
- Open patients in the queue are swipe cards; recorded or not-recorded ones are a list below.

## Motion

- Short and calm, 150–600 ms, played once.
- Turned off when the phone asks for reduced motion (`prefers-reduced-motion`).
- Never on the camera screen during a take.

## Round 2 (user, 19 Nov 2026)

- **Patient home:**
  - It matches the mockup: the greeting runs full width under the status bar, with the name on
    its own line ("Good morning, / Asha") and the date without a comma.
  - Hospitals show as rows with an icon, a status and a chevron.
  - Upload status is one line at the bottom.
- **No Lock button for patients.** The app still locks itself when idle (`patientAutoLockMin`). A
  settings (gear) button takes Lock's place in the greeting.
- **Welcome page** (first start): a sunrise picture, "Movement recordings for your care team" and
  two large choices, patient or clinic phone. Long-pressing the logo still opens the engineering
  menu.
- **Clinic phone, per the v22 mockups:**
  - **Set-up:** a centred heading (the camera check still comes before the code, decision 035).
  - **Sign-in:** a greeting first.
  - **Home:** "Good morning, Kavya" with Lock (operators keep it), then "Up next" with the number
    of patients to record and their cards; finished patients appear as short rows under "Today",
    with practice mode below.
  - **Consent:** scanning consent (or consent on the phone) takes the whole screen, with a
    viewfinder and a moving scan line, plus "‹ Queue" to go back.
  - **Ready to record:** the start button names the first test.

## Round 3 (user, 19 Nov 2026; mockup v23, option A)

- **Logo:** the NeuroCapture logo sits at the top left of the greeting card on every screen that
  has one:
  - the patient home;
  - the clinic sign-in;
  - the clinic queue.

  Long-pressing it opens the settings menu. The separate logo row under the greeting is gone.

- **Sun and moon:** they sit below the phone's status bar.
- **Patient:** Settings is a round button fixed at the bottom-right corner.
- **Clinic phone:** Lock is a pill fixed at the bottom-right corner of the queue.
- **Test fix:** the test server no longer puts "today's" clinic patient after midnight when the
  tests run late in the evening.
