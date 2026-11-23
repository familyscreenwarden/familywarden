# Family Screen Warden: build spec

Family Screen Warden is a parental screen-time product. Kid devices (a Windows app and an Android app, built elsewhere) enforce rules. This repo holds:

- `server/` the console server (Node 22, TypeScript, Express, `pg`, Postgres 16). It serves the parent API, the device API and, in production, the built web app.
- `web/` the parent console (React 18 + Vite + TypeScript). Works on phones.
- `site/` the static sales site (plain HTML/CSS, no build step), for Cloudflare Pages at familyscreenwarden.com.
- `docs/mockups/` the approved mockups (`*.dc.html`; read the markup inside `<x-dc>` for layout, colours and copy. Ignore the `support.js` and `text/x-dc` script parts).

One shared multi-tenant server: every row belongs to an `account` (a family). Every query must be scoped by the signed-in account. No row of one account may ever be readable or writable by another.

## Product facts (use these exact facts in copy; do not invent others)

- Name: Family Screen Warden. Domain: familyscreenwarden.com. Console at `app.familyscreenwarden.com`.
- Price: one plan, $4/month or $36/year per family, unlimited kids and devices. 30-day free trial, no card needed.
- After the trial ends without a plan: the account is locked (console shows "choose a plan"); device rules keep working with the last settings.
- Kid devices: Windows PCs and Android phones. Android setup needs a factory reset and a QR code (device-owner mode). No iPhone/iPad, Mac or Chromebook support.
- Features: daily time limits (school days / weekends), bedtime, per-app limits, "free" apps that never count, allowed-websites-only browsing, SafeSearch, YouTube Restricted Mode, kids can ask for more time or a new app and a parent answers from the console, pause all screens, family contacts that can always be called or texted on the phone, emergency calls always work, weekly reports, blocked-site log.
- Time only counts while an app or website is open. The home screen and family calls are free.
- Sign-in: email link. No passwords.
- Kids Quest (kidsquestgame.win) is a separate free kids' game that may be *recommended*; it is not part of this product.
- No testimonials, user counts, awards, or statistics. None exist. Do not invent any.

## Design tokens (dark dashboard style)

- Page backdrop `#0c1a2e`; app window `#04060f` with 1px border `#141b3f`, radius 24px; card `#080c22`, 1px border `#141b3f`, radius 10px, padding 20px; inset row `#0e1433`, radius 8px.
- Text `#eef1fb`; muted `#8e9ac0`; divider `#141b3f`; control border `#2a3468`.
- Accent green `#34d399` (dark text `#06281c` on it); periwinkle `#4f61b8` (white text on it), chart line periwinkle `#6f82de`; deep green `#1f6f56`; warning `#fbbf24` (text `#3b2a00`); danger border `#f87171`, danger text `#fca5a5`.
- Fonts: headings and big numbers "Space Grotesk" (400/500/600), body "Inter" (400/500/600). Page title 30px weight 400. Card titles 14px, weight 500, uppercase, letter-spacing 0.06em. Body 14px.
- Buttons min-height 44px, radius 8px. Primary = green; secondary = periwinkle; ghost = transparent with `#2a3468` border; danger = transparent with red border.
- Small pill tags: radius 5px, padding 2px 8px, 12px text.
- Logo: a shield outline with a circuit trace forming an S and two round nodes, stroke `#34d399`:
  `<svg viewBox="0 0 120 140"><path d="M60 8 L112 26 V68 C112 100 90 122 60 132 C30 122 8 100 8 68 V26 Z" fill="none" stroke="#34d399" stroke-width="9" stroke-linejoin="round"/><path d="M82 46 H46 V68 H74 V92 H38" fill="none" stroke="#34d399" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="82" cy="46" r="6" fill="#04060f" stroke="#34d399" stroke-width="4"/><circle cx="38" cy="92" r="6" fill="#04060f" stroke="#34d399" stroke-width="4"/></svg>`
- Accessibility: real `<button>`, `<a>`, `<label>`+inputs; text contrast at least 4.5:1; never colour alone to carry meaning; works at 360px wide (sidebar becomes a top/bottom menu, tables scroll in a box). No emoji as icons.

## Data model (Postgres)

All ids are UUIDs (`gen_random_uuid()`), all timestamps `timestamptz`. Minutes are integers. Clock times are `'HH:MM'` text in the family's time zone.

- `accounts`: id, email (unique, stored lower-case), timezone (IANA, default `America/Denver`), plan (`trial` | `active` | `locked`), trial_ends_at, stripe_customer_id, stripe_subscription_id, parent_pin_hash (nullable), paused_all (bool), created_at.
- `login_tokens`: token_hash (pk), email, expires_at (15 min), used_at.
- `sessions`: token_hash (pk), account_id, created_at, expires_at (30 days), last_seen_at.
- `kids`: id, account_id, name, color (hex), limit_school_minutes (default 120), limit_weekend_minutes (default 180), bed_school_start `'20:30'`, bed_school_end `'06:00'`, bed_other_start `'21:30'`, bed_other_end `'07:00'`, bedtime_enabled (bool), only_allowed_sites, safe_search, youtube_restricted, block_private (bools, default true), locked (bool, parent "lock now"), created_at.
- `devices`: id, account_id, kid_id, name, platform (`windows` | `android`), model, os_version, app_version, token_hash (unique), last_seen_at, front_app (text, nullable), created_at.
- `pairing_codes`: code (pk, 8 chars, upper-case letters and digits without 0/O/1/I), account_id, kid_id, platform, expires_at (30 min), used_at.
- `apps`: id, account_id, kid_id, kind (`app` | `site`), platform (`windows` | `android` | `any`), identifier (exe name, Android package, or host), name, allowed (bool), free (bool; never counts against time), limit_minutes (nullable = no own limit), created_at. Unique (kid_id, kind, identifier).
- `usage`: kid_id, device_id, app_id (nullable), day (date, family time zone), minutes. Unique (device_id, app_id, day). Device reports are *totals for that day*, so upsert with `GREATEST`.
- `time_grants`: id, kid_id, day, minutes, reason, created_at. Extra minutes for that day.
- `requests`: id, account_id, kid_id, device_id, kind (`time` | `app` | `site`), minutes (for time), detail (app name or host), identifier (nullable), status (`pending` | `approved` | `denied`), created_at, decided_at.
- `contacts`: id, account_id, kid_id, name, phone, can_call, can_text.
- `blocked_events`: id, account_id, kid_id, device_id, host, at.

Approving a request: `time` adds a `time_grants` row for today; `app`/`site` upserts an `apps` row with allowed = true.

### Rule evaluation (pure function, unit-tested)

For a kid at time *now* in the account's time zone:

- School day = Monday to Friday. "School night" bedtime applies on nights before a school day (Sunday to Thursday nights); "other" on Friday and Saturday nights. A bedtime window crosses midnight: it runs from start on its evening until end the next morning.
- `limit` = school or weekend limit + today's grants. `used` = sum of today's usage minutes over all devices, excluding apps marked free. `left` = max(0, limit - used).
- `lockReason` priority: `paused` (account.paused_all) > `parent` (kid.locked) > `bedtime` > `time` (left = 0) > null. `locked` = lockReason is not null.
- Per app: `usedMinutes` today; an app with `limit_minutes` is used up when its own minutes reach it.

## HTTP API

JSON everywhere. Errors: `{ "error": "plain sentence a parent can read" }` with a fitting status. Validate every body; reject unknown ids with 404 (also when the id belongs to another account).

### Parent API (cookie session `fsw_session`, httpOnly, SameSite=Lax, Secure in production)

Auth
- `POST /api/auth/request-link` `{email}` → `{ok:true}` always (never reveal whether an account exists). Creates the account on first use with a 30-day trial. Sends the email through Amazon SES when `AWS_SES_*` is set; otherwise logs the link. When `DEV_LINKS=1` the response also carries `devLink`. Rate-limit: 5 per email per hour.
- `GET /api/auth/verify?token=…` → sets the cookie, 302 to `/`. A used or expired token → 302 to `/signin?error=expired`.
- `POST /api/auth/logout` → `{ok:true}`.
- `GET /api/me` → `{account:{id,email,timezone,plan,trialEndsAt,trialDaysLeft,pausedAll,hasPin}}` or 401.
- `PATCH /api/account` `{timezone?, pin?}` (pin = 4 to 8 digits, stored hashed).

Dashboard
- `GET /api/dashboard` →
  ```
  { kids: [{id,name,color,limitMinutes,usedMinutes,leftMinutes,locked,lockReason,statusText,bedtimeTonight}],
    devices: [{id,name,platform,model,osVersion,appVersion,kidId,kidName,status,lastSeenAt}],   // status: in_use | locked | off (off = not seen for 3 minutes)
    requests: [pending requests, newest first, with kidName, deviceName],
    week: [{day:'YYYY-MM-DD', minutes:{<kidId>: n}}],        // last 7 days, oldest first
    blocked: [{day, count}],                                  // last 7 days
    appLimits: [{kidId,kidName,appName,usedMinutes,limitMinutes}],
    familyPercent: n, pausedAll: bool }
  ```
- `POST /api/pause-all` `{paused}`.

Kids
- `GET /api/kids` → `{kids:[…]}`; `POST /api/kids` `{name,color?}`.
- `GET /api/kids/:id` → `{kid, apps:[… with usedMinutes today], contacts:[…], today:{limitMinutes,usedMinutes,leftMinutes,locked,lockReason}}`.
- `PATCH /api/kids/:id` any kid field; `DELETE /api/kids/:id`.
- `POST /api/kids/:id/grant` `{minutes}` (1 to 240); `POST /api/kids/:id/lock` `{locked}`.
- `POST /api/kids/:id/apps` `{kind,platform?,identifier,name,allowed?,free?,limitMinutes?}`; `PATCH /api/apps/:id`; `DELETE /api/apps/:id`.
- `POST /api/kids/:id/contacts` `{name,phone,canCall?,canText?}`; `PATCH /api/contacts/:id`; `DELETE /api/contacts/:id`.

Devices
- `GET /api/devices`; `POST /api/devices/pairing-code` `{kidId,platform}` → `{code,expiresAt}`; `PATCH /api/devices/:id` `{name?,kidId?}`; `DELETE /api/devices/:id`.

Requests
- `GET /api/requests?status=pending|all`; `POST /api/requests/:id/decide` `{approve}`.

Reports
- `GET /api/reports?kidId=&days=7|30` → `{days:[{day,minutes,byApp:[{name,minutes}]}], blocked:[{host,count,lastAt}]}`.

Billing
- `GET /api/billing` → `{plan,trialEndsAt,trialDaysLeft,prices:{month:4,year:36},stripeReady}`.
- `POST /api/billing/checkout` `{interval:'month'|'year'}` → `{url}` (Stripe Checkout session, prices found by lookup keys `fsw_family_month` / `fsw_family_year`); 503 with a clear message when `STRIPE_SECRET_KEY` is not set.
- `POST /api/billing/portal` → `{url}`.
- `POST /stripe/webhook` (raw body, signature checked with `STRIPE_WEBHOOK_SECRET`): subscription created/updated/deleted set `plan`.
- A background check moves `trial` accounts past `trial_ends_at` to `locked`. A `locked` account can still read `/api/me`, `/api/billing` and sign out; every other parent route answers 402 `{error, locked:true}`.

### Device API (header `Authorization: Bearer <device token>`)

- `POST /api/device/pair` (no auth) `{code,name,platform,model?,osVersion?,appVersion?}` → `{deviceToken,deviceId,kid:{id,name,color}}`. The code is single-use.
- `POST /api/device/sync` `{appVersion?, frontApp?, usage:[{kind,identifier,name,minutes}], blocked:[{host,at}], installed:[{kind,identifier,name}]}` (all optional) →
  ```
  { serverTime, kid:{id,name,color},
    rules:{ limitMinutes, usedMinutes, leftMinutes, locked, lockReason,
            bedtime:{enabled,start,end},            // tonight's window
            apps:[{kind,platform,identifier,name,allowed,free,limitMinutes,usedMinutes}],
            safe:{onlyAllowedSites,safeSearch,youtubeRestricted,blockPrivate},
            contacts:[{name,phone,canCall,canText}] } }
  ```
  `usage` minutes are totals for today per app on this device. Unknown apps in `usage`/`installed` are added as `apps` rows with allowed = false (so the parent can see and allow them), except that usage is still recorded. Updates `last_seen_at`, `front_app`.
- `POST /api/device/request` `{kind,minutes?,detail?,identifier?}` → `{id,status}`; at most 5 pending per kid.
- `GET /api/device/requests/:id` → `{id,status}`.
- `POST /api/device/pin` `{pin}` → `{ok:true}` or 403; 5 wrong tries lock PIN checks for 5 minutes.

### Other

- `GET /healthz` → `{status:'ok', db:true}`.
- In production the server serves `web/dist` and falls back to `index.html` for non-API paths.

## Config (env)

`DATABASE_URL`, `PORT` (3000), `PUBLIC_URL` (e.g. `https://app.familyscreenwarden.com`), `SESSION_SECRET`, `DEV_LINKS`, `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `MAIL_FROM_EMAIL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Secrets never go in the repo: ship `.env.example` only.
