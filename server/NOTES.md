# Server notes: where SPEC.md was read one way or another

Each point is the simplest reading that still keeps families' data safe.

## Sign-in

- **The account is created when the link is opened, not when it is asked for.** Otherwise anyone could
  start a trial clock for somebody else's email address.
- **The 6th link for one email inside an hour answers 429** (the spec says `{ok:true}` "always", and also
  "5 per email per hour"). The 429 is the same whether or not the family exists, so it reveals nothing.
- `devLink` is `PUBLIC_URL + /api/auth/verify?token=…`.
- Session cookies are hashed with HMAC-SHA-256 keyed by `SESSION_SECRET` (plain SHA-256 when no secret is
  set, which is only allowed outside production). Link tokens and device tokens use plain SHA-256.
- `PATCH /api/account` with `pin: null` (or `""`) removes the PIN.

## Rules

- **Bedtime windows.** Start later than end (20:30 → 06:00) crosses midnight, as in the spec. Two cases the
  spec does not cover: start before end with a start after noon (19:00 → 23:00) lies inside that evening;
  start before end with a start before noon (00:30 → 06:00) starts after midnight and belongs to the night
  before. Start equal to end is an empty window.
- **`rules.bedtime` in sync** is the window in force right now if there is one (so Saturday 06:30 reports
  Friday's 21:30 → 07:00), otherwise the one that starts this evening.
- **`bedtimeTonight` on the dashboard** is that window's start as `'HH:MM'`, or `null` when bedtime is off.
- Usage rows whose app was removed still count against the daily time.
- "Used up" for a per-app limit is worked out in the rules module; the API sends `usedMinutes` and
  `limitMinutes` (as the spec lists) and the device compares them.

## Parent API

- Changes answer with the changed thing: `{kid}`, `{app}`, `{contact}`, `{device}`, `{request}`,
  `{account}`; deletes and logout answer `{ok:true}`; grant answers `{ok:true, today}`; lock answers
  `{ok:true, kid, today}`; pause-all answers `{ok:true, pausedAll}`. Creates answer 201.
- Objects are the camelCase of the columns. Extras beyond the spec: kids in `GET /api/kids` carry `today`;
  devices carry `frontApp` and `createdAt`; `appLimits` entries carry `appId`; report `byApp` entries
  carry `free`.
- **`statusText`**: "Paused", "Locked by a parent", "Bedtime until HH:MM", "Time is up. Family calls still
  work", "Using <front app>" (a device seen in the last 3 minutes reports one), else "<time> left".
- **`familyPercent`** = minutes used ÷ minutes allowed today over all kids (each kid capped at its limit).
- **Week chart and report day totals leave out free apps** (they match what counts against the limit).
  Report `byApp` still lists free apps.
- `GET /api/reports` without `kidId` (or with an empty one) reports all kids together.
- **Identifiers**: sites are stored as a bare lower-case host (`https://www.Example.com/x` → `example.com`);
  Windows program names are lower-cased; Android package names are kept as sent.
- Adding an app that is already in the kid's list answers 409.
- **Deleting an app** removes today's minutes for it (the device reports day totals, so they come back if
  the app is still used) and keeps older days, shown as "Removed app" in reports.
- **Deleting a device** keeps its usage rows (device id set to null), so a kid cannot win time back by
  having a device removed. Deleting a kid deletes that kid's devices, apps, usage, contacts and requests.
- Answering a request twice gives 409.
- **Locked accounts**: besides `/api/me`, `GET /api/billing` and sign-out, `POST /api/billing/checkout`
  and `/portal` stay open, otherwise a locked family could not choose a plan.
- Caps not in the spec, against abuse: 20 kids, 50 devices, 3000 apps and 50 contacts per kid.

## Device API

- The device API keeps working for a locked account (the spec: "device rules keep working").
- `pair`: the `platform` sent must match the one the code was made for (400 otherwise, the code is not
  used up). A wrong or expired code answers 404.
- `sync`: "today" is the server's date in the family's time zone. Minutes above 1440 are cut to 1440.
  A `blocked[].at` in the future, older than a week or unreadable is stored as "now". The app list sent to
  a device holds apps for its own platform and `any`. Limits per sync: 1000 usage rows, 3000 installed
  rows, 200 blocked rows, 1 MB body (other routes: 100 kB).
- `request`: the 6th waiting request for a kid answers 429.
- `pin`: wrong PIN → 403 with `triesLeft`; no PIN set → 403; during the 5-minute lock-out → 429 with
  `retryAfterSeconds`. The count is per family, not per device.

## Billing

- Webhook: `active`, `trialing`, `past_due` → plan `active`. `canceled`, `unpaid`, `incomplete_expired`,
  `paused` or a deleted subscription → `trial` when the trial is still running, else `locked`; only the
  family's current subscription can end the plan. `checkout.session.completed` is handled too (it links
  the Stripe customer and subscription). Other events are accepted and ignored.
- `portal` before any checkout answers 400.
- Extra env settings: `TRUST_PROXY`, `WEB_DIST`, `NODE_ENV`, and `STRIPE_API_BASE` (tests only).

## Not done here

- No real call to Stripe or Amazon SES was made. Both were tested against stand-ins; the SES signer matches
  two official AWS SigV4 test vectors and the Stripe signature check follows Stripe's documented scheme.
- Rate limits per network address live in memory (one server process). The per-email link limit, the
  request limit and the PIN lock-out live in the database.
- No weekly report email; the spec has no route for it.


## Android phones, chores, the kid-device API (added later)

How the app's words and rules were fitted to this server. The app's code in `android/` and its launcher page in
`launcher/` were the contract.

### Time

- **The day runs midnight to midnight** in the family's time zone (`dayEndsAt` = the next local midnight,
  `resetHour: 0` in the pair answer).
- **Phones report seconds, the console counts minutes.** What a phone reports is kept as it came in
  `usage_seconds` (highest value wins) and turned into `usage` minute rows after every sync: one row per app
  (whole minutes) and one row without an app for the rest of the day's counted time (website tiles, rounding).
  So dashboard, reports and the simple `/api/device` API all see phone time, and phones see time used on devices
  that report minutes.
- **`paused` is always false.** In the app's words "paused" means the rules are off for a while. Warden's
  "pause all screens" is a lock, so it is sent as `locked: true`, like a parent's "lock now".
- **Bedtime** is sent as two instants (the window we are in, else the next one), read the same way as the rule
  engine reads start and end. The device locks itself between them.
- **Per-app limits** go out as `limitMinutes`; `budgeted` is always false and `allowance.appMinutes` is empty
  (Warden has no separate per-app time budget).

### Apps and websites

- **Only allowed apps are sent**, for the device's platform. The app key is the id of the app's row; `exes` holds
  the one identifier.
- **Apps the phone finds** (`installed`, and apps it closed) are added turned off, as with the simple API.
- **An app allowed by name** (a kid typed "Roblox" in "Ask a grown-up") and the same app reported by package are
  one row: whichever comes second joins the first (names are compared as slugs).
- **Categories** (`game`, `school`, `browser`, `video`, `other`) are guessed from the name when a phone reports an
  app. There is no console control for them yet.
- **Allowed websites** are sent as tiles (`tile` = the name). "Only allowed websites" off has no meaning on the
  phone: its built-in browser only ever opens listed sites.

### Setup

- **A setup code is for one kid** (the parent picks the kid in the console), so `setup/check` always answers
  `oneKid: true` with that kid. QR codes last 60 minutes; codes from `POST /api/devices/pairing-code` for Android
  work on the phone API too.
- `family` in `setup/check` is the parent's email address (accounts have no family name).
- **The same phone may pair again with its code** (same device row, new token, emergency counter back to 0).
- **The QR carries one checksum**: the signing certificate's when the publish step sent `X-Signature-Checksum`,
  otherwise the file's SHA-256.
- The quick-install link and the QR's admin extras use the key `server` for this server's address.
- The Wi-Fi password is only put into the QR; it is not stored or logged.

### Requests, chores, codes

- `POST /api/android/request` and the launcher's "ask" make ordinary requests. The same thing is not asked twice,
  a "no" stands for 12 hours, at most 5 wait per kid (the 6th gets `status: pending` with a message, not an error).
- **Chores**: `once` (gone the day after it was approved), `daily`, `weekly` (once per Monday-to-Sunday week).
  A chore marked done and not answered yet stays "waiting" however long it takes. Declined = to do again.
  Approval adds the minutes to the day of the approval, not the day the kid tapped. A chore worth 0 minutes is fine.
- `choreMinutes` in the launcher answer is 0, because every chore has its own minutes.
- **Bonus-time codes** (`/api/warden/redeem`): 8 characters, 24 hours, once. Redeeming also lifts the parent's
  "lock now" (the parent handed out the code), but not "pause all screens".
- **Emergency codes**: the device checks them by itself. At most 5 unused ones per device (the app only tries the
  next 10 counters). The per-device secret is stored as it is in `devices.unlock_secret` (not encrypted): a
  database leak would let someone work out codes for that device.
- **The PIN route** answers `{ok:false}` for a wrong PIN (200), 409 with no PIN, 429 in the lock-out; the same
  5-tries rule as `/api/device/pin`, counted per family.
- `launcher/act` with `action: parent` or `look` + `what: grownup` is trusted: the device checked the PIN.
  A modified app with a valid device token could skip that check.

### Family chat and texts

- **Family chat** is per family: every kid's launcher and the parent console. 300 characters; a kid may send 6 a
  minute, parents 20. Launchers get the last 40 messages of 7 days; the console shows 30 days; messages older than
  90 days are deleted. A parent can remove any message. There is no switch to turn the chat off.
- **Texts (SMS)**: the app is the phone's texting app now. It sends copies of texts in `sync` (`texts`), pictures
  through `text-media`, "ask to add a friend" (`/api/android/friend`), and reads `texting` back. See "Kids' photos,
  videos and texts" below.
- **Who is family and who is a friend.** The app has two lists: `phone.contacts` (family: texts and calls, and with
  `always` also while the phone is locked) and `texting.friends` (texts and calls, never while locked). Here family =
  contacts with "Call" on; friends = contacts with only "Text" on. So the two switches no longer mean exactly "can
  call" and "can text": a family contact can always be texted, a friend can also be called. The console says so.

### Files and publishing

- Files live under `DATA_DIR`: `releases/android/<version>.apk`, `apks/<id>.apk`, `text-media/<id>`,
  `kid-media/<account>/<kid>/<id>`.
  Uploads are streamed to disk through a `.part` file. Limits: app version 200 MB, APK 200 MB (20 per family),
  photo 8 MB.
- App versions are for the whole server, not per family. The newest 3 keep their file.
- `GET /internal/android/latest` needs no token (it shows a version number and checksums).

### Paywall switch

- The existing tests describe the paywall, so the test helper starts servers with `BILLING_ENABLED=1`;
  `test/android.test.ts` runs with the real default (off).
- With billing off a `locked` row is left as it is in the database and only shown as `trial`.

### Left out

- A game hero, a family feed and cheers: not in this product. Unknown launcher actions answer `{ok:false}`.
- `/api/warden/pair`, `/api/warden/request` and `/api/warden/download` (what a Windows app would use): not built;
  there is no Windows app yet.
- Remote "turn off" (`shutdown`) and "only watch" (`watchOnly`): always null.
- No email or push to parents when a kid asks for something or marks a chore done: it shows in the console only.
- There is still no "delete family" route. Photos, videos and pictures from texts of a family removed in the
  database are swept by housekeeping; APK files a removed family uploaded are not.
- The mock mode of the web app (`npm run dev:mock`) knows the Texts and Photos pages (pictures only, no videos); it
  does not know the phone, chores, chat or APK routes.


## Kids' photos, videos and texts (added with the app's Camera, Movie Maker and Texts)

The app's code in `android/`, its `SERVER-CONTRACT-CHANGES.md` and the server the app was first written for were the
contract. Every item of `SERVER-CONTRACT-CHANGES.md` has a test in `test/android.test.ts` or `test/media.test.ts`.

### Read one way or another

- **`X-FSW-Upload: 1` is required** on the two raw uploads (400 without), as the app sends it.
- **A file that is not what its type says answers 415, not 400.** The app retries a 400 for ever and sends nothing
  after it; on 415 it gives up on that one file and goes on.
- **Room used up answers 507**, which the app retries later, so uploads start again once a parent deleted something.
  Nothing is deleted automatically to make room (a kid could push older photos out by filling the room).
- **A phone reaches only what that phone uploaded** (looked up by device and the phone's id). A phone set up again
  after it was removed in the console is a new device: it cannot make links for its old uploads; the parents still see them.
- **Removing a phone keeps its copies** and the links already sent; removing the kid removes everything.
- **Links**: any item can get one (the app only asks for videos and movies). `PUBLIC_URL` is the link's address.
  Changing `SESSION_SECRET` does not break links already sent, but the next ask makes a new link. A parent ending a
  link is not told to the phone: the app keeps the old link and would text it again; it then shows "not working".
- **A parent's delete is not told to the phone either.** If the kid later shares that item, the app uploads it again.
- **Link pages keep working whatever the plan says** (like the device API).
- **Friend requests** are ordinary requests of kind `contact`; yes makes a text-only contact (a friend). The contact's
  number is stored as digits; the request keeps the number as typed for the parent to read.
- **`texting.asked[].phone`** is the number's digits (the app compares digits).
- **Held texts** are not listed among the chats until the phone reports them as shown.
- **Limits chosen here**: 200 MB a file, 5 GB a kid (`KID_MEDIA_QUOTA_MB`), 300 uploads an hour and 60 link asks an
  hour per phone, 240 link-page requests a minute per address; pictures in texts 8 MB each, 1 GB a kid; 90 days.
  The app stops a recording at 300 MB, so a recording between 200 and 300 MB is never copied (413).
- **No thumbnails**: the gallery shows the photos themselves and each video's first frame.
- **The demo family** gets texts, photos and videos only when the seed is given a data folder (`npm run seed` does).

### Left out, because this product does not have them

- **The family screen** (a wall screen or kiosk showing a slideshow) and its approval: `family-screen` answers
  `{status:'unavailable', message}`; no `familyScreen` field in the gallery, no yes / no for it.
- **Family photos / the photo frame** (a kid's photo going into the family's shared photos).
- **One-tap answer links** from emails or push messages for friend requests (there are no notifications; a parent
  answers in the console), and the note to parents when a stranger's text is held.
- **A parents' control for sound, screen or rotation**: the app keeps those on the phone and sends nothing.
