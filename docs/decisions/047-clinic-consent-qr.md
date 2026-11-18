# 047 — Consent for clinic recordings by QR code

- **Status:** accepted (user, 18 Nov 2026: mockups "v16 · Clinic consent by QR"; "1. keep
  fallback 2. ok 3. No").
- **Goal:** the patient agrees before a clinic recording. For patients with the app, they agree in
  the app, and the clinic phone checks that before it records. No ticking a box on the operator's
  phone.

## The patient's app

- A clinic recording request ("At your visit") offers **Give consent**. The patient reads the
  same consent text as for home recordings (`consentVersion`) and agrees.
- The platform returns a **one-time code**:
  - 12 characters from an alphabet without look-alike letters (`clinicConsent.codeLength`);
  - shown as a QR code (`ncc1:` + code) with the code in letters below it, grouped XXXX-XXXX-XXXX.
- **Valid until the end of the visit day** in the hospital's time zone. Only its SHA-256 hash is
  stored. The code holds no name and no health details.
- The patient may **withdraw** until it is used. Agreeing again replaces the old code.

## The clinic phone

- The queue shows the consent state: **Consent in app**, **Waiting for consent** (the patient
  has the app but has not agreed yet), or **No app**.
- **Scan consent QR** (camera), or type the code. The platform checks:
  - same hospital;
  - same request (`wrong_patient`);
  - not withdrawn, not used, not past the visit day.
- A good scan marks the consent as **used**. The session for that request must carry its
  `consent_id`; otherwise it gets `422 clinic_consent_required`. One consent starts one session.
- **Fallback (kept, user):** when the hospital allows it (`clinic_phone_consent`, on by default),
  the patient reads and agrees on the clinic phone. The operator picks why it was not done in the
  app, from `clinicConsent.fallbackReasons`:
  - no smartphone;
  - not in the app;
  - phone not with them;
  - needed help.

  When the hospital turns it off, a patient without a valid code cannot be recorded.

- **No consent link by SMS or e-mail (user: "No").** Consent is given in the app or at the visit.

## Records

- `clinic_consents` stores the hospital, the patient's NCID link, the request, the source
  (`patient_app` / `clinic_phone`), the reason, the consent version, the times, the code hash and
  the session. No free text.
- The session stores `consent_source`, `consent_reason` and `consent_id`. The doctor's timeline
  shows "consent in the app (QR scanned)" or "consent on the clinic phone (reason)".
- The activity log has `clinic_consent_given` (via app / clinic phone + reason),
  `clinic_consent_scanned` and `clinic_consent_withdrawn`.
- Older apps without consent support cannot start clinic-request sessions on a v16 platform (422).
  The clinic phone must be updated with the platform.
