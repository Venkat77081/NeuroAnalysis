# 027 — Security choices before M13

- **Status:** accepted (user, 15 Nov 2026: "do which is best in terms of security")
- **Resolves:** the open questions of decisions 025 and 026, and assumptions A61, A62 and A74

| Question                                             | Choice (the more secure option)                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where are biomarkers computed?                       | **At the hospital**, next to the connector, from the decrypted 60 fps video. Results go to the hospital's database under the NCID. NeuroCapture servers never hold a decryptable recording. This replaces "computed on the server" in DEV_PLAN and decision 023. |
| Fallback to the platform take key?                   | **None.** Every hospital, managed or own-system, must register its own take key (`no_hospital_key` otherwise). For managed clinics NeuroCapture runs the connector, and the key lives there, separate per clinic.                                                |
| Patient e-mail or mobile through the platform (A61)? | **Never.** The dashboard's own invite is a printed QR only, and unknown fields are refused. E-mail and SMS invites go through the hospital connector. The interim dummy MRN link is removed.                                                                     |
| Trusting the platform key on the connector           | **Pinned.** The connector needs the key file (`NCC_PLATFORM_PUBLIC_KEY_PATH`) or its SHA-256 (`NCC_PLATFORM_KEY_SHA256`, shown in the dashboard). A key fetched without a matching pin is refused.                                                               |
| Replay protection across servers                     | **Database nonce store** on both sides (`used_nonces`, `nc_used_nonces`). It works with several API replicas and survives restarts.                                                                                                                              |
| Pilot operators with a 4-digit PIN (A62)             | **Must choose a new password** at next sign-in (migration 0007). The M13 app has the change-password screen.                                                                                                                                                     |
| Self-service unlock                                  | **No.** Staff are unlocked by an admin; patients get a re-invite. Self-service reset would let anyone holding the e-mail inbox take over.                                                                                                                        |

## Consequences

- **Pilot phones.** Until a site's connector registers a take key, its phones cannot start
  sessions. Run `python -m ncconnector rotate-take-key` on each connector (managed ones
  included) before the pilot.
- **Biomarkers.** Computation is a connector-side job (later milestone). The platform keeps
  capture quality and the phone's readiness hint only.
