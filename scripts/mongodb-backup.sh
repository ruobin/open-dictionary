#!/usr/bin/env bash
#
# Weekly MongoDB backup for open-dictionary.
#
#   - Dumps the `open-dictionary` database from the running mongo container
#     (mongodump --archive --gzip) to a timestamped, gzip-compressed archive.
#   - Retention: keeps the BACKUP_KEEP_N most recent successful backups
#     (default 1, matching the original single-retention policy). Bump
#     BACKUP_KEEP_N once the cache represents real LLM spend and backup
#     history is worth the storage cost (to-do §9) — this is a deploy-time
#     env var, not a code change.
#
# Scheduled by scripts/open-dictionary-backup.cron (Monday 02:00 UTC =
# Monday morning APAC). Safe to run by hand:
#   /usr/local/bin/open-dictionary-backup.sh
#   BACKUP_KEEP_N=4 /usr/local/bin/open-dictionary-backup.sh   # keep 4 most recent
#
# Restore (on the host):
#   docker exec -i open-dictionary-mongo mongorestore --archive --gzip --drop \
#     < /var/backups/open-dictionary-mongodb/open-dictionary-*.archive.gz
#
set -euo pipefail

CONTAINER="${MONGO_CONTAINER:-open-dictionary-mongo}"
DB="${MONGO_DB:-open-dictionary}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/open-dictionary-mongodb}"
BACKUP_KEEP_N="${BACKUP_KEEP_N:-1}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/open-dictionary-${DB}-${TS}.archive.gz"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p "$BACKUP_DIR"
# Remove any half-written archive left by a previously interrupted run.
rm -f "$BACKUP_DIR"/*.archive.gz.tmp

log "starting mongodump: container=$CONTAINER db=$DB -> $ARCHIVE"

TMP="${ARCHIVE}.tmp"
if docker exec "$CONTAINER" mongodump --archive --gzip --db="$DB" > "$TMP"; then
  mv "$TMP" "$ARCHIVE"
  chmod 600 "$ARCHIVE"            # dump contains user favorites — restrict to root
  log "dump complete: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
  # Keep the BACKUP_KEEP_N most recent archives; delete the rest. Filenames
  # sort chronologically (ISO 8601 timestamp), so the oldest ones are simply
  # the first N lines of the sorted listing once N-to-keep is subtracted.
  total="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'open-dictionary-*.archive.gz' | wc -l | tr -d ' ')"
  if (( total > BACKUP_KEEP_N )); then
    to_delete=$((total - BACKUP_KEEP_N))
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'open-dictionary-*.archive.gz' \
      | sort | head -n "$to_delete" \
      | while IFS= read -r f; do rm -f "$f"; done
  fi
  remaining="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'open-dictionary-*.archive.gz' | wc -l)"
  log "retention applied (keep=$BACKUP_KEEP_N): $remaining backup(s) remaining"
else
  status=$?
  rm -f "$TMP"
  log "ERROR: mongodump failed (exit $status); no archive written"
  exit "$status"
fi
