# Putting Family Screen Warden on a server

One Linux server runs everything: Caddy (HTTPS), the console server and Postgres. The sales site is served from the `site/` folder.

## Before you start
- DNS A records pointing at this server: `app.familyscreenwarden.com`, `familyscreenwarden.com`, `www.familyscreenwarden.com`. On Cloudflare set all three to **DNS only** (grey cloud): Caddy gets its own HTTPS certificates, and Cloudflare's proxy rejects uploads over 100 MB.
- Ports 80 and 443 open.

## Steps

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sudo sh

# 2. Get the code (private repo: use a read-only deploy key, see below)
sudo mkdir -p /opt/warden && sudo chown "$USER" /opt/warden
git clone git@github.com:familyscreenwarden/familywarden.git /opt/warden
cd /opt/warden

# 3. Make the settings file with fresh secrets
./deploy/init-env.sh

# 4. Start
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build

# 5. Check
curl -s https://app.familyscreenwarden.com/healthz
```

### Deploy key (for step 2)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/warden_deploy -N "" -C "warden-server"
cat ~/.ssh/warden_deploy.pub
printf 'Host github.com\n  IdentityFile ~/.ssh/warden_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

Paste the printed line at GitHub → the repo → Settings → Deploy keys → Add deploy key. Leave "Allow write access" off.

## Sign-in emails

Until mail is set up, sign-in links are written to the server log:

```bash
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs app | tail -50
```

After the domain is verified in Amazon SES, run `./deploy/set-mail.sh`, then the start command again.

## Updating

```bash
cd /opt/warden && git pull
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

## Publishing the kids' app from GitHub

In the repo's Settings → Secrets and variables → Actions:
- variable `WARDEN_SERVER_URL` = `https://app.familyscreenwarden.com`
- secret `PUBLISH_TOKEN` = the value shown by `grep PUBLISH_TOKEN deploy/.env`

## Backups (set this up before real families use it)

```bash
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db pg_dump -U fsw fsw | gzip > ~/warden-$(date +%F).sql.gz
```

Kids' photos, videos and app files are in the Docker volume `warden_data`. Copy the database dump and that volume off the server regularly.
