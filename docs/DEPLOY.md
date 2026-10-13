# Deploying raisebook.org

Status: **not deployed.** Hosting is planned on DigitalOcean after Oct 16, 2026. Nothing in
this repo deploys automatically and nothing touches DNS; every step below is manual and run
by the owner. The generic self-hosting guide is [`deploy/README.md`](../deploy/README.md).

Target layout:

| Host | Serves |
|---|---|
| `https://raisebook.org` | Web app and marketing site (Next.js) |
| `https://www.raisebook.org` | Permanent redirect to the apex |
| `https://api.raisebook.org` | REST API (`/v1`, OpenAPI at `/v1/openapi.json`) |
| `https://api.raisebook.org/mcp` | MCP server (streamable HTTP, API-key auth) |

All of it runs on one droplet with `deploy/docker-compose.yml`: Postgres 17, a migration
job, the API, the web app and Caddy (automatic Let's Encrypt certificates).

---

## 1. Create the droplet (DigitalOcean)

1. **Create → Droplets.** Region close to most users (for example SFO3 or NYC3).
   Image **Ubuntu 24.04 LTS x64**. Size: Basic, Regular SSD, **2 GB / 1 vCPU** is enough to
   start (1 GB works but `npm run build` inside Docker is slow and can run out of memory;
   add swap if you pick 1 GB).
2. Authentication: **SSH key** only (no password).
3. Enable **IPv6** (free) and **Monitoring** (free agent).
4. **Backups:** see section 6 before enabling droplet backups. The weekly plan keeps copies
   for about four weeks, which is longer than the 14 days the privacy page promises. Use the
   daily plan (shorter retention) or rely on `deploy/backup.sh` alone. Check DigitalOcean's
   current retention for each plan when you enable it.
5. Hostname `raisebook-1`. Note the public IPv4 (and IPv6) address.

### Firewall
**Networking → Firewalls → Create**, attach to the droplet:

| Type | Protocol | Port | Sources |
|---|---|---|---|
| SSH | TCP | 22 | your IP (or all, with key-only SSH) |
| HTTP | TCP | 80 | All IPv4, All IPv6 (certificate challenges and the HTTPS redirect) |
| HTTPS | TCP | 443 | All IPv4, All IPv6 |
| Custom | UDP | 443 | All IPv4, All IPv6 (HTTP/3, optional) |

Postgres is never exposed; it is only on the compose network.

### First login
```bash
ssh root@<droplet-ip>
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# Docker Engine + compose plugin (official repository)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Optional on a 1 GB droplet: 2 GB swap for the web build
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 2. DNS records at GoDaddy

The domain stays registered at GoDaddy; only DNS records change. In GoDaddy: **My Products →
raisebook.org → DNS → Manage DNS**. First delete GoDaddy's default **A `@` → "Parked"**
record (and any forwarding), then add:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `<droplet IPv4>` | 600 seconds |
| A | `api` | `<droplet IPv4>` | 600 seconds |
| CNAME | `www` | `@` (GoDaddy's alias for raisebook.org) | 1 hour |
| AAAA | `@` | `<droplet IPv6>` (only if IPv6 is enabled) | 600 seconds |
| AAAA | `api` | `<droplet IPv6>` (only if IPv6 is enabled) | 600 seconds |
| CAA | `@` | `0 issue "letsencrypt.org"` | 1 hour |

GoDaddy usually already has `CNAME www → @`; keep it. Leave the `NS` and `SOA` records alone.
Check propagation before starting Caddy (it requests certificates on the first start, and
repeated failures hit Let's Encrypt rate limits):

```bash
dig +short raisebook.org A
dig +short api.raisebook.org A
dig +short www.raisebook.org
```

### Email records (for magic links and invites)
Pick an SMTP provider (Postmark, Amazon SES, Resend, Mailgun…) and add **exactly the records
it gives you** for sending from `login@raisebook.org`, typically:

| Type | Name | Value |
|---|---|---|
| TXT | `@` | SPF, e.g. `v=spf1 include:<provider> ~all` (merge with any existing SPF; only one SPF record is allowed) |
| TXT or CNAME | `<selector>._domainkey` | DKIM key from the provider |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<your address>` (tighten to `quarantine` once mail flows) |
| CNAME | provider return-path host | from the provider, if it asks for one |

Do not add MX records unless you also want to *receive* mail at raisebook.org.

---

## 3. Configure and start

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/gumruyanzh/raisebook.git   # private until launch: use a deploy key
cd raisebook
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Fill in `deploy/.env`:

| Variable | Value |
|---|---|
| `WEB_HOST` / `API_HOST` | `raisebook.org` / `api.raisebook.org` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 36 \| tr -d '/+=' \| cut -c1-40` |
| `RAISEBOOK_SESSION_SECRET` | `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `RAISEBOOK_SESSION_COOKIE_DOMAIN` | `raisebook.org` (shared by the web and API hosts) |
| `RAISEBOOK_SMTP_*` | from the email provider |
| `RAISEBOOK_GOOGLE_CLIENT_ID` / `RAISEBOOK_GOOGLE_CLIENT_SECRET` | optional: "Continue with Google". Leave both empty to keep it off (the button is hidden). Setup steps, including the exact redirect URI `https://api.raisebook.org/v1/auth/google/callback`, are in `deploy/README.md` under "Continue with Google". After setting them, `docker compose -f deploy/docker-compose.yml up -d api` is enough; no rebuild. |

| `RAISEBOOK_SECRETS_KEK` | optional: turns investor research on. `docker compose -f deploy/docker-compose.yml run --rm api rbctl secrets gen-kek` (or the `python3` line in `.env.example`). It seals each workspace's OpenRouter key; losing it makes saved keys unreadable. Rotation steps are in `deploy/README.md`. |

Keep a copy of `deploy/.env` in a password manager: without the session secret everyone is
signed out, without the Postgres password you cannot restore, and without the KEK saved
OpenRouter keys cannot be opened.

The `worker` service (`rbctl worker`, same image as the API) runs background jobs: investor
research and deck prefill. It needs outbound HTTPS to `openrouter.ai`; the compose network
already has egress. `docker compose stop worker` lets running jobs finish for up to 50 s and
hands the rest back to the queue.

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps         # migrate "Exited (0)", others running/healthy
docker compose -f deploy/docker-compose.yml logs worker | grep worker_started
docker compose -f deploy/docker-compose.yml logs caddy | grep -i certificate
curl -sI https://raisebook.org | head -1               # HTTP/2 200
curl -s https://api.raisebook.org/healthz/ready        # {"status":"ok","db":"ok"}
```

Then sign in at `https://raisebook.org/signin` with your own email and create the workspace.

### Smoke test the MCP endpoint
Create an API key in Settings → API keys, then:
```bash
curl -s https://api.raisebook.org/mcp \
  -H "Authorization: Bearer $RAISEBOOK_API_KEY" \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300
```

---

## 4. Daily jobs (cron on the droplet)

```bash
crontab -e
# Backups at 03:17 UTC, housekeeping at 04:05 UTC
17 3 * * * /opt/raisebook/deploy/backup.sh >> /var/log/raisebook-backup.log 2>&1
5 4 * * *  cd /opt/raisebook && docker compose -f deploy/docker-compose.yml exec -T api rbctl housekeeping >> /var/log/raisebook-housekeeping.log 2>&1
```

---

## 5. Updates

```bash
cd /opt/raisebook
git pull
docker compose -f deploy/docker-compose.yml up -d --build   # migrate runs before the new API starts
docker image prune -f
```

Migrations run automatically through the `migrate` service. If a migration fails, the API
keeps running the old image; read `docker compose logs migrate`.

---

## 6. Backups and the 14-day promise

The privacy page says backups are kept at most 14 days, so deleted data leaves them within
14 days. Everything below keeps that promise:

- **`deploy/backup.sh`** (nightly): `pg_dump` in custom format to `/var/backups/raisebook`,
  mode 600, and deletes dumps older than `BACKUP_RETENTION_DAYS` (default 14; the script
  refuses more).
- **Off-site copy** (recommended): sync the dumps to a private DigitalOcean Spaces bucket
  with a **lifecycle rule that expires objects after 14 days**, for example with
  `rclone sync /var/backups/raisebook spaces:raisebook-backups` after the dump. Without the
  lifecycle rule, `sync` alone would leave deleted dumps behind in versioned buckets.
- **Droplet backups / snapshots:** they contain the database volume, so they are backups too.
  Use a plan whose retention is 14 days or less, or leave them off. Delete manual snapshots
  after an upgrade is confirmed.

**Restore drill** (do it once before launch):
```bash
dc="docker compose -f deploy/docker-compose.yml"
$dc stop api web
$dc exec -T postgres dropdb -U raisebook raisebook
$dc exec -T postgres createdb -U raisebook raisebook
$dc exec -T postgres pg_restore -U raisebook -d raisebook --no-owner < /var/backups/raisebook/<file>.dump
$dc up -d
```

---

## 7. Launch checklist

- [ ] DNS resolves for `raisebook.org`, `www`, `api` (section 2).
- [ ] `https://raisebook.org` and `https://api.raisebook.org/healthz/ready` answer over HTTPS.
- [ ] A magic-link email arrives from `login@raisebook.org` and is not in spam (SPF, DKIM, DMARC).
- [ ] `RAISEBOOK_ENVIRONMENT=production`, so no `dev_link` is ever returned and `/docs` is off.
- [ ] Response headers include HSTS and the CSP (`curl -sI https://raisebook.org`).
- [ ] An MCP client connects with a key (section 3).
- [ ] Backups run, an off-site copy expires after 14 days, and a restore was tested.
- [ ] The GitHub repository is made public (AGPL source offer) at launch.
