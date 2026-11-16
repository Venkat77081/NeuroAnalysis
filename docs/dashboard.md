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

## Local run

```bash
pnpm --filter @neurocapture/dashboard dev         # http://localhost:5174, API at public/config.json
pnpm e2e:dashboard                                # real platform + connector + FHIR stand-in, then the identity scan
```
