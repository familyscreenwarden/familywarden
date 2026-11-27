# Family Screen Warden for Android

The kids' phone app. A parent sets the rules in the parent console (their Family Screen Warden account); this app
applies them on the kid's Android phone: the kid's time, apps, websites, bedtime, chores and "Ask a grown-up".

- **The launcher is the phone's home screen.** It is the page in [`../launcher`](../launcher) (copied into the app at
  build time, and shared with the Windows app later), opened as `index.html?phone`. One dark look with four accent
  colours, a bar along the bottom (Home, Call family, Text family, Grown-up), the "Earn more time" chore list and the
  family chat.
- **Device owner.** The phone is set up from Android's welcome screen with a QR code from the parent console, so the
  app is the phone's device owner. Only allowed apps can open, using Android's lock-task mode; removing an app from
  the list closes it right away. The kid can't remove the app, factory reset, use safe mode or USB debugging, or
  change the date.
- **Time** counts while an allowed app or a website tile is in front, using Android's usage events. The home screen,
  the phone app and calls don't count. Daily limits, per-app limits, free apps, bonus time and reward codes all work.
  Time belongs to the kid, so a phone and a PC share one daily allowance.
- **Time's up, bedtime and a grown-up's lock** close everything except the launcher's lock screen and the phone app.
  From the lock screen the kid can still:
  - call or text the parent's "always" family contacts (and read their texts);
  - dial the emergency number;
  - ask for more time, do a chore for more time, or use a code.

  While the phone is locked, only family can call in (this needs call screening, which the setup screen asks for).
- **Texts** to and from family are sent and shown inside the launcher, so they work even when time is up.
- **Safe browsing** is a VPN that only handles DNS. It forces SafeSearch on Google, Bing and DuckDuckGo and
  Restricted Mode on YouTube, and blocks encrypted-DNS services that would skip it. Android keeps it always on.
- **Website tiles** open in a simple built-in browser. It only goes to the kid's allowed websites, within their
  hours. If a parent allows Chrome as an app, it gets the same list as Chrome policies, plus SafeSearch and no
  Incognito.
- **New apps come in two ways:**
  - A grown-up's PIN opens the Play Store for a few minutes. Whatever is installed in that window is allowed.
  - The parent console pushes an APK, which installs silently.
- **Updates** install by themselves when the screen is off.

The app's id is `com.familyscreenwarden.kids`; its device-admin receiver is
`com.familyscreenwarden.kids/.admin.KidsAdminReceiver`.

## Setting up a phone (parents)

1. In the parent console, choose **Add a phone**. Optionally enter the Wi-Fi details, then make the **QR code**.
2. Take a new or factory-reset phone (Android 9 or newer). On the first welcome screen, **tap the same spot 6
   times**. A QR scanner opens.
3. Scan the code. The phone connects, downloads Family Screen Warden from the server, and sets itself up as a
   managed phone.
4. Pick whose phone it is. Allow **usage access** (it counts time) and make it the **phone app** (calls show family
   names, and only family can call while it's locked). Then tap **Start**.

A grown-up's screen PIN (or an emergency code from the parent console) opens the grown-up menu from the **Grown-up**
button. From there you can add time, lock the phone, open the phone's settings for 15 minutes (to add a Google
account, for example), open the Play Store, change the colours, and update the app.

**Without the QR code** (for testing on your own phone), install the APK and type a setup code. The server address is
already filled in (`https://app.familyscreenwarden.com`); change it only if you run your own server. Installed this
way the app counts time and shows the launcher, but it can't lock the phone down.

## Building

```bash
cd android
gradle testDebugUnitTest assembleDebug     # needs JDK 17+ and the Android SDK (compileSdk 36)
```

The build copies `../launcher` into the app's assets (`copyLauncher` in `app/build.gradle.kts`), so the launcher
folder must sit next to this one. `VERSION` holds major.minor; the build number is the GitHub run number
(`1.0.<run>`).

To look at the launcher without a phone, serve `../launcher` with any static web server and open
`index.html?phone` (phone) or `index.html` (computer). It shows sample data. Add `&timeup`, `&bedtime`,
`&parentlock`, `&ringing` or `&oncall` to see those screens.

GitHub Actions has a workflow called **Android app** (`.github/workflows/android.yml`):

- **Every push** that touches `android/` or `launcher/` builds the app and runs the unit tests (and the server's own
  tests). The APK is kept as a workflow artifact for 7 days.
- With the signing secrets it builds a **signed release APK**; without them, a **debug APK** for testing only.

## Signing key: important

A phone only accepts updates signed with the same key it was set up with, so **the key can never change once phones
are set up**. Lose it and every phone has to be factory reset to get a new version. Keep a copy somewhere safe,
outside GitHub. The key is never in this repository: the build reads it from these repository secrets.

- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`

To make a key (once):

```bash
keytool -genkeypair -v -keystore screenwarden.jks -alias screenwarden -keyalg RSA -keysize 4096 -validity 36500
base64 -w0 screenwarden.jks      # paste into the ANDROID_KEYSTORE_BASE64 secret
```

## Publishing

1. Set the repository **variable** `WARDEN_SERVER_URL` (for example `https://app.familyscreenwarden.com`) and the
   **secret** `PUBLISH_TOKEN` (the same value as the server's `PUBLISH_TOKEN`).
2. Go to **Actions › Android app › Run workflow** and tick **Publish**. Add a line about what changed if you like.
3. The workflow uploads the signed APK to `POST <WARDEN_SERVER_URL>/internal/android/publish` with
   `Authorization: Bearer <PUBLISH_TOKEN>`, `X-Version`, `X-Sha256` (the file's SHA-256, hex), `X-Notes` (base64) and
   `X-Signature-Checksum` (the signing certificate's SHA-256 as URL-safe base64, the form Android's setup QR uses).
4. The server then offers that version in the setup QR code, and phones update themselves.

Publishing refuses to run without the signing key.

## How the app talks to the server

All server traffic is in one file, `app/src/main/java/com/familyscreenwarden/kids/WardenApi.kt`:

- `POST /api/warden/setup/check`, `/api/warden/sync`, `/api/warden/launcher`, `/api/warden/launcher/act`,
  `/api/warden/pin`, `/api/warden/redeem` (shared with the Windows app);
- `POST /api/android/pair`, `POST /api/android/request`, plus the APK and update downloads the sync answer points to.

The setup QR hands the app two extras: `server` (the server's address) and `code` (the setup code). The quick-install
link is `screenwarden://setup?server=https://…&code=…`.

See [PORTING-NOTES.md](PORTING-NOTES.md) for what was changed when this app was brought over, and what is still open.

## Known limits

- **Not yet built or tried on a real phone under this name.** See PORTING-NOTES.md for exactly what was checked.
- **Usage access** can't be switched on by a device owner, so setup asks for it once. Without it, time only counts
  for apps opened from the launcher.
- **Play Store window:** Android can't limit the Play Store to one app. While a grown-up has it open, anything
  installed is allowed, and it closes after the minutes set in the parent console.
