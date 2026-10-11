# Raisebook API image (FastAPI + /mcp). SPEC §11. Not deployed yet (hosting undecided).
#
# Build context is backend/:
#   docker build -f deploy/api.Dockerfile backend
# One image, two uses:
#   api (default):  uvicorn --factory raisebook.main:create_app
#   migrate job:    alembic upgrade head
#   ops:            rbctl --help   (seed-demo, housekeeping, apikey …)
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.16 /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first (cached until pyproject.toml / uv.lock change).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY raisebook ./raisebook
RUN uv sync --frozen --no-dev

RUN useradd --system --uid 10001 --home /app raisebook && chown -R raisebook /app
USER 10001

ENV PATH="/app/.venv/bin:$PATH" \
    RAISEBOOK_ENVIRONMENT=production \
    RAISEBOOK_LOG_JSON=true

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

# X-Forwarded-For is trusted only from FORWARDED_ALLOW_IPS (comma-separated IPs or CIDRs).
# The default is the compose network's fixed subnet (docker-compose.yml), where only Caddy
# talks to the API. Never set it to "*" when the API port is reachable directly: anyone could
# then spoof their IP and get around the per-IP limits (sign-in emails, failed keys).
ENV FORWARDED_ALLOW_IPS=172.30.0.0/24
CMD ["sh", "-c", "exec uvicorn --factory raisebook.main:create_app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips \"$FORWARDED_ALLOW_IPS\""]
