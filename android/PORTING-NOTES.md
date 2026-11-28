# Porting notes: Family Screen Warden for Android

This app was ported from an earlier in-house kids' phone app. These notes say what was done in the port, what was
left alone, and what is still open. "Source" means that earlier app and its launcher page.

## Copied

- The source app → `android/` (Gradle files, `app/`, `store/`, `VERSION`). The source had no build outputs,
  keystores or `local.properties`; none were copied. `android/.gitignore` (new) keeps them out.
- The source's launcher page → `launcher/` (at the repo root, for the Android build now and the Windows app later).
- `app/build.gradle.kts`: `copyLauncher` now reads `../launcher`.

## Renamed

Nothing keeps the source's name, on screen or inside.

| What | Is now |
| --- | --- |
| applicationId, namespace, Kotlin packages and folders | `com.familyscreenwarden.kids` |
| Device-admin receiver | `com.familyscreenwarden.kids/.admin.KidsAdminReceiver` |
| App name | Family Screen Warden (label under the icon and in the home-screen chooser: "Screen Warden") |
| Gradle project name, APK file names | `FamilyScreenWarden` |
| `VERSION` | 1.0 (versions are `1.0.<run number>`) |
| The server client (class and file) | `WardenApi` / `WardenApi.kt`, `WardenApiException`, `Kids.api` |
| Server paths | `/api/warden/*` (same sub-paths and shapes as the source used; `/api/android/*` unchanged) |
| Setup QR extras | `server` (the address) and `code` |
| Setup link | `screenwarden://setup?server=…&code=…` (the only scheme the app answers to) |
| Saved pairing and preference names | `Pairing.server`, `setupServer` |
| State field sent to the page | `launcher.serverUrl` |
| WebView hosts | `app.screenwarden`, `cache.screenwarden` (LauncherActivity.kt, Apps.kt) |
| JavaScript bridge | `window.ScreenWardenAndroid`, `window.__swReceive` (LauncherActivity.kt, launcher/android.js) |
| Log tag, wake-lock tag, contact tag, device-id salt | `ScreenWarden`, `screenwarden:call`, `screenwarden:<id>`, `screenwarden-kids:` |
| Wording on screen (setup, notifications, toasts, VPN name, admin description, launcher) | Family Screen Warden / "your Family Screen Warden account" / "the parent console" |
| Manual setup | address pre-filled with `https://app.familyscreenwarden.com` (`SetupActivity.DEFAULT_SERVER`) |
| Comments, test names | "the server" |

Colours and artwork: SetupActivity, the built-in browser's bar, the window/status/navigation bar colours and the
launcher frame use the Family Screen Warden tokens. The app icon (`ic_launcher_*`), the notification icon
(`ic_notify`), `store/icon.svg` and `store/icon-512.png` are the green shield on `#04060f`.

## Removed (the source's built-in game)

App (Kotlin):

- The game's package and key constants, the special app rule for it, the command and launcher action that opened or
  installed it, and its toast.
- The 3D hero: its model downloads, the `assetBase` field, the `.glb` type in LauncherActivity's cache handler.
- The game's flag in the launcher settings and in the state sent to the page (a server that still sends such a
  field is fine: unknown fields are ignored).

Launcher page:

- The 3D hero and `vendor/` (three.js and its loaders: used only for the hero).
- Coins, XP, levels, trophies, the game's card/tile/banner, its silent install, hero switching, the game friends list.
- The page ignores hero or game data if a server sends any, and works when the server sends none (checked).

Removed with the layouts (not the game, but they only lived in the layouts that went):

- **The "Gamer library" and "Glass store" layouts.** There is now one look (the Family Screen Warden dashboard), in
  phone mode and desktop mode, plus four accent colours.
- **The family feed, cheers, "who's online" and "minutes this week"** (owner's decision: they stay removed). The
  page no longer sends `cheer` and no longer reads `info.family`, `info.feed`, `info.friends`, `info.weekMinutes`.
- Emoji on buttons and headings (text labels instead); `bar.css` and `phone.css` are merged into `launcher.css`.

## Kept, unchanged in behaviour

Time limits, per-app limits, free apps, bedtime (with warnings and the grown-up's 30-minute skip), the lock screen,
family calls, the dialer, call screening, in-app family texts, website tiles and the built-in browser, the
safe-browsing DNS VPN, requests ("Ask a grown-up": time, app, website), the parent PIN menu (add time, lock, phone
settings, Play Store window, colours, update), pushed APK installs, self-update, bonus time and codes (reward codes
and offline emergency codes), chores for extra time, and the family chat.

- **Family chat** was restored in the new look after the first pass: a "Family chat" card on the home screen (the
  last two messages, a "New" tag when someone else wrote since the kid last opened it, "Open the chat"), and a
  dialog with the whole list and a box to write in. Same data as the source: `info.chat = [{ id, who, mine, emoji,
  color, text, at }]` in the launcher answer, and a message goes out as the launcher action
  `{ action: "chat", text }` (300 characters at most). The card is hidden when the server sends no `chat` list.
  The source had no unread mark for chat; the "New" tag is an addition and lives only in the page (it resets when
  the page reloads). `emoji` and `color` are not shown.

- **Network contract.** Every request body and response shape is as in the source; only the path prefix changed
  (`/api/warden/setup/check`, `sync`, `launcher`, `launcher/act`, `pin`, `redeem`; `/api/android/pair`, `request`;
  APK and update downloads; since the second update also `/api/android/friend`, `text-media`, `media`, see below).
  All of it goes through `WardenApi.kt` (the comment at the top says so). `core/`
  (Engine, Models, Dns, SafeSearch, Sites, AppMatch, UnlockCodes) only lost the game's settings field.
- **The page ↔ app messages** are the same, minus the game's. Page → app: `hello`, `home`, `front`,
  `switch`, `dialog`, `launch`, `site`, `volume`, `power`, `call`, `call-answer`, `call-end`, `call-mute`,
  `call-speaker`, `text`, `emergency`, `pin`, `code`, `desktop`, `act` (`ask`, `chore`, `chat`, `look`), `parent`;
  since the second update also `texts`, `camera`, `movies`, `sound-mode`, `volume-set`, `brightness`,
  `screen-timeout`, `rotate`, `text-size`, `call` with `num` (a friend), and `parent` with `what: "rotate"`. App →
  page: `state`, `toast`, `dialog`, `pin`, `code`, `result`. `index.html?phone` and `index.html?bar` work as before.
- **Chores ("Earn more time").** The list is a card on the home screen. On the lock screen "Do a chore" now opens the
  same list as a dialog (in the source it scrolled a list that was hidden behind the lock screen). A tap sends
  `act { action: "chore", id }` as before.

## Changed on purpose (launcher)

- **Colour themes.** The server stores a layout name and a theme name per kid. The layout is ignored. The four theme
  names are kept as the values sent to the server and now mean accent colours: `galaxy` = Warden green (the default,
  also used for any unknown name), `ocean` = periwinkle, `jungle` = teal, `sunset` = coral. A colour change sends
  `act { action: "look", layout: <the stored layout or "bright">, theme }`, the same shape as before.
- **Tile colours** come from six brand tints, in turn. The icon colour the app works out (`tiles[key].color`) is still
  sent but the page no longer uses it. Real app icons are shown when the app provides them.
- **Phone bar:** Home, Phone, Texts (with the number of new texts), Sound, Grown-up. (The first port had Home, Call
  family, Text family, Grown-up, as in the approved mockup; the second update below added Texts and Sound and made
  the Phone menu calls only.) The clock, the time pill and the Wi-Fi button are not on the phone bar (time is in the
  card at the top). "Sound and screen" and "Colours" are also two quiet buttons at the bottom of the home screen;
  screen off and restart are inside Sound and screen.
- **Phone lock screen** covers the bar (as in the mockup) and carries its own Emergency call and Grown-up PIN
  buttons, the family list and the last two texts. At bedtime the Grown-up PIN button still offers the 30-minute
  skip; otherwise it opens the grown-up menu.
- **"I have a code"** is also in the Ask dialog (it was only on the lock screen).
- **Fonts** (Inter, Space Grotesk; SIL Open Font License, licence texts in `launcher/fonts/`) are bundled. The page
  loads nothing from the internet.
- **CI:** Publish is unticked by default (the source's was ticked). The publish request has one more header,
  `X-Signature-Checksum`.

## Left as they are

- Field names inside the shared JSON shapes (`exe`, `computerId`, and so on).
- Theme and layout values `galaxy`, `ocean`, `jungle`, `sunset`, `bright` (values the server stores, see above).
- `android:usesCleartextTraffic="true"` (so a self-hosted server on plain http works), all permissions, minSdk 28,
  targetSdk/compileSdk 36, dependency versions: as in the source.

## Unsure / open

1. **Not compiled.** No Android SDK on the machine that did the port, and installing one was not permitted. What ran
   instead:
   - the pure-Kotlin core tests (`CoreTest.kt`, 26 tests) compiled with Gradle's bundled Kotlin 2.0.21 compiler
     (not the project's 2.1.21, and without the serialization compiler plugin) and passed;
   - every Kotlin file's `package` line matches its folder; every `com.familyscreenwarden…` import resolves to a
     declaration; every component in AndroidManifest.xml has a class; all XML parses;
   - `node --check` on `launcher.js` and `android.js`;
   - the launcher in headless Chrome at 390x844 (`?phone`) and 1280x720, fed state shaped like `Kids.pageState()`
     through a stub of the Android bridge / `window.chrome.webview`.

   The Android-facing Kotlin (everything outside `core/`) has **not** been through a compiler since the edits. The
   edits there are deletions, string changes and the SetupActivity/SiteActivity colour code. The first CI run is the
   real check. The vector drawables were checked by drawing the same paths in a browser, not by Android.
2. **What the server must match.** Routes under `/api/warden/*`; the setup QR's admin extras `server` and `code`;
   and, an assumption of this port, the quick-install link as `screenwarden://setup?server=…&code=…` (scheme
   `screenwarden`, query name `server`). If the server's link uses another scheme or query name, the link does
   nothing in the app.
3. **`X-Signature-Checksum`.** The workflow sends the signing certificate's SHA-256 as URL-safe base64 without
   padding (read with `apksigner`, or from the keystore with `keytool`). The server stores it; its QR currently uses
   the package checksum (the file's SHA-256), which also works. The workflow's shell steps were not run on GitHub;
   the hex → base64 step and the `keytool` parsing were tried locally with a throwaway key.
4. **"Your request goes to a parent. They can say yes from anywhere."** (lock screen, from the mockup) is true only
   if the parent console notifies parents. Reword if it doesn't.
5. **"Your apps come back tomorrow at 7:00 am"** uses `status.dayEndsAt` (when the kid's day rolls over), which is
   what the app knows. If mornings should open later than the day rollover, the server needs to say when.
6. **Kid avatar.** The page shows `info.kid.emoji` if the server sends one, otherwise the first letter of the name.
   `info.kid.color` is no longer used.
7. **Chat on the lock screen.** The chat can't be opened while the phone or PC is locked (as in the source). Family
   texts and calls can.
8. **Search on the phone** was dropped to match the mockup (category chips appear when there are more than 9 tiles).
9. **Windows.** `launcher/` is ready for a Windows host (`index.html`, `index.html?bar`, `window.chrome.webview`),
   and the parent menu still says "Windows desktop for 30 minutes" there, but no Windows app exists in this repo yet,
   so that side was only seen in a browser.
10. **The `server-tests` job** in the workflow (`npm ci && npm test` in `server/` with a Postgres service and
    `TEST_DATABASE_URL`) was written from `server/test/helpers.ts` and has not been run.
11. `store/icon-512.png` was rendered from `store/icon.svg` with headless Chrome. No Play Store listing art beyond
    that exists.

---

# Second update: Texts, Camera and Movie Maker, Sound and screen (27 November)

The source app changed a lot in the day after the port. All of it was brought in. "Source" below still means the
earlier in-house app and its launcher page.

## What came in

- **Camera, My photos and Movie Maker:** `StudioActivity.kt`, `Studio.kt`, `core/StudioRules.kt`, `assets/studio/`.
  Copies go to the server; photos go out in Texts, videos and movies as a link.
- **Texts with picture and group texts:** `Texts.kt`, `TextsActivity.kt`, `TextReceivers.kt` (the receivers, the
  quick-reply service and the "text this number" activity Android asks of a texting app), `core/Mms.kt`,
  `core/TextRules.kt`, `assets/texts/`, `res/xml/files.xml`. `SmsReceiver` moved from `Phone.kt` to
  `TextReceivers.kt`.
- **Sound and screen:** `Sound.kt` (sound on / vibrate / mute with family calls still ringing, volumes, brightness,
  screen timeout, text size, auto-rotate), with power inside it on phones.
- **The Phone menu is calls only** (family, approved friends, recent calls).
- **Updates and pushed APKs on quick-install phones** (`Installer.kt`: asks once per version, leaves a notification).
- **Allowed apps no longer go missing after a restart** (`Apps.kt`, `Kids.watchPackages`, `Kids.unlocked`,
  `BootReceiver`).
- **The screen turns with the phone** (manifest `fullUser`, the switch, the grown-up menu option, sideways layouts).
- Manifest (9 permissions, the camera feature, 2 activities + the compose activity, 4 receivers, 1 service, the file
  provider), `Policy.kt`, `Kids.kt`, `core/Models.kt` (`Friend`, `AskedFriend`, `TextingInfo`, `Snapshot.texting`),
  `SetupActivity.kt` (the "Make it the texting app" step), `WardenApi.kt` (`upload`).
- The unit tests `StudioTest.kt` and `TextsTest.kt` (which also holds `MmsTest` and `TextRulesTest`).

How: the source's files from before and after its change were put through the port's renames, and each file the port
already had was merged three ways (port, source before, source after). One merge needed a hand (the setup screen's
colour constant). New files were copied through the same renames, then read and edited by hand.

## Where this differs from the source

- **Names.** Bridges `ScreenWardenTexts` and `ScreenWardenStudio`; in-app addresses `media.screenwarden`,
  `pick.screenwarden`, `gallery.screenwarden`, `studio-media.screenwarden`; `Texts.applyServer`; the launcher's own
  tile keys `sw-texts`, `sw-camera`, `sw-movies`. Wording on screen and in comments says Family Screen Warden / the
  parent console / your family.
- **One header on the wire: `X-FSW-Upload: 1`** on the two raw uploads (the source's header carried its product
  name; this is the header the server already uses for APK uploads). Nothing else on the wire was renamed. See
  SERVER-CONTRACT-CHANGES.md.
- **The camera upload goes through `WardenApi.sendFile`** (new). The source opened a connection of its own in
  `Studio.kt`; here all server traffic stays in `WardenApi.kt`. Same request.
- **Fonts for the new pages.** `assetPath()` (bottom of `StudioActivity.kt`) answers `/fonts/…` from the launcher's
  bundled fonts for the Texts and Camera pages, so there is one copy of the fonts and nothing loads from outside.
- **Look.** `assets/texts` and `assets/studio` were re-skinned to the launcher's dark dashboard (same tokens, fonts,
  44 px buttons). Their CSS files were rewritten; class names, HTML structure and JavaScript are the source's, apart
  from avatar colours (the six brand tints) and a few inline styles that moved into the CSS. Sticker, filter and
  sample-picture colours inside the camera and movies are content and were left alone. The emoji picker in Texts
  stays (it types emoji into a text). Sideways layouts were added for the Texts page (the source had them for the
  camera and Movie Maker only). One layout fault was fixed: in Movie Maker's "Add clips" sheet the squares overlapped.
- **Launcher.** The source's emoji buttons became text labels, as everywhere in this launcher. The source's bar
  icons for Texts and Sound became two more buttons on the phone bar; the Texts, Camera and Movie Maker tiles have
  small line drawings instead of emoji. Because the lock screen covers the bar here, the lock screen got a **Texts**
  button (family texts still work when the phone is locked). On an app without its own Texts screen
  (`phone.texts` missing) the Texts button still opens the old "Text family" list. Nothing that was removed came
  back (no game, hero, layouts, feed or cheers).
- **CI.** The page check now also covers the Texts and Camera pages and their fonts. The unit-test step already runs
  every test class.

## Line counts (source file → this app's file; "changed" = lines that differ after the automatic renames)

| File | Source | Here | Changed |
| --- | --- | --- | --- |
| `Sound.kt` | 176 | 176 | 8 |
| `Studio.kt` | 216 | 198 | 9 |
| `StudioActivity.kt` | 328 | 337 | 20 |
| `TextReceivers.kt` | 96 | 96 | 0 |
| `Texts.kt` | 473 | 473 | 5 |
| `TextsActivity.kt` | 348 | 348 | 13 |
| `core/Mms.kt` | 269 | 269 | 0 |
| `core/StudioRules.kt` | 104 | 104 | 1 |
| `core/TextRules.kt` | 38 | 38 | 0 |
| `test StudioTest.kt` | 74 | 74 | 1 |
| `test TextsTest.kt` | 103 | 103 | 0 |
| `res/xml/files.xml` | 6 | 6 | 0 |
| `assets/studio/index.html` | 182 | 182 | 7 |
| `assets/studio/studio.js` | 1467 | 1467 | 11 |
| `assets/studio/studio.css` | 258 | 288 | 180 |
| `assets/texts/index.html` | 84 | 84 | 0 |
| `assets/texts/texts.js` | 286 | 284 | 12 |
| `assets/texts/texts.css` | 111 | 165 | 127 |

For the files the port already had, the number of lines the source added equals the number added here in every file
(Apps 7, Calls 2, Installer 48, Kids 105, KidsService 2, LauncherActivity 9, Policy 17, SetupActivity 10, Models 10,
manifest 60; Phone.kt only lost `SmsReceiver`), except `WardenApi.kt` (18 in the source, 45 here: `sendFile` and a
longer comment).

## Checked, and not

Still **not compiled**: there is no Android SDK on this machine. What ran:

- The pure-Kotlin tests with Gradle's bundled Kotlin 2.0.21 compiler (`core/*.kt` and the three test files; not the
  project's compiler, no serialization plugin): **37 tests, all passed** (the 26 from before, plus StudioTest, MmsTest
  and TextRulesTest).
- Every Kotlin file's `package` matches its folder; every `com.familyscreenwarden…` import resolves; all 26
  components in the manifest have a class (the file provider is androidx's); every permission the source added is
  there; `@xml/files` and both themes exist; all XML parses; the workflow YAML parses and its page check passes here.
- `node --check` on `launcher.js`, `android.js`, `texts.js`, `studio.js`.
- No file, name or text in `android/`, `launcher/` or `.github/` mentions the source product or its game.
- Headless Chrome: the launcher at 390x844, 844x390 and 1280x720; the Texts page with the app's bridge stubbed
  (chats, bedtime, a chat with photos / failed / sending texts, new text, ask a friend, gallery; upright, sideways and
  wide); the Camera page with the bridge stubbed and Chrome's fake camera (camera, video mode, My photos, picking,
  viewer, delete, empty Movie Maker, closed at bedtime) and with its own sample data (Movie Maker and its sheets,
  making, done). No console errors, no request outside the page and the app's own addresses, bundled fonts loaded.

Not checked, so the first CI build and a real phone are the test:

1. Everything Android-facing: `Texts.kt`, `TextsActivity.kt`, `TextReceivers.kt`, `Studio.kt`, `StudioActivity.kt`,
   `Sound.kt` and the merged files have not been through a compiler here.
2. Sending and receiving real texts and picture texts, the camera on a real WebView, recording and making a movie
   (Chrome's fake camera only showed the screens), uploads, the link, auto-rotate, brightness.
3. `WardenApi.sendFile` is new code written for this port.
4. The server side of SERVER-CONTRACT-CHANGES.md was being written at the same time and was not tried against this app.
5. The page that a video link opens is the server's; the app only passes the link on.

---

# Third update: levels and shared safe browsing, texting by level, location (28 November)

The source changed again (two changes: the kids' levels with one set of safe-browsing rules for computers and
phones, and location for a live map with Check in and Ring phone). All of it was brought in.

## What came in

- **Safe browsing by level:** `core/WebFilter.kt` (new), `SafeVpn.kt` (blocked names get "no such name" for every
  app with a filtered or open web), `SiteActivity.kt` (uses WebFilter; a refused site opens the blocked screen
  instead of a toast), `Policy.chrome` (Chrome's block list), `core/Models.kt` (`WebInfo`, `Snapshot.web`,
  `PhoneState.blockedSites`), `Kids.kt` (`siteBlocked`, `askSite`, `blockedSites` in the sync).
- **"This site is blocked":** `BlockedActivity.kt` (new) and its manifest entry.
- **Texting by level:** `TextingInfo.who`, `TextRules.People(who)`, `Texts.people()`.
- **Location:** `Where.kt` (new), the 5-second loop in `Kids.start`, `Where.ringIfAsked` after each sync,
  `phone.location` in the page state, the `checkin` and `stop-ring` commands, `LauncherActivity` (the ring's
  notification stops it), `KidsService` (also a location foreground service once the permission is there),
  `Policy` (the device owner grants the three location permissions), manifest (4 permissions,
  `foregroundServiceType="specialUse|location"`), `LocationInfo` and `Snapshot.location`.
- **Launcher:** the Check in block in the Phone menu and on the lock screen, the `checkin` message, sample data.
- The unit test `WebFilterTest.kt` (3 tests: the two web modes and texting levels).

How: the source's change was put through the port's renames and applied to this app's files; one piece needed a
hand (`Policy.chrome`, where the port's comment differed). The two new screens' wording and colours were then done
by hand.

## Where this differs from the source

- **Nothing on the wire** (see SERVER-CONTRACT-CHANGES.md, 28 November).
- **Location behaviour is the source's, line for line**: when it reports, which provider, the accuracy and age
  limits, the 30 minutes after "come get me" / "help", the ring. `Where.kt` differs from the source only in the
  package, `WardenApi`, one private name and the wording of comments and one message.
- **"This site is blocked" screen:** the dashboard colours (background `#04060f`, a card `#080c22` with a `#141b3f`
  line, inset rows `#0e1433`, green "Ask a grown-up", outlined "Go back", 8 dp corners) and no emoji: the shield is
  the app's own line drawing (`ic_notify`) in the warning colour, the top row reads "Blocked · <site>", and the
  button says "Asked" / "Allowed" without a tick. It is a native screen, like the setup screens, so it uses the
  phone's own font, not the bundled Space Grotesk / Inter (those are web fonts for the pages). It needs no network
  to show. Layout, wording of the sentences and behaviour are the source's.
- **Launcher Check in block:** an inset block with a small pin drawing and three text buttons (no emoji); "I need
  help now" is outlined in the danger colour and fills when armed ("Tap again to send for help"). In the source the
  lock screen's block sat under its emergency button; here it is inside the "You can still reach family" card (the
  lock screen's emergency button is at the bottom in this launcher). In the old "Text family" list (apps without
  their own Texts screen) the block is hidden; it shows in the Phone menu. Sideways and wide, the three buttons sit
  in a row.
- **Sample data:** `&live` and `&noshare` were added to the browser preview.

## Line counts (lines the source added / removed → here)

| File | Source | Here |
| --- | --- | --- |
| `AndroidManifest.xml` | 8 / 1 | 8 / 1 |
| `BlockedActivity.kt` (new) | 119 | 128 (the re-skin) |
| `Where.kt` (new) | 214 | 214 |
| `core/WebFilter.kt` (new) | 38 | 38 |
| `test WebFilterTest.kt` (new) | 40 | 40 |
| `Kids.kt` | 76 / 2 | 76 / 2 |
| `KidsService.kt` | 9 / 1 | 9 / 1 |
| `LauncherActivity.kt` | 6 / 0 | 6 / 0 |
| `Policy.kt` | 12 / 4 | 12 / 4 |
| `SafeVpn.kt` | 10 / 1 | 10 / 1 |
| `SiteActivity.kt` | 6 / 9 | 6 / 9 |
| `Texts.kt` | 1 / 1 | 1 / 1 |
| `core/Models.kt` | 13 / 0 | 13 / 0 |
| `core/TextRules.kt` | 5 / 3 | 5 / 3 |

## Checked, and not

Still **not compiled**: there is no Android SDK on this machine. What ran:

- The pure-Kotlin tests with Gradle's bundled Kotlin 2.0.21 compiler (`core/*.kt` and the four test files; not the
  project's compiler, no serialization plugin): **40 tests, all passed** (the 37 from before plus WebFilterTest's 3).
- Every Kotlin file's `package` matches its folder; every `com.familyscreenwarden…` import resolves; every
  component in the manifest has a class; the four location permissions and the service's `location` type are in the
  manifest and match what `Policy.kt` grants and `KidsService.kt` starts; all XML and the workflow YAML parse.
- `node --check` on the four page scripts; the workflow's own page check passes here.
- No file, name or text in `android/`, `launcher/` or `.github/` mentions the source product or its game.
- Headless Chrome with the app's bridge stubbed, at 390x844, 844x390 and 1280x720: the Phone menu with the Check
  in block (sharing, live, the armed help button, sharing off), the lock screen, the home screen. The messages the
  page sent were read back (`checkin` with `ok` / `help`; the first tap on help sends nothing). No console errors
  from the page, no request outside the page, bundled fonts loaded.

Not checked, so the first CI build and a real phone are the test:

1. `Where.kt`, `BlockedActivity.kt` and the merged Android-facing files have not been through a compiler here.
2. Real positions, the foreground-service type on Android 14 and newer, background location, the ring, the blocked
   screen and its notification, Chrome's block list, the DNS filter with a real list.
3. The server side (written at the same time by someone else) was not tried against this app.
4. Play policy: background location and the `location` foreground-service type need a declaration if the app is
   ever listed in a store. It is not, today.
