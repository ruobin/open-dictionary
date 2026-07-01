#!/usr/bin/env bash
#
# Weekly MongoDB backup for open-dictionary.
#
#   - Dumps the `open-dictionary` database from the running mongo container
#     (mongodump --archive --gzip) to a timestamped, gzip-compressed archive.
#   - Retention: KEEP ONLY THE LATEST successful backup. Once the new dump
#     completes, every other open-dictionary-*.archive.gz in the backup dir is
#     deleted, so exactly one backup exists at any time.
#
# Scheduled by scripts/open-dictionary-backup.cron (Monday 02:00 UTC =
# Monday morning APAC). Safe to run by hand:
#   /usr/local/bin/open-dictionary-backup.sh
#
# Restore (on the host):
#   docker exec -i open-dictionary-mongo mongorestore --archive --gzip --drop \
#     < /var/backups/open-dictionary-mongodb/open-dictionary-*.archive.gz
#
set -euo pipefail

CONTAINER="${MONGO_CONTAINER:-open-dictionary-mongo}"
DB="${MONGO_DB:-open-dictionary}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/open-dictionary-mongodb}"
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
  # Single-retention: delete every prior archive except the one just written.
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name 'open-dictionary-*.archive.gz' \
    \! -name "$(basename "$ARCHIVE")" -delete
  remaining="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'open-dictionary-*.archive.gz' | wc -l)"
  log "retention applied: $remaining backup(s) remaining"
else
  status=$?
  rm -f "$TMP"
  log "ERROR: mongodump failed (exit $status); no archive written"
  exit "$status"
fi
