#!/bin/bash
# Keep the WatchTogether relay up, forever. Run by the launchd service (see
# install-service.command). `relay.command up` is idempotent — it only starts the
# server/tunnel if they're down — so this just re-asserts every 30s, which also
# recovers the relay after a crash. launchd's KeepAlive restarts THIS loop if it dies.
cd "$(dirname "$0")" || exit 1
while true; do
  ./relay.command up >/dev/null 2>&1
  sleep 30
done
