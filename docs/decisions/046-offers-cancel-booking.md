# 046 — Offered times, cancellations, booking from the app, recordings follow the appointment

- **Status:** accepted (user, 18 Nov 2026: mockups "v14 · Choices, cancellations, booking from the
  app"; "ok on all, new doctor should confirm the test").
- **Changes decision 045:**
  - Patients now pick exact free times on preferred and alternative dates, instead of days and a
    part of the day. v13 requests keep their days.
  - A move takes the appointment's recordings with it, by the rules below.

## The desk offers choices

- **Move it now** (as in v13) or **Offer choices**: up to `offer_max` options (date, time,
  doctor), for patients who use the app.
- **Held times:** offered times are held for the patient until `reply_by` (`offer_reply_hours`,
  default 48). Free times shown to the desk and to other patients leave them out.
- **The current date:** the desk marks it "no longer possible", or "still possible", in which
  case the patient may keep it.
- **The patient** chooses one, keeps the current date (when allowed), asks to be called, or
  cancels with a reason.
- **No answer by the deadline:** the appointment stays as booked, the held times are released,
  and the desk's inbox shows "No answer". Nothing is cancelled automatically.
- **A patient's request the desk cannot meet:** "Offer other times" answers it with the same
  kind of offer.

## Requests from patients

- **Change** (one appointment) and **booking** (a new appointment) requests list exact times:
  - `booking_preferred` preferred dates and `booking_alternatives` alternative dates (defaults 2
    and 2);
  - up to `times_per_date` times each (default 2);
  - picked from free times.
- **Booking** also needs:
  - a doctor bookable in the app, or "any doctor";
  - an optional purpose from a list;
  - a date between `booking_min_days` and `booking_days_ahead` from today.

  One open booking request per patient.

- **The desk** sees each time checked now (free, taken, doctor on leave, outside clinic hours).
  It books one (or any other time), offers others, or declines with a reason code.
- **The desk confirms every booking:** nothing is booked automatically.

## Cancelling

- **Desk:** any time, with a reason (`cancelReasons`), optionally telling the patient.
- **Patient:** any appointment, any time, with an optional reason (`patientCancelReasons`). The
  desk sees it under Requests → "Cancelled by patient" until marked as seen.
- **Effect:** open record links not yet recorded, open requests and open offers are closed.
  Recordings already made stay with the hospital.

## Recordings when an appointment moves

| Situation                                                      | What happens                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Recorded at home within `recording_valid_days` of the new date | Kept: it counts for the new date.                                                                                           |
| Recorded earlier than that                                     | Kept in the history; a new link, same tests, due `record_due_days_before`.                                                  |
| Not recorded, same doctor                                      | The link's record-by date moves to `record_due_days_before` the new date.                                                   |
| Not recorded, another doctor                                   | The link is withdrawn. The new doctor confirms the tests, with the earlier ones pre-filled (`Appointment.suggested_tests`). |
| Clinic recording                                               | Moves to the new day's queue (or, with another doctor, waits for their tests).                                              |

## Data

- **Migration `0022`:**
  - new table `appointment_offers`;
  - `appointments`: `cancelled_by`, `cancel_reason`, `cancelled_at`, `cancel_seen_at`,
    `suggested_tests`;
  - `appointment_change_requests`: `kind`, `doctor_id`, `any_doctor`, `choices`, `purpose`, and
    `appointment_id` may now be empty (bookings);
  - `appointment_notices`: `offer_id`;
  - `doctor_hours`: `bookable`.
- No patient identity, and no free text from patients.
- New notices for the connector: `offer`, `cancelled`, `booked` and `not_booked`.

## Settings (hospital admin → Settings)

| Setting                                   | Options          | Default |
| ----------------------------------------- | ---------------- | ------- |
| Patients may book in the app              | on / off         | on      |
| Preferred / alternative dates             | 1–3 / 0–3        | 2 / 2   |
| Times per date                            | 1–3              | 2       |
| How far ahead / earliest                  | 14–90 / 0–7 days | 60 / 2  |
| Choices the desk may offer                | 1–3              | 3       |
| Patient answers within                    | 12–72 hours      | 48      |
| A recording counts if made within         | 7–30 days        | 14      |
| New record-by date                        | 0–3 days before  | 1       |
| Doctor bookable in the app (Team → hours) | per doctor       | yes     |
