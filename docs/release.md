# Pilot release and distribution (M9)

Release builds come from the manual GitHub workflow **Release (pilot)**
(`.github/workflows/release.yml`).

- It runs the contract checks and all tests.
- It builds the web app with `VITE_PRODUCTION=1`, which hides the engineering tools (device check, gate advisory, debug flags).
- It produces a signed **AAB** (for Play) and a signed **APK** (for Firebase).
- It can send the APK to Firebase App Distribution testers.

Release builds are not debuggable, so the app only talks to an **https** server.

## One-time setup (owner)

1. **Signing key:** create it once and keep it safe; a lost key means a new app listing.
   `keytool -genkeypair -v -keystore neurocapture-release.jks -alias neurocapture -keyalg RSA -keysize 4096 -validity 10000`
   Back up the keystore and both passwords offline (password manager + a second copy).
   Prefer **Play App Signing**, where Google keeps the app signing key and this one becomes the
   upload key.
2. **Repository secrets** (GitHub → Settings → Secrets and variables → Actions):

   | Secret                          | Value                                                                         |
   | ------------------------------- | ----------------------------------------------------------------------------- |
   | `ANDROID_KEYSTORE_BASE64`       | `base64 -w0 neurocapture-release.jks`                                         |
   | `ANDROID_KEYSTORE_PASSWORD`     | keystore password                                                             |
   | `ANDROID_KEY_ALIAS`             | `neurocapture`                                                                |
   | `ANDROID_KEY_PASSWORD`          | key password                                                                  |
   | `FIREBASE_ANDROID_APP_ID`       | Firebase console → Project settings → Android app ID (`1:…:android:…`)        |
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | JSON key of a service account with the _Firebase App Distribution Admin_ role |

3. **Firebase:** create a project, add an Android app with package `com.neurocapture.app`, and
   create a tester group, e.g. `pilot-operators`.
4. **Play Console:** create the app (`com.neurocapture.app`) and turn on Play App Signing. The
   **first AAB is uploaded by hand** to _Internal testing_. Later releases go to _Internal_ or
   _Closed testing_ tracks with the testers' Google accounts.

## Each release

1. Actions → **Release (pilot)** → Run workflow. Set the version (e.g. `0.9.0`) and, to send to
   testers, the Firebase groups (e.g. `pilot-operators`).
2. The build number (versionCode) is the workflow run number, so it always increases.
3. The AAB and APK are attached to the run. Upload the AAB to the Play internal or closed
   track, or rely on the Firebase invite e-mail for the APK.
4. Before the pilot, check on one phone: a long press on the logo shows only the settings
   (operator, language, frame-rate limit), with no engineering tools, and the server address is https.
