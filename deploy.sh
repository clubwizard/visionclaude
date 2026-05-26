#!/bin/bash
# Aside deploy script.
#
# Pulls latest, rebuilds the container, and waits for the new instance
# to pass its HEALTHCHECK before returning. nginx in front of this should
# be configured to serve deploy/maintenance.html on 502/503/504 so the
# user-visible gap during the rebuild is friendly rather than nginx-default
# (see deploy/README.md for the snippet).
#
# Fails loudly if the new container doesn't become healthy within the
# timeout — preserves the old data volume so a manual recovery is possible.

set -e
cd "$(dirname "$0")"

echo "▸ Pulling latest..."
git pull --ff-only

echo "▸ Building and starting container (will wait for healthy)..."
# --wait blocks until services are running AND healthy. --wait-timeout
# kills the deploy if HEALTHCHECK doesn't pass in 120s, which is plenty
# for a clean boot (Node startup + sqlite migrations take ~5s in practice).
if ! docker compose up --build -d --wait --wait-timeout 120; then
  echo "✗ Container failed to become healthy. Last 50 log lines:"
  docker compose logs --tail=50
  echo ""
  echo "Old data volume preserved. Inspect with:"
  echo "  docker compose ps"
  echo "  docker compose logs"
  exit 1
fi

echo "✓ Container healthy."
echo "▸ Recent logs:"
docker compose logs --tail=20
