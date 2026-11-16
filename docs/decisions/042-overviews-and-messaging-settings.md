# 042 — Overview pages for every role; e-mail and SMS settings at the connector

- **Status:** accepted (user, 17 Nov 2026: "The v10 mockups look good, build them"; mockups "v10 ·
  Overview" for the platform, hospital admin, front desk and doctor, and "v10 · E-mail and SMS").

## Overview pages

- Every dashboard role now starts on **Overview**: stat cards, one chart and a short list.
- **One endpoint:** `GET /overview?period=4w|12w|1y&tz=<IANA zone>` answers for the signed-in role.
- Time windows are in `config/platform.json` → `overview`.

| Role           | Cards                                                                                     | Chart                                       | List                        |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| Platform admin | Hospitals onboarded, hospitals left, patients (NCIDs), clinic phones, operators           | Recordings uploaded per week, all hospitals | Hospitals needing attention |
| Hospital admin | Patients, recordings (30 days, % retaken), clinic phones, operators, doctors + front desk | Recordings per week, own hospital           | Set-up and health           |
| Front desk     | Appointments today, need a doctor, waiting for tests, not in the app, invites sent        | Appointments per day, next 14 days          | Today's appointments        |
| Doctor         | Choose tests, upcoming, new recordings, my patients, recorded on time                     | Recordings per week, my patients            | Recent recordings           |

- **What the counts include:**
  - A "recording" is one complete take (one video).
  - "Hospitals left" means suspended hospitals.
  - "Clinic only" means a patient with no app account.
  - The platform admin's page carries **counts only** and hospital names, never a patient.
- **Names:** hospital lists hold NCIDs. The browser asks the connector for names, as on every
  other page.
- **Chart:** one series in one hue, so it has no legend; the title names it. Each bar has a hover
  and focus tooltip, and a Table view shows the same numbers.

## E-mail and SMS settings

- The hospital admin enters SMTP and SMS details (Twilio, Amazon SNS, an HTTP gateway, or off) on
  **Data connections**. The browser sends them straight to the hospital connector.
- **Storage:** they are kept in `nc_messaging_settings` as one AES-256-GCM document. Its key is
  derived with HKDF from the connector's signing key, so the database alone cannot be read. If the
  signing key changes, the admin enters the settings again.
- **Write-only secrets:** passwords and tokens are never returned, only "saved".
- **IT wins:** values set in the connector's environment (`NCC_SMTP_*`, `NCC_SMS_*`, …) take
  precedence. A value counts as set by IT when it differs from the built-in default. The dashboard
  shows these fields as "set by IT" and cannot change them.
- **Testing:**
  - "Send a test" sends one message to an address or number the admin types; it is not stored.
  - The test SMS uses the DLT-registered reminder template, so it is delivered in India.
- **What the platform learns:** only `working / failing / off` per channel
  (`POST /connector/v1/messaging/status`, signed). It is stored in `sites.messaging_status`
  (migration 0018) and shown on the hospital admin's Overview.
- **Activity log:** records `messaging_settings_changed` (field names, never values) and
  `messaging_test_sent`.
- **CORS:** the connector now allows `PUT` from the dashboard origin. Visit remarks (decision 040)
  also use `PUT`.
