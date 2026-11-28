#!/usr/bin/env bash
# Stores the Amazon SES details in deploy/.env. The secret key is typed at a hidden prompt.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Run deploy/init-env.sh first."; exit 1; }
read -rp "SES region (for example us-east-1): " REGION
read -rp "Send sign-in emails from (for example login@familyscreenwarden.com): " FROM
read -rp "SES access key ID: " KEYID
read -rsp "SES secret access key (hidden): " SECRET; echo
set_var() {
  local k="$1" v="$2"
  ( umask 077; grep -v "^${k}=" .env > .env.tmp || true; printf '%s=%s\n' "$k" "$v" >> .env.tmp )
  mv .env.tmp .env
}
set_var AWS_SES_REGION "$REGION"
set_var MAIL_FROM_EMAIL "$FROM"
set_var AWS_SES_ACCESS_KEY_ID "$KEYID"
set_var AWS_SES_SECRET_ACCESS_KEY "$SECRET"
echo "Saved. Start the server again to use it:"
echo "  sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"
