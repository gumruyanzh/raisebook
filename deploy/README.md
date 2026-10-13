# Self-hosting Raisebook

Raisebook runs as six containers on one machine: Postgres 17, a one-shot migration job,
the API (REST under `/v1` and the MCP server at `/mcp`), a background job runner (idle
today), the web app, and Caddy for HTTPS.
Any Linux host with Docker and 1 GB of RAM is enough for a team.

The production setup for raisebook.org (DigitalOcean, DNS records, backups) is in
[`docs/DEPLOY.md`](../docs/DEPLOY.md). This page is the short version for your own domain.

## Files

| File | What it is |
|---|---|
| `api.Dockerfile` | API image (Python 3.12, uv, non-root uid 10001). Build context `backend/`. |
| `web.Dockerfile` | Web image (Next.js standalone, Node 22, non-root). Build context `web/`. |
| `docker-compose.yml` | `postgres`, `migrate`, `api`, `worker`, `web`, `caddy`. Only Caddy publishes ports (80, 443). `worker` runs `rbctl worker` on the API image. Logs are capped at 5 × 20 MB per container. |
| `Caddyfile` | `WEB_HOST` → web, `www.WEB_HOST` → redirect, `API_HOST` → API and `/mcp` (unbuffered). Security headers and a self-only CSP. |
| `.env.example` | Every setting. Copy to `deploy/.env` (git-ignored). |
| `backup.sh` | Nightly `pg_dump` with a 14-day retention limit. |

## Run it

1. Point two DNS records at the machine: `WEB_HOST` (for example `crm.example.com`) and
   `API_HOST` (for example `api.crm.example.com`). They must share a parent domain, which
   goes in `RAISEBOOK_SESSION_COOKIE_DOMAIN` (`example.com` here), so the sign-in cookie
   reaches both.
2. Configure:
   ```bash
   git clone https://github.com/gumruyanzh/raisebook && cd raisebook
   cp deploy/.env.example deploy/.env
   # Set your hosts: WEB_HOST, API_HOST, RAISEBOOK_SESSION_COOKIE_DOMAIN, RAISEBOOK_EMAIL_FROM.
   # Set your secrets: POSTGRES_PASSWORD, RAISEBOOK_SESSION_SECRET and the SMTP settings.
   ```
3. Start:
   ```bash
   GIT_SHA=$(git rev-parse --short HEAD) docker compose -f deploy/docker-compose.yml build
   docker compose -f deploy/docker-compose.yml up -d
   docker compose -f deploy/docker-compose.yml ps        # migrate exits 0; api and web healthy
   curl -s https://$API_HOST/healthz/ready               # {"status":"ok","db":"ok"}
   ```
4. Sign in at `https://$WEB_HOST/signin`. The sign-in link arrives by email, so SMTP must
   work. To check email without a provider, set `RAISEBOOK_EMAIL_BACKEND=log` and read the
   link from `docker compose logs api`, then switch back.

## "Continue with Google" (optional)

Off until both `RAISEBOOK_GOOGLE_CLIENT_ID` and `RAISEBOOK_GOOGLE_CLIENT_SECRET` are set in
`deploy/.env`. The sign-in page asks `GET /v1/auth/providers` and hides the button while
they are empty.

1. In Google Cloud Console, open APIs & Services > OAuth consent screen and set it up
   (External, app name "Raisebook", scopes `openid`, `email`, `profile`; these are not
   sensitive scopes, so Google does not need to review the app).
2. Credentials > Create credentials > OAuth client ID, type "Web application". Add exactly one
   authorized redirect URI, `https://$API_HOST/v1/auth/google/callback` (for raisebook.org:
   `https://api.raisebook.org/v1/auth/google/callback`). It is derived from
   `RAISEBOOK_PUBLIC_BASE_URL`, so it must match character for character. No JavaScript
   origin is needed.
3. Put the client ID and secret in `deploy/.env`, then
   `docker compose -f deploy/docker-compose.yml up -d api` (no rebuild; the web reads the
   provider list at request time).

A Google sign-in uses the same account as the emailed link for that address. Google must
report the address as verified. The first Google sign-in binds the Google account to the
Raisebook account, and a different Google account claiming the same address later is
refused.

## Updating

```bash
git pull
# Build first while the old containers keep serving, then swap (migrate runs before the API).
GIT_SHA=$(git rev-parse --short HEAD) docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
curl -s https://$API_HOST/healthz                            # "commit" is the new SHA
```

## Operations

```bash
dc="docker compose -f deploy/docker-compose.yml"
$dc exec api rbctl --help                          # admin CLI
$dc exec api rbctl seed-demo --email you@example.com   # fictional sample workspace
$dc exec api rbctl housekeeping                    # expired tokens/sessions, dead invites, old rate-limit windows
$dc logs -f api                                    # JSON logs; no request bodies, emails or investor data
```

Run `rbctl housekeeping` daily from cron. Back up with `deploy/backup.sh` (see the header of
the script). Restore a dump into an empty database with
`pg_restore --clean --if-exists --no-owner -d raisebook <file>`.

## Trust boundaries

- **Forwarded client IPs.** The API trusts `X-Forwarded-For` only from `FORWARDED_ALLOW_IPS`
  (default `172.30.0.0/24`, the compose network's fixed subnet, where only Caddy reaches the
  API). Per-IP limits (sign-in emails, failed API keys, anonymous lookups) depend on it. If you
  publish the API port directly or run behind a different proxy, set `FORWARDED_ALLOW_IPS` to
  that proxy's address. **Never set it to `*` when the API is reachable without the proxy**:
  anyone could then spoof their IP and bypass those limits.
- **Session cookie domain.** `rb_session` and `rb_csrf` are scoped to
  `RAISEBOOK_SESSION_COOKIE_DOMAIN` (the parent domain), so every subdomain of it receives the
  session cookie. Every subdomain must be first-party, run by you, inside the same trust
  boundary. Never point a subdomain at third-party hosting (status pages, docs builders,
  landing-page tools), remove DNS records for anything you shut down so it cannot be taken
  over, and run staging on a separate registrable domain, not `staging.raisebook.org`.
- **Backups.** `backup.sh` writes dumps with `umask 077` into a `700` directory. Encrypt a dump
  (for example with `age` and an offline key) before it leaves the host.

## Local check without a domain

Caddy needs real DNS for certificates, and the session cookie needs a shared parent domain,
so the compose stack is meant for a real host. To try Raisebook on your laptop, run the API
and the web app directly as described in `CLAUDE.md` (no Docker needed).
