#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=/opt/ricardosanjur-mapas
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ejecute este instalador como root; solo administra /opt/ricardosanjur-mapas y sus dos unidades systemd." >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$PROJECT_DIR/secrets"
for secret in "$PROJECT_DIR/secrets/maps-backend-secret" "$PROJECT_DIR/secrets/cloudflare-tunnel-token"; do
  if [[ ! -s "$secret" ]]; then
    echo "Falta el archivo de secreto requerido: $secret" >&2
    exit 1
  fi
done
backend_secret_bytes="$(wc -c < "$PROJECT_DIR/secrets/maps-backend-secret")"
if (( backend_secret_bytes < 32 )); then
  echo "maps-backend-secret debe tener al menos 32 bytes." >&2
  exit 1
fi

install -d -o 1000 -g 999 -m 2750 "$PROJECT_DIR/data" "$PROJECT_DIR/data/maps"
chmod 0444 "$PROJECT_DIR/secrets/maps-backend-secret" "$PROJECT_DIR/secrets/cloudflare-tunnel-token"

if [[ ! -f "$PROJECT_DIR/data/config.json" ]]; then
  install -o 1000 -g 999 -m 0640 /dev/null "$PROJECT_DIR/data/config.json"
  printf '{\n  "options": { "paths": { "root": ".", "mbtiles": "maps" } },\n  "data": {}\n}\n' > "$PROJECT_DIR/data/config.json"
  chown 1000:999 "$PROJECT_DIR/data/config.json"
  chmod 0640 "$PROJECT_DIR/data/config.json"
fi

install -o root -g root -m 0644 "$APP_DIR/deploy/compose.yaml" "$PROJECT_DIR/compose.yaml"
install -o root -g root -m 0644 "$APP_DIR/deploy/ricardosanjur-mapas-reload.path" /etc/systemd/system/ricardosanjur-mapas-reload.path
install -o root -g root -m 0644 "$APP_DIR/deploy/ricardosanjur-mapas-reload.service" /etc/systemd/system/ricardosanjur-mapas-reload.service
systemctl daemon-reload
systemctl enable --now ricardosanjur-mapas-reload.path

docker compose --project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/compose.yaml" up -d --build
docker compose --project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/compose.yaml" ps
