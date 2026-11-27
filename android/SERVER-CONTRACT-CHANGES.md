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
