# 024 — Identity core (M10) and dummy providers

- **Status:** accepted (user, 15 Nov 2026: "for all the db connection, SMS providers, email use
  dummy after we can configure all")
- **Milestone:** M10 (docs/PLATFORM_PLAN.md)

## Decision

- **One kind of caller per token type.** `device` = an operator on a clinic phone; `patient` = a
  patient on their own phone; `staff` = a dashboard user. All three resolve to one `Principal`
  with `site_id`; a platform admin is the only principal without a site.
- **Two-step sign-in for every dashboard user (TOTP, RFC 6238).** On first sign-in the token only
  allows two-step set-up. Every role-checked endpoint refuses it.
- **Accounts start from single-use invites.**
  - Staff: an e-mailed link to set a password.
  - Patients: an e-mail, SMS (only if the hospital pays) or printed QR link to set a PIN.
  - Phones: a one-time 10-character registration code, valid 24 h.
  - All lengths and limits are in `config/platform.json`; message text is in
    `config/messages/en.json`.
- **Operators get a temporary password** from the hospital admin, shown once. It must be changed
  before the operator can record.
- **Dummy providers.** `app/providers.py` (e-mail, SMS) and `app/connector.py` (NCID↔MRN link)
  keep everything in process memory. Real providers plug in behind the same functions, selected
  by `NC_EMAIL_PROVIDER` / `NC_SMS_PROVIDER`; any other value fails loudly. The hospital
  connector arrives in M11.

## Why

- **Tokens.** Typed tokens stop a phone token being used on the dashboard, and the reverse.
- **Two-step set-up.** Making set-up the only allowed action is simpler than a separate
  set-up session.
- **Invites.** Invites avoid shared or default passwords, and they never ask a patient for an
  MRN.
- **Dummy providers.** Real providers need the hospital's accounts and sender IDs (SMS needs
  TRAI DLT registration). Building the flows against dummies keeps M10–M14 moving.

## Consequences

- The dummy outbox is lost on restart, so invites only work in development and tests until a
  provider is configured. Printed QR invites work today (the link is returned).
- Until M11, the platform briefly handles a patient's e-mail or mobile number during an invite.
  It is never stored or logged (assumption A61).
