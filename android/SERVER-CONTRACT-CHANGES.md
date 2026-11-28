# What the server must answer for this version of the app

This lists every server call that is new or changed in this update of the kids' phone app (Camera, My photos and
Movie Maker; the in-app Texts; friends). Everything else is as before (see README.md, "How the app talks to the
server"). All calls are made in one file, `app/src/main/java/com/familyscreenwarden/kids/WardenApi.kt`.

Auth for every call below: `Authorization: Bearer <the phone's token from POST /api/android/pair>`. The app also sends
`Accept: application/json`. Errors are read as `{ "error": "words for the kid" }` with a 4xx/5xx status.

## Where this differs from the earlier app's contract (read this first)

| What | In this app | Why |
| --- | --- | --- |
| **Upload marker header** on the two raw uploads | **`X-FSW-Upload: 1`** | The earlier header carried the earlier product's name. `X-FSW-Upload` is the header this server already uses for APK uploads from the console. |
| Path prefix shared with the Windows app | `/api/warden/...` | As in the first port. `/api/android/...` is unchanged. |

Nothing else differs: no JSON field, query name, path segment or status code was renamed. The `X-Media-*` headers,
all bodies and all answers are the same shapes the earlier app used.

One thing changed inside the app only: the camera upload used to open its own connection; it now goes through
`WardenApi.sendFile`. The request on the wire is the same (same headers, same raw body).

## New calls

### 1. `POST /api/android/media` — a photo, video or movie from the camera (raw upload)

- **When:** with the 15-second upkeep while paired (oldest first, at most 3 per round), right after the kid makes one,
  and on demand before a link or a family-screen ask. Deleted items are uploaded too.
- **Body:** the raw file (not JSON, not multipart), streamed with `Content-Length`. The app stops a recording at
  300 MB; the earlier server refused more than 200 MB with 413.
- **Headers:**

  | Header | Value |
  | --- | --- |
  | `X-FSW-Upload` | `1` |
  | `Content-Type` | the file's type: `image/jpeg`, `video/webm` or `video/mp4` (a `;codecs=…` part is cut off by the app) |
  | `X-Media-Id` | the phone's id for the item (a UUID). The key for every later call about it. |
  | `X-Media-Kind` | `photo`, `video` or `movie` |
  | `X-Media-Title` | the title, UTF-8 then base64 (may be empty) |
  | `X-Media-At` | when it was made, milliseconds since 1970 |
  | `X-Media-Duration` | whole seconds (`0` for a photo) |

- **Answer:** the app reads only the status.

  | Status | What the app does |
  | --- | --- |
  | `200`, `201`, `409` | marks it uploaded (the earlier server answered `201 { ok: true, id }`, or `200 { ok: true, id }` when it already had that `X-Media-Id`) |
  | `413`, `415` | never tries this file again |
  | anything else, or no connection | stops for now and tries again at the next upkeep |

### 2. `POST /api/android/media/:mediaId/deleted`

- **When:** the kid deleted an item that was uploaded (next upkeep). `:mediaId` is the `X-Media-Id`.
- **Body:** `{}`.
- **Answer:** any 2xx (earlier: `{ ok: true }`). `404` also counts as done. Anything else: tried again later. The
  phone removes its own file only after this. Grown-ups keep seeing the item in the parent console.

### 3. `POST /api/android/media/:mediaId/link`

- **When:** the kid taps "Send in Texts" on a video or movie (they go as a link; picture texts can't carry them).
- **Body:** `{}`.
- **Answer:** `{ "link": "https://…" }`: an address anyone with the link can open to watch it. The app puts the link
  in a text ("Mia made a video for you: <link>") and keeps it. Earlier the link was `<server>/m/<token>`, good for
  30 days, renewed when asked again; the server must serve that page itself (the app never opens it).
- `404` means the server doesn't have the file: the app uploads it (call 1) and asks once more.

### 4. `POST /api/android/media/:mediaId/family-screen`

- **When:** "Show on the family screen" after a movie is made.
- **Body:** `{}`.
- **Answer:** `{ "message": "words for the kid" }` (shown as they are; "Sent to the family screen." when missing).
  Earlier a grown-up had to say yes first and the message said so. `404`: upload, then once more. Errors: the
  `error` text is shown.

### 5. `POST /api/android/text-media/:msgId/:mediaId` — a photo in a text (raw upload)

- **When:** after a sync that reported a text with photos (call 7), for each photo the server doesn't have yet.
  `:msgId` is the text's `id`, `:mediaId` the `id` in its `media` list.
- **Body:** the raw file. **Headers:** `X-FSW-Upload: 1`, `Content-Type` (`image/jpeg` for sent photos; whatever
  arrived for received ones, `image/*`, `video/*` or `audio/*`).
- **Answer:** any 2xx = done (earlier `201 { ok: true, id }`). `400`, `413`, `415` = not tried again. Anything else:
  tried again after the next sync.

### 6. `POST /api/android/friend` — "Ask to add a friend"

- **When:** the kid fills in the form in Texts.
- **Body:** `{ "name": "Ava", "phone": "(555) 014-2290", "note": "She's in my class" }` (`note` left out when
  empty; name ≤ 60, phone ≤ 30, note ≤ 200 characters).
- **Answer:** `{ "status": "pending" | "approved" | "denied", "message": "words for the kid" }`. The app shows
  `message` ("Sent to your grown-ups." when missing) and syncs soon after.

## Changed calls

### 7. `POST /api/warden/sync` — two additions

**Request, new optional field `texts`** (only present when there is something to report; at most 50 per sync):

```json
"texts": [{
  "id": "uuid on the phone",
  "thread": ["+15550102231", "(555) 010-2232"],
  "dir": "in" | "out",
  "from": "+15550102231",
  "body": "the words",
  "at": 1764200000000,
  "status": "shown" | "waiting" | "held",
  "media": [{ "id": "uuid", "type": "image/jpeg" }]
}]
```

- `thread`: the other people's numbers as they came (not the kid's own). `from` is only there for `in`.
- `status`: `shown` (family or an approved friend; always for `out`), `waiting` (a friend's text during bedtime or
  time's up), `held` (a number that isn't on the lists: the kid doesn't see it; it is for the grown-ups).
- The same `id` is sent again when its status changes (`held`/`waiting` → `shown`), so the server should upsert by
  `id`. The app treats a 2xx sync answer as "the server has these".
- Blocked numbers' texts are dropped on the phone and never reported.

**Answer, new optional object `texting`** (the app works without it):

```json
"texting": {
  "friends": [{ "id": "…", "name": "Jake", "phone": "555-016-4410" }],
  "asked":   [{ "name": "Ava", "phone": "555-014-2290", "status": "pending" | "denied" }],
  "blocked": ["5550001111"],
  "drop":    ["<text id>", "…"]
}
```

- `friends`: people a grown-up said yes to. The kid can text and call them, except while the phone is locked.
- `asked`: friend requests not (or not favourably) answered; shown in Texts as "Waiting…" / "A grown-up said no".
- `blocked`: numbers whose texts the phone drops (and deletes any it still holds unseen).
- `drop`: ids of texts a grown-up deleted in the parent console; the phone deletes them.
- Numbers are matched by their digits (the last 10 when there are more).

The sync's `phone.contacts` (family, with `always`) is unchanged and is also who the kid can text.

### 8. Launcher state and actions (no server change)

`POST /api/warden/launcher` and `POST /api/warden/launcher/act` are unchanged. The new things the launcher page
shows (friends, recent calls, Sound and screen, the Texts badge) come from the phone itself.

The grown-up menu has one new option, "Let the screen turn with the phone". It is handled on the phone after the PIN
check and sends nothing new to the server (the PIN is checked with `POST /api/warden/pin` as before).

## Not called by this app

Family feed, cheers, the earlier product's game and its 3D models: still removed.

---

# 28 November: levels and shared safe browsing, texting by level, location (live map, Check in, Ring phone)

Everything above still holds. This section lists every call, field and shape that is new or changed in this update.
Auth, error shape and the `Accept` header are as above (`Authorization: Bearer <the phone's token>`).

## Where this differs from the earlier app's contract (read this first)

**Nothing on the wire differs.** Every path, field name, value and answer below is the earlier app's, with
`/api/warden/...` where it had its shared prefix. No name in this update carried the earlier product's name, so none
was changed. Inside the app only: the calls go through `WardenApi.post`, and one private variable in `Where.kt` was
renamed (`liveFromServer`).

One thing to know rather than a difference: the pref file `where` (key `ring`) and the notification channel `kids`
are the earlier names and say nothing about the earlier product, so they were kept.

## New calls

### 9. `POST /api/android/location`: where the phone is

- **When:** only when the phone is paired, has the location permission, and the last sync answer did not say
  `location.sharing: false`. One position every 5 minutes; while "live" (see `location.live` below, this call's own
  answer, or 30 minutes after a "pickup" / "help" check-in) one call about every 5 seconds with the positions since
  the last call. Positions that could not be sent (offline) wait in memory, at most 30, and go with the next call.
- **Body:**

  ```json
  { "fixes": [ { "lat": 41.8781, "lng": -87.6298, "accuracy": 12.5, "at": "2026-11-28T15:04:05Z", "battery": 81, "charging": false } ] }
  ```

  1 to 30 fixes, oldest first. `accuracy` (metres) is left out when Android gives none. `at` is the fix's own time
  (ISO 8601, UTC). `battery` is 0 to 100.
- **Answer:** `{ "sharing": true, "live": false }`. The app reads only `live`: `true` keeps the 5-second updates
  going until an answer (or a sync) says otherwise. Any 2xx counts as sent. On an error or no connection the app
  keeps the newest 10 and tries again 5 seconds later (there is no back-off: answer 2xx with
  `{ "sharing": false, "live": false }` when sharing is off rather than an error).

### 10. `POST /api/android/checkin`: "I'm here and I'm OK" / "Please come get me" / "I need help now"

- **When:** the kid taps one of the three buttons in the Phone menu or on the lock screen ("help" needs two taps).
- **Body:** `{ "kind": "ok" | "pickup" | "help", "lat": 41.8781, "lng": -87.6298, "accuracy": 12.5 }`. `lat`, `lng`
  and `accuracy` are left out when the phone has no position (no permission, or none found in 20 seconds).
- **Answer:** `{ "message": "words for the kid" }`, shown as a toast as they are ("Sent." when missing). The earlier
  server answered `{ ok: true, id, message }` and, for the same kind twice within a minute,
  `{ ok: true, message: "Sent already. Your grown-ups have it." }`. Errors: the `error` text is shown; with no
  connection the kid reads "Can't reach Family Screen Warden. Call a grown-up instead."
- After "pickup" or "help" the phone sends live positions (call 9) for 30 minutes on its own, whatever the server
  says, unless sharing is off.

## Changed calls

### 11. `POST /api/android/request`: now also a blocked website

- **When (new):** "Ask a grown-up" on the "This site is blocked" screen.
- **Body (new form):** `{ "site": "tiktok.com" }` (the host as the phone saw it; from the built-in browser it can still carry `www.` or capitals, so clean it). The app form
  `{ "package": "...", "name": "..." }` is unchanged.
- **Answer:** the same `{ "status": "sent" | "pending" | "allowed" | ..., "id": "...", "message": "..." }` as for an
  app. With `sent` / `pending` and an `id` the app remembers the request (as `site:<host>`) and syncs soon after;
  `message` is shown under the button. A yes should put the site on the kid's `sites` list (on every device).

### 12. `POST /api/warden/sync`: one new request field, three additions to the answer

**Request, new field `blockedSites`** (always present, may be empty; at most 40, newest first; the last 24 hours):

```json
"blockedSites": [ { "host": "tiktok.com", "at": "2026-11-28T15:04:05Z" } ]
```

It is the whole current list every time (replace, don't append). `host` ≤ 200 characters.

**Answer, new object `web`** (safe browsing, the same object the Windows app gets; when missing the app behaves as
before: only the kid's sites):

```json
"web": { "mode": "sites" | "filtered" | "open", "block": ["tiktok.com", "…"], "words": ["casino", "…"] }
```

- `sites`: only the hosts in the kid's `sites` (in their hours). `block` and `words` are not used.
- `filtered` / `open`: anything except a host in `block` (subdomains too) or a name with one of `words` as a whole
  part between dots or hyphens. The app treats the two modes alike; the server sends the right `block` / `words`
  for each. The kid's `sites` always win, in their hours.
- Where it is applied: the DNS filter for every app (only in `filtered` / `open`), the built-in browser, and Chrome's
  policies (`URLBlocklist` = the first 1000 of `block` in `filtered` / `open`; `words` can't be given to Chrome).

**Answer, new object `location`** (when missing: sharing is on, not live, no ring):

```json
"location": { "sharing": true, "live": false, "ring": "id-or-null" }
```

- `sharing: false` stops all location calls and hides the Check in block.
- `live: true` while a grown-up has the map open: positions every 5 seconds, and the kid's Phone menu says so.
- `ring`: an id that changes with every Ring phone. A new id (not the one the phone rang for last, kept across
  restarts) rings loudly for 30 seconds, even on mute. Send `null` once the ring is old, or the same id; the phone
  rings once per id.

**Answer, new field `texting.who`**: `"family" | "friends" | "anyone"` (default `"friends"`, the behaviour before).
`family`: approved friends don't count (their texts are held). `anyone`: texts from unknown numbers are shown
(status `shown` in the sync's `texts`) instead of held; `blocked` still wins.

### 13. Launcher state (no server change)

`POST /api/warden/launcher` and `/launcher/act` are unchanged. The page gets `phone.location = { sharing, live }`
from the phone itself (`sharing` is the server's flag and the permission together). New page → app messages:
`checkin` with `kind` (`ok` | `pickup` | `help`), and `stop-ring` (the app accepts it; the page does not send it
yet, as in the earlier app).
