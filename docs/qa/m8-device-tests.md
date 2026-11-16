# M8 tests on real takes (replay parity, readiness)

Debug APK (plugin 0.9.0) from CI. Acceptance: 100 % verdict parity on 50 recorded takes.

1. Record 50 takes on the phone: 10 per test, mixing good takes, stopped early, walking out of
   frame, wrong task, and both orientations where allowed.
2. Get them in plaintext. Takes on the phone are encrypted with a key that never leaves its
   Keystore, so the route is: upload them (M7), then on the server, with the dev private key
   (`NC_SERVER_PRIVATE_KEY_PATH`), run `python -m analysis.export_take <take id> <dir>` for each.
   This needs a running server (Docker or cloud, currently on hold).
3. Run `pnpm replay <folder> --check`. Expected: `50 takes: 50 match`.
4. On the server, as a reviewer, open `GET /sessions/{id}/readiness`. Every test lists all of its
   registered biomarker IDs (FT 12, FTF 18, FR 12, SAW 15, FA 18), each with a status and reason.
5. Take a FA take with the mouth partly covered: the Review screen says "Key body points for this
   test were hidden too often"; the reviewer report shows FA biomarkers PARTIAL / NOT_COMPUTABLE
   with "required landmarks visible in …%".
