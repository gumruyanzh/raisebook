# Raisebook web image (Next.js standalone output). SPEC §11. Not deployed yet.
#
# Build context is web/:
#   docker build -f deploy/web.Dockerfile web
# NEXT_PUBLIC_* values are inlined at build time, so they are build args, not runtime env.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=https://api.raisebook.org
ARG NEXT_PUBLIC_SITE_URL=https://raisebook.org
ARG NEXT_PUBLIC_PUBLIC_API_URL=https://api.raisebook.org
ARG NEXT_PUBLIC_REPO_URL=https://github.com/gumruyanzh/raisebook
ARG NEXT_PUBLIC_SPONSOR_URL=https://github.com/sponsors/gumruyanzh
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_PUBLIC_API_URL=$NEXT_PUBLIC_PUBLIC_API_URL \
    NEXT_PUBLIC_REPO_URL=$NEXT_PUBLIC_REPO_URL \
    NEXT_PUBLIC_SPONSOR_URL=$NEXT_PUBLIC_SPONSOR_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN useradd --system --uid 10001 --home /app raisebook
COPY --from=build --chown=10001 /app/.next/standalone ./
COPY --from=build --chown=10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001 /app/public ./public
USER 10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/robots.txt').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
