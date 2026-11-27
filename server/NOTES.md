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
