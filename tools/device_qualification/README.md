# Device qualification (DEV_PLAN §7, M1)

Every phone model + Android version used for clinical capture must be qualified. The app measures;
`quality-core` assigns the tier from `config/device-tiers.json`.

## Procedure (per phone)

1. Install the debug APK (CI artifact `app-debug-apk`). Charge to > 50 %, keep it **plugged in**.
2. Room temperature (20–28 °C), phone **on a stand** pointing at a lit, textured scene. No case.
3. Close other apps; airplane mode on; ≥ 4 GB free storage.
4. Open the app → **Device check** → **Camera preview test**: confirm the green brackets and grid are
   drawn over the live preview (M1 overlay criterion). Close it.
5. Choose **Full qualification** → **Run benchmark** (≈ 40 min; longer if the 60 fps run fails and
   a 30 fps run follows). Do not touch the phone.
6. Note the tier shown, then copy the reports off the phone:

   ```bash
   adb pull /sdcard/Android/data/com.neurocapture.app/files/qualification/ tools/device_qualification/reports/
   ```

   (Move the pulled files out of the `qualification/` sub-folder into `reports/`.)

7. Regenerate the summary and commit both:

   ```bash
   pnpm --filter @neurocapture/device-qualification summary
   ```

A **Quick check** (≈ 3 min) gives a _provisional_ tier for development; it does not qualify a device.

## Files

- `reports/*.json` — raw reports (schema `contracts/benchmark-report.schema.json`).
- `reports/SUMMARY.md` — generated table; CI fails if it is out of date.
