#!/usr/bin/env bash
# Builds the plugin for linux-amd64 and installs it into the Mattermost
# container from docker-compose.yml (local mode, no admin token needed).
#
#   ./build/dev-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MM_SERVICESETTINGS_ENABLEDEVELOPER=1 make dist >/dev/null
ID="$(./build/bin/manifest id)"
BUNDLE="$(ls -t dist/"${ID}"-*.tar.gz | head -n 1)"

docker compose cp "${BUNDLE}" mattermost:/tmp/plugin.tar.gz
docker compose exec -T mattermost mmctl --local plugin add /tmp/plugin.tar.gz --force
docker compose exec -T mattermost mmctl --local plugin enable "${ID}"
echo "Installed ${BUNDLE}"
