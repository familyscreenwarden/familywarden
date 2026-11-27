# Family Screen Warden: server

The console server: parent API, device API, billing, and (when it is built) the parent web app.
Node 22, TypeScript, Express, Postgres 16. No ORM.

## Run it on your machine

You need Node 22 and a Postgres 16 database.

1. Install:
   ```
   cd server
   npm install
   ```
2. Make an empty database (once):
   ```
   createdb fsw
   ```
3. Build:
   ```
   npm run build
   ```
4. (Optional) load the demo family, `demo@example.com`, with two kids, three devices, a week of data, and texts, photos and videos for the kid with a phone (set the same `DATA_DIR` and `SESSION_SECRET` as for the server):
   ```
   DATABASE_URL=postgres://postgres@127.0.0.1:5432/fsw npm run seed
   ```
   It can be run again at any time; it rebuilds the demo family and touches nothing else.
5. Start:
   ```
   DATABASE_URL=postgres://postgres@127.0.0.1:5432/fsw DEV_LINKS=1 npm start
   ```
   The tables are created on the first start. The server listens on port 3000.
6. Check it:
   ```
   curl http://localhost:3000/healthz
   ```
   Answer: `{"status":"ok","db":true}`

### Signing in while developing

With `DEV_LINKS=1`, asking for a sign-in link returns it in the answer, so no email is needed:

```
curl -X POST http://localhost:3000/api/auth/request-link \
     -H 'content-type: application/json' -d '{"email":"demo@example.com"}'
```

Open the `devLink` in your browser. Without `DEV_LINKS` and without Amazon SES settings, the link is
written to the server log instead.

If `../web/dist` exists (run `npm run build` in `web/`), the server serves the web app at
`http://localhost:3000/`. When you run the web app with `npm run dev` instead (port 5173), start the server
with `PUBLIC_URL=http://localhost:5173` so sign-in links point at it.

## Settings

Copy `.env.example` and fill it in, or set the same names in the environment. The server does not read a
`.env` file by itself; with Node 22 you can use `node --env-file=.env dist/index.js`.

| Name | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no (3000) | Port to listen on |
| `PUBLIC_URL` | in production | Address of the console, e.g. `https://app.familyscreenwarden.com` |
| `SESSION_SECRET` | in production | Long random string (`openssl rand -hex 32`). Changing it signs everyone out. Also the key for kids' share links |
| `NODE_ENV` | in production | `production` turns on Secure cookies, HSTS and the Origin check |
| `TRUST_PROXY` | behind a proxy | Number of proxies in front (usually `1`), for correct per-address rate limits |
| `DEV_LINKS` | no | `1` returns the sign-in link in the API answer. Never in production |
| `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `MAIL_FROM_EMAIL` | for email | All four set: sign-in links go out through Amazon SES |
| `STRIPE_SECRET_KEY` | for billing | Without it the billing buttons answer 503 |
| `STRIPE_WEBHOOK_SECRET` | for billing | Signing secret of the webhook endpoint |
| `WEB_DIST` | no | Folder with the built web app (default `../web/dist`) |
| `BILLING_ENABLED` | no (off) | `1` switches the trial and Stripe billing on. Off: no paywall, nobody is locked |
| `DATA_DIR` | in production | Folder for files: published app versions, uploaded APKs, kids' photos and videos, photos from texts (default `./data`, `/data` in Docker). Put it on a disk that is kept, with room for the videos |
| `KID_MEDIA_QUOTA_MB` | no (5120) | Room for one kid's photos and videos, in megabytes. Full: new ones are not copied until a parent deletes some |
| `PUBLISH_TOKEN` | to publish the Android app | Secret GitHub Actions sends to `POST /internal/android/publish`. 32+ characters (`openssl rand -hex 32`) |

Secrets never go in the repo.

### Stripe set-up

1. Make one product with two prices and give the prices the lookup keys `fsw_family_month` ($4 a month)
   and `fsw_family_year` ($36 a year).
2. Add a webhook endpoint `https://<your console>/stripe/webhook` for the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and
   `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Turn on the customer portal in Stripe.

## Tests

The tests need a Postgres database they may wipe. The name must contain `_test`.

```
createdb fsw_test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/fsw_test npm test
```

- `test/rules.test.ts`: the rule evaluation (limits, grants, free apps, bedtime, lock reasons).
- `test/crypto.test.ts`: hashes, PINs, pairing codes, the Stripe signature check, the AWS signer.
- `test/integration.test.ts`: the real app on a real database, end to end.
- `test/compat.test.ts`: the pure helpers of the kid-device API (time zones, bedtime instants, chores, codes, the setup QR).
- `test/android.test.ts`: a phone walked through setup, sync, launcher, requests, chores, chat, texts, photos and videos, APK pushes and updates.
- `test/media.test.ts`: kids' photos, videos and texts: what is kept, the limits, and who can reach what (families, siblings, phones, share links).
- `test/media-unit.test.ts`: file signatures, paths, Range, share tokens, the sweep of ownerless files.

`npm run test:unit` runs the unit tests (rules, crypto, compat, media) without a database. `npm run typecheck` checks source and tests.

## Docker

Build from the repo root (so the web app is built into the image too):

```
docker build -f server/Dockerfile -t family-screen-warden .
docker run -p 3000:3000 -v fsw-data:/data \
  -e DATABASE_URL=postgres://user:password@db-host:5432/fsw \
  -e PUBLIC_URL=https://app.familyscreenwarden.com \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e TRUST_PROXY=1 \
  family-screen-warden
```

## Where things are

| File | What |
| --- | --- |
| `src/rules.ts` | Rule evaluation, a pure function |
| `src/migrations.ts` | The database schema, as ordered migrations applied at start-up |
| `src/routes/auth.ts` | Email-link sign-in, `/api/me`, account settings |
| `src/routes/parent.ts` | Dashboard, kids, apps, contacts, devices, requests, reports |
| `src/routes/device.ts` | Pairing, sync, kid requests, PIN check (the simple device API) |
| `src/routes/compat.ts`, `src/compat/logic.ts` | The kid-device API the Android app speaks (`/api/warden`, `/api/android`) |
| `src/routes/phone.ts` | Parent routes for phones: setup QR, phone rules, chores, family chat, texts, APKs, codes |
| `src/routes/media.ts`, `src/media.ts` | Kids' photos and videos: uploads from the phone, share links (`/m/<token>`), the parents' gallery |
| `src/releases.ts`, `src/files.ts` | Publishing and serving the Android app; files under `DATA_DIR` |
| `src/routes/billing.ts`, `src/stripe.ts` | Billing routes, Stripe calls and webhook check |
| `src/mail.ts` | Amazon SES email, signed by hand |
| `src/seed.ts` | Demo data |
| `NOTES.md` | How unclear points of SPEC.md were read |
