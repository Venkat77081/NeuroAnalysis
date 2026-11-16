# 039 — Staff sign-in reset

- **Status:** accepted (user, 16 Nov 2026: "build staff reset"; mockup "v8 · Reset a staff
  member's sign-in").

## Decision

- **Who resets whom:**

  | Who                  | Can reset                                                              | Where                                         |
  | -------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
  | Hospital admin       | Front desk, doctors and other admins of their hospital, not themselves | Team                                          |
  | Platform admin       | Hospital admins and other platform admins                              | Hospitals → Set-up → Hospital admins          |
  | Server administrator | Anyone                                                                 | `python -m app.admin reset-sign-in --email …` |

- **The admin picks a reason** (`staff.resetReasons`: forgot password, lost or new phone, misuse).
  It is kept in the activity log.
- **A reset:**
  - clears the password and the authenticator;
  - ends every session at once (refresh tokens revoked; access tokens refused while the account
    has no password);
  - e-mails a single-use link valid `staff.resetTtlHours` (24 hours).
- **The person opens the link,** chooses a new password, and sets up the authenticator again at
  the next sign-in, as at first sign-up.
- **If the e-mail cannot be sent,** the link is shown to the admin once, to hand over in person.
  The command line always prints it, because whoever runs it controls the server.
- **People who never signed up** use "Resend invite" instead (409 `not_signed_up`).
