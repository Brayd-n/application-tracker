#!/usr/bin/env bash
# Build the image here, copy it to the server, and (re)start it with Docker Compose.
# Secrets stay on the server in root-only files under /etc/application-tracker.
# Usage: ./deploy.sh
set -euo pipefail

SERVER="${SERVER:-braydon@179.66.159.71}"
DIR=/opt/application-tracker
cd "$(dirname "$0")"

if [ -S "$HOME/.ssh/agent.sock" ]; then
  export SSH_AUTH_SOCK="$HOME/.ssh/agent.sock"
fi

echo "Building image..."
docker build -t application-tracker:latest .

echo "Copying image, compose file and backup script..."
ssh "$SERVER" "sudo install -d -o \$USER $DIR"
scp -q docker-compose.yml backup.sh "$SERVER:$DIR/"
docker save application-tracker:latest | gzip | ssh "$SERVER" 'gunzip | docker load'

echo "Starting..."
ssh "$SERVER" "set -e
  sudo install -d -m 700 /etc/application-tracker
  if ! sudo test -f /etc/application-tracker/db.env; then
    pw=\$(openssl rand -hex 24)
    printf 'POSTGRES_PASSWORD=%s\n' \"\$pw\" | sudo sh -c 'umask 077; cat > /etc/application-tracker/db.env'
    printf 'PGPASSWORD=%s\n' \"\$pw\" | sudo sh -c 'umask 077; cat > /etc/application-tracker/app.env'
  fi
  chmod 755 $DIR/backup.sh
  echo '30 3 * * * root $DIR/backup.sh' | sudo tee /etc/cron.d/application-tracker >/dev/null
  cd $DIR && sudo docker compose up -d --remove-orphans && docker image prune -f >/dev/null"

echo "Done."
