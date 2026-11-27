# Family Screen Warden

Screen-time rules for kids' Windows PCs and Android phones, run by parents from a web console.

| Folder | What it is |
|---|---|
| `server/` | Console server: parent API, device API, billing (Node 22, TypeScript, Express, Postgres 16). See `server/README.md`. |
| `web/` | Parent console (React + Vite). The server serves `web/dist` in production. |
| `site/` | Static sales site for familyscreenwarden.com (Cloudflare Pages, no build step). |
| `android/` | The kids' Android app (device owner). See `android/README.md`. |
| `launcher/` | The kid launcher page the Android app shows (and a Windows app will share). |
| `docs/mockups/` | The approved design mockups. |
| `SPEC.md` | The shared contract: data model, rules, API, design tokens. |

## Run it locally

```bash
cp server/.env.example .env      # then edit; never commit .env
docker compose up --build        # console on http://localhost:3000
```

With `DEV_LINKS=1` the sign-in page shows the sign-in link directly, so no email set-up is needed to try it.

Without Docker: start Postgres, then

```bash
cd web && npm ci && npm run build
cd ../server && npm ci && npm run build
DATABASE_URL=postgres://user:pass@localhost:5432/fsw DEV_LINKS=1 npm start
npm run seed                     # optional demo family (demo@example.com)
```

## Tests

```bash
cd server && npm test            # needs a Postgres it can create fsw_test in; see server/README.md
cd web && npm test
```

## Not done yet

- The Android app (`android/`) has not been compiled since it was brought into this repo; its first GitHub Actions build is the real test, and it has never run on a real phone against this server.
- There is no Windows app in this repo yet.
- Billing is switched off (`BILLING_ENABLED` unset). Stripe and Amazon SES have only been tested against stand-ins, never the real services.
- The Docker image has not been built or run.
- `site/privacy.html` and `site/terms.html` are drafts with placeholders and need a lawyer's review.
