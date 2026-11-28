# Family Screen Warden for Android

The kids' phone app. A parent sets the rules in the parent console (their Family Screen Warden account); this app
applies them on the kid's Android phone: the kid's time, apps, websites, bedtime, chores and "Ask a grown-up".

- **The launcher is the phone's home screen.** It is the page in [`../launcher`](../launcher) (copied into the app at
  build time, and shared with the Windows app later), opened as `index.html?phone`. One dark look with four accent
  colours, a bar along the bottom (Home, Phone, Texts, Sound, Grown-up), the "Earn more time" chore list and the
  family chat. The screen turns with the phone, in the launcher and in every app.
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
- **Texts.** The app is the phone's texting app, with its own Texts screen (plain texts, picture texts and group
  texts). The kid can text family any time and friends a grown-up said yes to (not at bedtime or when time is up:
  those wait). A text from any other number is held for the grown-ups, and blocked numbers are dropped. "Ask to add a
  friend" sends the request to the parent console. A copy of every text goes to the parent console. Who the kid can
  text follows the kid's level, set in the parent console: family only, family and approved friends (the default),
  or anyone (texts from new numbers are shown instead of held; blocked numbers are still dropped).
- **The Phone menu** is for calls only: family, friends a grown-up said yes to (not while the phone is locked), and
  the last calls.
- **Camera, My photos and Movie Maker.** Photos and videos with stickers and filters, and movies made from them
  (clips, music, words, voice). Everything stays on the phone and a copy goes to the parent console. Photos can be
  sent in Texts; videos and movies are sent to family as a link. Closed at bedtime and when time is up.
- **Sound and screen.** Sound on, Vibrate or Mute (calls from family still ring), volumes, brightness, when the screen
  turns off, text size, turning the screen with the phone, and screen off / restart.
- **Safe browsing** is a VPN that only handles DNS. It forces SafeSearch on Google, Bing and DuckDuckGo and
  Restricted Mode on YouTube, and blocks encrypted-DNS services that would skip it. Android keeps it always on.
  The website rules are the same ones the kid's computer gets, by the kid's level: only the kid's websites, or a
  filtered web (anything but the blocked sites and names with a blocked word), or an open web (anything but the
  sites a grown-up blocked). With a filtered or open web the VPN refuses blocked names for every app on the phone.
  The kid's own websites are always allowed, within their hours.
- **Website tiles** open in a simple built-in browser that follows the same rules. If a parent allows Chrome as an
  app, it gets the same rules as Chrome policies, plus SafeSearch and no Incognito.
- **"This site is blocked."** A blocked website shows a screen with the site's name and **Ask a grown-up** (a yes
  puts the site on the kid's list, on every device). In other apps a notification opens that screen. The blocked
  sites of the last day are listed for grown-ups in the parent console.
- **Where the phone is, Check in and Ring phone.** See [Location](#location) below.
- **New apps come in two ways:**
  - A grown-up's PIN opens the Play Store for a few minutes. Whatever is installed in that window is allowed.
  - The parent console pushes an APK, which installs silently.
- **Updates** install by themselves when the screen is off. A phone set up without the QR code (quick install) asks
  once per version instead, with a notification to tap; pushed APKs work the same way there.

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
account, for example), open the Play Store, change the colours, let the screen turn with the phone, and update the app.

**Turning the screen.** Android only lets an app switch auto-rotate once a grown-up has allowed "Modify system
settings" for it, and the app can't allow that by itself. Grown-up › **Let the screen turn with the phone** opens that
Android screen for three minutes: switch it on, press Back. After that the kid's own switch in Sound and screen works.

**Without the QR code** (for testing on your own phone), install the APK and type a setup code. The server address is
already filled in (`https://app.familyscreenwarden.com`); change it only if you run your own server. Installed this
way the app counts time and shows the launcher, but it can't lock the phone down.

## Location

What the app collects, when, and what the kid sees (all of it is in `Where.kt`):

- **What is sent.** A position: latitude, longitude, how accurate it is (metres, when Android says), the time of the
  fix, the battery level (0 to 100) and whether the phone is charging. Nothing else: no addresses, no Wi-Fi or
  cell names, no movement or activity data. Positions are not stored on the phone; up to 30 wait in memory while the
  phone is offline and are lost if the app restarts.
- **When.** Only on a paired phone that has the location permission, and only while sharing is on for the kid in the
  parent console (the server's `location.sharing`; when it is off the app sends nothing and drops what was waiting).
  - Every 5 minutes: one position. It is a cheap one: the last position Android already knows if it is under
    4 minutes old and good to 200 metres, otherwise a new one from Android's fused provider (Android 12 and newer)
    or the network (GPS only if there is nothing else). If no new one comes in 20 seconds, the last known one is
    sent with its own time.
  - While "live": a position every 5 seconds, from GPS (or Android's fused provider). Live is on while a grown-up
    has the map open (the server says so), and for 30 minutes after the kid taps "Please come get me" or
    "I need help now".
  - A check-in sends the kid's choice (OK, come get me, help) with one precise position, if there is one.
  - It keeps working with the screen off (the app's always-on service is also a location service).
- **Permissions.** Approximate, precise and background location, and the location type of foreground service. On a
  QR-set-up phone the app grants them to itself as the device owner. A quick-install phone is never asked, so it
  shares nothing unless a grown-up allows location for the app in Android's settings.
- **What the kid sees.** While sharing is on, the Phone menu and the lock screen say "Your grown-ups can see where
  your phone is." and, while a grown-up has the map open, "A grown-up is looking at where your phone is right now."
  The three Check in buttons are under that line. "I need help now" needs a second tap within 5 seconds. When
  sharing is off (or the permission is missing) the line and the buttons are hidden. Android shows its own
  location indicator as it does for any app.
- **Ring phone.** When a grown-up presses Ring phone in the parent console, the next sync (within about 20 seconds)
  carries a ring id. The phone plays the alarm sound at full alarm volume for 30 seconds, even on mute, with a
  notification "Your grown-ups are looking for your phone. Tap to stop the ringing." Tapping it stops the sound and
  puts the alarm volume back. Each ring id rings once. Ring phone sends no position.

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
`&parentlock`, `&ringing`, `&oncall`, `&unread`, `&dialog=phone` or `&dialog=sound` to see those screens, and
`&live` or `&noshare` for the Check in block in the Phone menu.

The Texts and Camera pages are in `app/src/main/assets/texts` and `app/src/main/assets/studio`. They also show sample
data in a browser (`texts/index.html?view=chat|new|ask`, `&bed`; `studio/index.html?view=camera|photos|viewer|movie|
making|done|closed`). Their fonts are the launcher's: in the app, `/fonts/…` is answered from `launcher/fonts`, so in
a browser serve a copy of `../launcher/fonts` next to each page or the text falls back to the system font.

GitHub Actions has a workflow called **Android app** (`.github/workflows/android.yml`):

- **Every push** that touches `android/` or `launcher/` builds the app and runs the unit tests (`CoreTest`,
  `StudioTest`, `TextsTest`, `WebFilterTest`; and the server's own tests), and checks that no page loads anything from the internet. The APK is kept as a workflow artifact for 7 days.
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
- `POST /api/android/pair`, `POST /api/android/request` (an app, or a blocked website), plus the APK and update downloads the sync answer points to;
- Texts: the sync carries `texts` and its answer `texting`; `POST /api/android/friend`;
  `POST /api/android/text-media/:msgId/:mediaId` (a photo, raw);
- Camera and Movie Maker: `POST /api/android/media` (raw, described by `X-Media-*` headers),
  `POST /api/android/media/:id/deleted`, `/link` and `/family-screen`;
- Levels and safe browsing: the sync answer carries `web` and `texting.who`, and the sync sends `blockedSites`;
- Location: `POST /api/android/location` (positions), `POST /api/android/checkin`; the sync answer carries
  `location` (sharing, live, ring).

[SERVER-CONTRACT-CHANGES.md](SERVER-CONTRACT-CHANGES.md) has every new or changed call with its body and answer.

The setup QR hands the app two extras: `server` (the server's address) and `code` (the setup code). The quick-install
link is `screenwarden://setup?server=https://…&code=…`.

See [PORTING-NOTES.md](PORTING-NOTES.md) for what was changed when this app was brought over, and what is still open.

## Known limits

- **Not yet built or tried on a real phone under this name.** See PORTING-NOTES.md for exactly what was checked.
- **Usage access** can't be switched on by a device owner, so setup asks for it once. Without it, time only counts
  for apps opened from the launcher.
- **Texts** need the app to be the phone's texting app. The QR setup makes it so on Android 10 and newer; otherwise
  the setup screen asks. Picture texts depend on the carrier's settings on the phone.
- **Camera** needs the camera and microphone permissions. The QR setup grants them; a quick-install phone asks.
- **Brightness and screen timeout** can only be set on a QR-set-up phone, or after "Modify system settings" is
  allowed. Otherwise only this app's own screens get brighter or darker.
- **Location** needs the location permission, which only a QR-set-up phone gets by itself (see Location above).
  Indoors or with location switched off in Android, positions can be rough or missing.
- **Blocked websites in other apps** are refused by name (DNS), so the app or browser shows its own "can't reach
  this site" page; the "This site is blocked" screen comes from the notification. Only the built-in browser opens
  that screen directly.
- **Play Store window:** Android can't limit the Play Store to one app. While a grown-up has it open, anything
  installed is allowed, and it closes after the minutes set in the parent console.
