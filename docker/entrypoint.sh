#!/usr/bin/env bash
set -euo pipefail

ROOT="/app"
SEED_DIR="${ROOT}/data.seed"

DATA_DIR="${NBOT_DATA_DIR:-data}"
if [[ "${DATA_DIR}" != /* ]]; then
  DATA_DIR="${ROOT}/${DATA_DIR}"
fi

mkdir -p "${DATA_DIR}"

if [[ -d "${SEED_DIR}" ]]; then
  cp -a -n "${SEED_DIR}/." "${DATA_DIR}/"

  # Built-in plugin code should be updated when the image updates.
  # In Docker deployments, /app/data is typically a persistent volume, so without this sync
  # plugin JS files can get stuck on an old version forever.
  SYNC_BUILTIN_PLUGINS="${NBOT_SYNC_BUILTIN_PLUGINS:-1}"
  if [[ "${SYNC_BUILTIN_PLUGINS}" != "0" && -d "${SEED_DIR}/plugins" ]]; then
    mkdir -p "${DATA_DIR}/plugins"
    cp -a "${SEED_DIR}/plugins/." "${DATA_DIR}/plugins/"
  fi
fi

mkdir -p "${DATA_DIR}/state"

exec "$@"
