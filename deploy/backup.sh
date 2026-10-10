#!/usr/bin/env bash
# Nightly Postgres backup for the compose stack, with a hard retention limit.
#
# The privacy promise (SPEC §8.4) says deleted data leaves backups within 14 days, so this
# script deletes local dumps older than BACKUP_RETENTION_DAYS (default and maximum 14).
# If you copy dumps off the host, give that bucket a lifecycle rule with the same limit.
#
# Cron (as root on the droplet), every night at 03:17:
#   17 3 * * * /opt/raisebook/deploy/backup.sh >> /var/log/raisebook-backup.log 2>&1
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$here/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$here/.env"
  set +a
fi

dir="${BACKUP_DIR:-/var/backups/raisebook}"
keep="${BACKUP_RETENTION_DAYS:-14}"
if (( keep > 14 )); then
  echo "BACKUP_RETENTION_DAYS=$keep exceeds the 14-day privacy promise; using 14" >&2
  keep=14
fi

mkdir -p "$dir"
chmod 700 "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/raisebook-$stamp.dump"

docker compose -f "$here/docker-compose.yml" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-raisebook}" -d "${POSTGRES_DB:-raisebook}" --format=custom --no-owner \
  > "$out.partial"
mv "$out.partial" "$out"
chmod 600 "$out"

find "$dir" -name 'raisebook-*.dump' -type f -mtime +"$((keep - 1))" -delete
find "$dir" -name 'raisebook-*.dump.partial' -type f -mmin +120 -delete

echo "$(date -u +%FT%TZ) backup ok: $out ($(du -h "$out" | cut -f1)), keeping $keep days"
