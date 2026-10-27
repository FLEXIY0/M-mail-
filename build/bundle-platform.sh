#!/usr/bin/env bash
# Builds a smaller plugin bundle that contains the server binary for one
# platform only (about 13 MB instead of 60+ MB). Run after `make dist`.
#
#   ./build/bundle-platform.sh linux-amd64
set -euo pipefail

PLATFORM="${1:-linux-amd64}"
ID="$(./build/bin/manifest id)"
SRC="dist/${ID}"
if [ ! -d "${SRC}" ]; then
    echo "dist/${ID} not found, run 'make dist' first" >&2
    exit 1
fi
VERSION="$(jq -r .version "${SRC}/plugin.json")"
EXE="plugin-${PLATFORM}"
if [ "${PLATFORM#windows}" != "${PLATFORM}" ]; then
    EXE="${EXE}.exe"
fi
if [ ! -f "${SRC}/server/dist/${EXE}" ]; then
    echo "no server binary for ${PLATFORM}" >&2
    exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
cp -r "${SRC}" "${TMP}/"
find "${TMP}/${ID}/server/dist" -type f ! -name "${EXE}" -delete
jq --arg p "${PLATFORM}" --arg e "server/dist/${EXE}" '.server.executables = {($p): $e}' \
    "${SRC}/plugin.json" > "${TMP}/${ID}/plugin.json"

OUT="dist/${ID}-${VERSION}-${PLATFORM}.tar.gz"
tar -C "${TMP}" -czf "${OUT}" "${ID}"
echo "${OUT}"
