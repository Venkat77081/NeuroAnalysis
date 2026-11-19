# 052 — Connector history, Undo, the bell and scanning the phone registration QR (v29)

- **Status:** built on branch `claude/new-ui-for-app`, not merged (user, 19 Nov 2026: "Build the
  four missing features too and in phone add scanner to scan qr"). These are the four parts of the
  v28 mock left out in decision 051.

## Connector, last 24 hours

- **Platform:**
  - every signed call from a hospital's connector counts towards its hour. The counts go in
    `connector_pings` (site, hour, count, last time; migration 0024). Hours older than
    `connectorHealth.keepDays` are dropped;
  - a new `POST /connector/v1/heartbeat` endpoint does nothing else, so a quiet connector is still
    seen.
- **Connector:**
  - sends the heartbeat at start and then every `NCC_HEARTBEAT_INTERVAL_S` (default 300; 0 = off);
  - keep it at or below `connectorHealth.heartbeatSeconds` in `config/platform.json`.
- **Offline:** the connector counts as offline after `connectorHealth.offlineAfterMinutes` (20)
  without a check-in.
- **API:**
  - `GET /platform/hospitals/{id}/connector-history` (platform admin);
  - `GET /hospital/connector/history` (`setup.connections`);
  - the hospital list adds `connector_online` and `connector_last_seen_at`.
- **Dashboards:**
  - one bar per hour for `connectorHealth.historyHours` (24): green when it checked in, red for a
    missed hour, grey before it was first seen;
  - the status reads "Online · checked in N min ago" or "Offline since 08:40";
  - the strip is shown in the platform's hospital side panel and on Data connections;
  - hospital cards show "Connector online/offline", and offline hospitals count under "Needs you".
- **Privacy:** only counts and times are kept; nothing about patients.

## Scanning the phone registration QR

- The dashboard's Phones page shows the registration code as a QR holding
  `invites.deviceQrPrefix` + the code (`ncd1:`). The card explains the three steps on the phone.
- On a new clinic phone, after the camera check, **Scan the QR code** opens the in-app scanner.
  This is the same scanner (BarcodeDetector or jsQR) the invite and clinic-consent QRs use.
- The scanner reads the code and registers the phone straight away. A bare code is accepted too.
  Other QR codes (invites, consent codes, links) are refused with "This QR code is not a phone
  registration code".
- Typing the code still works.

## Undo

- **What it covers:** booking a request, moving, offering times, declining, cancelling and "Did
  not come".
- **How it waits:** the change waits in the browser for `appointmentChanges.undoSeconds` (8),
  with a toast that says "Sends in N s · nothing has gone to the patient yet" and has an **Undo**
  button. Undo drops it, so nothing reaches the platform and no SMS or e-mail goes out.
- **When it is sent:**
  - after the window;
  - at once when the tab is hidden or the person signs out.

  Closing the tab with a change still waiting asks first.

- **After sending:** the page shows its usual notice. If sending fails, the toast says why.
- **Shorter window:** a deployment may shorten the window in the dashboard's `config.json`
  (`undoSeconds`). The e2e tests use 2 seconds.

## The bell

- **What it lists:**
  - the Overview items that have an action (hospitals to look at, appointments without a doctor,
    recordings to review, set-up to fix);
  - patients' requests waiting at the desk;
  - visits waiting for a doctor's tests.

  Each item opens its page, or the patient for a doctor.

- **The dot:**
  - it shows when something is new since the bell was last opened on this computer;
  - only item keys (kind, ID, state) are remembered there, never names.
- **Refresh:** every 3 minutes, and each time the bell is opened.

## Tests

- **Backend:** `tests/test_connector_health.py` covers counting, the signature check, offline
  after N minutes, hourly bars and pruning.
- **Connector:** `tests/test_health.py` checks that the heartbeat is counted by the platform.
- **Dashboard unit tests:** `test/v29.test.ts` covers the bar states, bell notes and the dot, and
  the config values.
- **Dashboard e2e:** Undo keeps a cancel from being sent, and without Undo it is sent after the
  window.
- **Phone:**
  - unit tests for the QR parser;
  - an e2e test where a fake camera shows the registration QR and the phone registers.
