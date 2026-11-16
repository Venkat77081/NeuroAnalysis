# 036 — E-mail over SMTP; SMS through Twilio, Amazon SNS or an HTTP gateway

- **Status:** accepted (user, 16 Nov 2026: "Build email and sms provider, for email we can use smtp
  connection"). Replaces the dummy-only providers of decision 024.

## Decision

- **E-mail: SMTP** (`email_provider = smtp`). It works with any mail service:
  - Amazon SES (SMTP interface);
  - Azure Communication Services Email (SMTP);
  - a hospital's own mail server or relay.

  Settings: `smtp_host`, `smtp_port`, `smtp_security` (`starttls`, `ssl` or `none` for a trusted
  internal relay), `smtp_username`, `smtp_password`, `mail_from`, `mail_from_name` and
  `mail_reply_to`. Patient invites carry the QR code as a PNG attachment.

- **SMS** (`sms_provider`):
  - `twilio`: REST API, a number or a messaging service;
  - `sns`: Amazon SNS, credentials from the standard AWS environment or role;
  - `http`: POSTs `{to, body, template, dlt_template_id, dlt_entity_id, sender}` with a bearer
    token to any gateway (MSG91, Gupshup, Kaleyra, a hospital's own) through a small adapter.
- **India (TRAI DLT):** `sms_dlt_entity_id`, and `sms_dlt_template_ids` as JSON
  (`{"patientInviteSms": …, "reminderSms": …}`). SNS sends them as `AWS.MM.SMS.EntityId` and
  `AWS.MM.SMS.TemplateId`; the HTTP gateway receives them in the body. The message texts in
  `config/messages/en.json` must match the registered templates.
- **Phone numbers** from hospital records are normalised to E.164. Numbers without a country code
  get `sms_default_country_code` (`+91`).
- **Who sends what** (unchanged by this decision):
  - The **platform** sends only staff invite e-mails.
  - **Patient** invites and reminders are sent by each hospital's **connector**, with the
    hospital's own accounts, so patient contact details never reach NeuroCapture (decision 023).
- **One implementation.** `backend/app/delivery.py` and `connector/ncconnector/delivery.py` are
  identical after the docstring; `tests/test_copies.py` keeps them so.
- **Failures:**
  - **Staff invite:** the person is saved and the API answers `502 email_not_sent`; the dashboard
    shows it and refreshes the list, and "Resend invite" works later.
  - **Patient invite:** the result is `not_delivered` with `email_not_sent`, `sms_not_sent` or
    `bad_phone`, and it is written to the activity log. The front desk can retry or print the QR.
  - **Reminder:** it is not marked as sent, so the next run retries it.
- **Start-up check.** A provider that is chosen but not fully set up stops the service at start-up
  with a clear message, not at the first invite.
- **Privacy.** Addresses, numbers and message text are never logged; errors are logged by type
  only.

## Not done

- A built-in MSG91 or Gupshup client. Their APIs need per-template variables. Use the `http`
  adapter or Twilio, or ask for a native client once the DLT templates are registered.
- A delivery queue with retries for staff e-mails. A failed send is reported at once instead.
