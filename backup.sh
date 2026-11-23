#!/usr/bin/env bash
# Nightly backup of the database and uploaded files, kept for 14 days.
# Installed by deploy.sh as /etc/cron.d/application-tracker (runs as root at 03:30).
set -euo pipefail
DEST=/var/backups/application-tracker
KEEP_DAYS=14
cd /opt/application-tracker
umask 077
mkdir -p "$DEST"
stamp=$(date +%F)

docker compose exec -T db pg_dump -U tracker -Fc tracker > "$DEST/.db.tmp"
mv "$DEST/.db.tmp" "$DEST/db-$stamp.dump"
docker compose exec -T app tar -C /data -cz uploads > "$DEST/.uploads.tmp"
mv "$DEST/.uploads.tmp" "$DEST/uploads-$stamp.tar.gz"

find "$DEST" -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
