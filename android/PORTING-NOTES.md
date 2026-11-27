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
  APK and update downloads). All of it goes through `WardenApi.kt` (the comment at the top says so). `core/`
  (Engine, Models, Dns, SafeSearch, Sites, AppMatch, UnlockCodes) only lost the game's settings field.
- **The page ↔ app messages** are the same, minus the game's. Page → app: `hello`, `home`, `front`,
  `switch`, `dialog`, `launch`, `site`, `volume`, `power`, `call`, `call-answer`, `call-end`, `call-mute`,
  `call-speaker`, `text`, `emergency`, `pin`, `code`, `desktop`, `act` (`ask`, `chore`, `chat`, `look`), `parent`. App →
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
- **Phone bar:** Home, Call family, Text family (with a dot for a new text), Grown-up, as in the approved mockup.
  The clock, the time pill and the sound/Wi-Fi buttons left the phone bar (time is in the card at the top). "Power"
  (screen off, restart) and "Colours" moved to two quiet buttons at the bottom of the home screen.
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
