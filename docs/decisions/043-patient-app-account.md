# 043 — Patient app account: e-mail, one app PIN, recovery code

- **Status:** accepted (user, 17 Nov 2026: option B with a recovery code, "build it"; mockups
  "v11 · Patient account").
- **Changes:**
  - Decision 027 "the platform never accepts a patient's contact details". The platform still
    stores no address: only a keyed fingerprint of the e-mail. It uses the typed address once, to
    send a sign-in code.
  - Decision 023: one person's hospitals stay unlinked on the platform. The link lives only in an
    encrypted backup that the platform cannot open.

## Why

- Each hospital had its own PIN, and the list of hospitals lived only on the phone.
- A reinstall, a new phone or a forgotten PIN meant a re-invite from every hospital.
- When the same PIN was reset at one hospital, the others silently stopped working.

## What the patient does

1. **Sign up once:**
   - e-mail, then a 6-digit code (`appAccount.codeTtlMinutes`);
   - one app PIN (`patientPin`);
   - a recovery code, shown once: 24 characters, about 120 bits.
2. **Join hospitals** by QR code or code, as before, with **no PIN**. The app account's token
   proves the phone has an account; nothing links the account to the hospital.
3. **Open the app** with the app PIN. The platform checks it, and every wrong try counts. After
   `patientPin.maxFailures` wrong tries the account pauses for `appAccount.pauseHours`.
4. **Reinstall or new phone:** e-mail code + PIN, then "Use this phone?" (the other phone's model
   and when it was last used), then a camera check.
   - Each hospital moves to the new phone (`POST /patient/device/rotate`).
   - The old phone stops working at each hospital and is told "Signed out".
5. **Forgot PIN:**
   - e-mail code + recovery code, then a new PIN and a new recovery code. The old recovery code
     stops working.
   - **Without the recovery code:** choose a new PIN; the hospital list starts again from this
     phone. On a new phone that means a re-invite from each hospital, whose history comes back on
     joining.
6. **Pre-v11 installs:** Settings → "Add e-mail account". The current PIN becomes the app PIN,
   and each hospital stops using its own PIN (`POST /patient/pin/clear`).

## Same phone or another phone

- The app identifies the phone with CaptureKit `getPhoneId()`: SHA-256 of Android's `ANDROID_ID`.
  That ID is per app signing key, survives a reinstall, and changes on a factory reset. The raw
  ID never leaves the native code.
- **Reinstall on the same phone:** e-mail code + PIN, and the hospitals are back.
  - There is no "Use this phone?" and no camera check.
  - The backup records which phone its hospital sign-ins belong to, and on that same phone they
    still work.
- **Another phone:** "Use this phone?", a camera check, then each hospital moves over and the old
  phone is signed out.
- The phone ID is supplied by the phone. A changed app could claim another phone's ID, but it would
  still need the e-mail code and the PIN. The only effect is that the other phone is not signed
  out.

## Cryptography

All of this runs on the phone with WebCrypto, in `apps/mobile/src/lib/appaccount.ts`.

- **Backup:** AES-256-GCM, sealed with a random 256-bit backup key (BK). It holds the hospital list
  with each hospital's sign-in secret.
- **BK is locked twice:**
  - **With the PIN key:** HKDF of PBKDF2-SHA256(PIN, salt, 200 000) joined with a **server share**
    (HMAC(pepper, account ID)). The share is released only after a correct PIN.
  - **With the recovery key:** HKDF of the recovery code. The platform keeps SHA-256 of a separate
    check value (HKDF, different label) to allow a PIN reset; it never sees the code or the
    recovery key.
- **E-mail:** the platform keeps only HMAC-SHA256(pepper, address).
- **The pepper** (`NC_ACCOUNT_PEPPER`) lives in the key vault. Changing it breaks every account.

## What the platform holds

| Table                | Holds                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `app_accounts`       | E-mail fingerprint, PIN hash, attempt counter, salt, sealed backup and the two locked copies of BK, recovery check hash |
| `app_account_codes`  | Hashed one-time codes, attempts                                                                                         |
| `app_account_tokens` | The signed-in phone: install ID, model label, last used, revoked reason                                                 |

- **Never stored:** the e-mail address, the PIN, the recovery code, and which hospitals an account
  belongs to.
- **The honest limit:** someone holding both the database and the pepper could try PINs offline
  and open a backup. They would learn that patient's hospitals and NCIDs, still no names and no
  videos.

## Per hospital

- **Joining via the account:** the hospital's `patient_accounts.pin_hash` is empty, and
  `/patient/login` accepts the phone's secret alone.
- **Pre-v11 joins:** keep their hospital PIN until the install moves onto an account.

## Test support

- The pretend server (browser mock and APK test mode) implements the same API.
- In test builds the code screen shows the e-mail code.
- The test panel has "Reinstall the app", which keeps the pretend hospital and account.
