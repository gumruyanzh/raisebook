# Deploying raisebook.org

Status: **live.** raisebook.org runs on one DigitalOcean droplet (s-2vcpu-4gb, SFO3). Nothing
in this repo deploys automatically and nothing touches DNS; every step below is manual and run
by the owner. The generic self-hosting guide is [`deploy/README.md`](../deploy/README.md).

Target layout:

| Host | Serves |
|---|---|
| `https://raisebook.org` | Web app and marketing site (Next.js) |
| `https://www.raisebook.org` | Permanent redirect to the apex |
| `https://api.raisebook.org` | REST API (`/v1`, OpenAPI at `/v1/openapi.json`) |
| `https://api.raisebook.org/mcp` | MCP server (streamable HTTP, API-key auth) |

All of it runs on one droplet with `deploy/docker-compose.yml`: Postgres 17, a migration
job, the API, a background job runner, the web app and Caddy (automatic Let's Encrypt
certificates).

---

## 1. Create the droplet (DigitalOcean)

1. **Create → Droplets.** Region close to most users (for example SFO3 or NYC3).
   Image **Ubuntu 24.04 LTS x64**. Size: Basic, Regular SSD. raisebook.org uses
   **4 GB / 2 vCPU**; 2 GB / 1 vCPU works for a small team. Add 2 GB of swap on any size:
   the Next.js build needs 1-2 GB of memory next to the running stack.
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

# 2 GB swap, so a web build cannot push Postgres into the OOM killer
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
git clone https://github.com/gumruyanzh/raisebook.git
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
| `RAISEBOOK_MAGIC_LINKS_PER_IP_HOUR` | optional, default 100. Raise it (for example 300) before an event where many people sign in on one Wi-Fi. |
| `RAISEBOOK_EMAIL_GLOBAL_PER_HOUR` | optional, default 500. All outbound email per hour; keep it under the email plan's limits. |
| `RAISEBOOK_RESEARCH_ENABLED` | `false` until you turn on AI research (section 3, "AI research"). |
| `RAISEBOOK_SECRETS_KEK` | empty while research is off. Required with research on: `docker compose -f deploy/docker-compose.yml run --rm --no-deps api rbctl secrets gen-kek` prints `k1:<44 characters>`. |
| `RAISEBOOK_SECRETS_KEK_PREVIOUS` | empty, except while rotating the KEK. |
| `RAISEBOOK_OPERATOR_EMAIL` | optional: who is emailed when a research removal request is confirmed. |
| `RAISEBOOK_WORKER_CONCURRENCY` | optional, default 4: jobs one `worker` container runs at once. |

Keep a copy of `deploy/.env` in a password manager: without the session secret everyone is
signed out, without the Postgres password you cannot restore, and without the KEK every saved
OpenRouter key is unreadable (each workspace then has to enter its key again).

The `worker` service (`rbctl worker`, same image as the API, built by `migrate`) is the
background job runner: AI research runs, company-profile prefill and research removals. Jobs
live in Postgres (`jobs` table, claimed with `FOR UPDATE SKIP LOCKED`, leased and
heartbeated); a worker that dies leaves its jobs to be requeued when the lease expires, and on
`docker compose stop` it finishes or hands back running jobs within 50 s. It serves no HTTP and
has no healthcheck: check it with `logs worker`. With research off it idles.

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps         # migrate "Exited (0)"; api, web, postgres healthy
docker compose -f deploy/docker-compose.yml logs worker | grep worker_started
docker compose -f deploy/docker-compose.yml logs caddy | grep -i certificate
curl -sI https://raisebook.org | head -1               # HTTP/2 200
curl -s https://api.raisebook.org/healthz/ready        # {"status":"ok","db":"ok"}
curl -s https://api.raisebook.org/healthz              # "commit" is the SHA you built
```

Then sign in at `https://raisebook.org/signin` with your own email and create the workspace.

### Smoke test the MCP endpoint
Create an API key in Settings → API keys, then:
```bash
curl -s https://api.raisebook.org/mcp \
  -H "Authorization: Bearer $RAISEBOOK_API_KEY" \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['result']['tools']))"   # 17
```

### AI research (optional, off by default)

Research runs on each workspace's **own** OpenRouter key; the server never pays for model
calls. To turn it on:

```bash
cd /opt/raisebook
dc="docker compose -f deploy/docker-compose.yml"
$dc run --rm --no-deps api rbctl secrets gen-kek      # prints k1:…; store it in the password manager
# In deploy/.env:
#   RAISEBOOK_RESEARCH_ENABLED=true
#   RAISEBOOK_SECRETS_KEK=k1:…                          (the line printed above)
#   RAISEBOOK_OPERATOR_EMAIL=you@yourdomain             (optional)
GIT_SHA=$(git rev-parse --short HEAD) $dc build        # only if the code changed
$dc up -d                                               # migrate runs, then api and worker restart
$dc logs worker | grep worker_started                   # "kinds": [... "research.run"]
```

Checks: Settings → AI research appears in the app, and `tools/list` returns 22 tools instead
of 17. The `api` and `worker` containers must share the same KEK (both read it from
`deploy/.env`). The key itself is never logged or returned; the app shows its last 4 only.

Running it:

- `$dc exec api rbctl research usage --workspace <slug>`: a workspace's spend per month.
- Removal requests from the public Research Policy page: someone confirms by email, you get
  `RAISEBOOK_OPERATOR_EMAIL` (or a `research_removal_verified` log line), then
  `$dc exec api rbctl research removals list --status verified` and
  `$dc exec api rbctl research removals apply <id>`. When the email is not on the person's firm
  domain the request shows `proof: weak`; check other proof first, then add `--proof-checked`.
  `removals reject <id>` declines it.
- Rotating the KEK: move the current value to `RAISEBOOK_SECRETS_KEK_PREVIOUS`, put a new one
  with a new id (`rbctl secrets gen-kek --id k2`) in `RAISEBOOK_SECRETS_KEK`, `$dc up -d`, then
  `$dc exec api rbctl secrets rotate` (counts only), then empty `_PREVIOUS` and `$dc up -d`.
- Turning it off again: `RAISEBOOK_RESEARCH_ENABLED=false` and `$dc up -d`. Saved dossiers
  stay in the database but are hidden from the app, REST, MCP and exports.

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
# Build while the old containers keep serving (the build takes both vCPUs for minutes),
# then swap in a quiet moment; recreating web and api gives a few seconds of 502s.
GIT_SHA=$(git rev-parse --short HEAD) docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d    # migrate runs before the new API starts
curl -s https://api.raisebook.org/healthz            # "commit" is the new SHA
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
$dc stop api web worker
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
- [x] The GitHub repository is public (AGPL source offer).
- [ ] `tools/list` on production returns 17 tools (22 with AI research on) (section 3).
- [ ] External uptime checks on `https://raisebook.org/` and `https://api.raisebook.org/healthz/ready`
      alert the owner; droplet alerts for CPU, memory and disk are set.
