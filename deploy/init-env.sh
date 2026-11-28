#!/usr/bin/env bash
# Creates deploy/.env with fresh random secrets. Safe to run again: it never overwrites an existing file.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then echo "deploy/.env already exists; leaving it alone."; exit 0; fi
read -rp "Console address [app.familyscreenwarden.com]: " APP_DOMAIN
read -rp "Site address [familyscreenwarden.com]: " SITE_DOMAIN
read -rp "Your email, for HTTPS certificate notices: " ACME_EMAIL
umask 077
cat > .env <<EOF
APP_DOMAIN=${APP_DOMAIN:-app.familyscreenwarden.com}
SITE_DOMAIN=${SITE_DOMAIN:-familyscreenwarden.com}
ACME_EMAIL=${ACME_EMAIL}
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 48)
PUBLISH_TOKEN=$(openssl rand -hex 32)
# Sign-in emails (filled in by deploy/set-mail.sh). Until then sign-in links are written to the server log.
AWS_SES_REGION=
AWS_SES_ACCESS_KEY_ID=
AWS_SES_SECRET_ACCESS_KEY=
MAIL_FROM_EMAIL=
# The paywall stays off while this is empty.
BILLING_ENABLED=
EOF
echo "Wrote deploy/.env (readable only by you). The secrets were generated on this machine."
