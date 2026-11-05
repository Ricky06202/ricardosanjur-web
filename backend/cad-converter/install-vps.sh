#!/usr/bin/env bash
set -euo pipefail

CAD_DIR=/opt/cad-converter
MAPAS_ROOT=/opt/mapas
CAD_DATA_DIR="$MAPAS_ROOT/archivos_clientes"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ejecute este instalador como root; solo administra el contenedor CAD y su carpeta privada." >&2
  exit 1
fi

for source_file in \
  "$SOURCE_DIR/Dockerfile" \
  "$SOURCE_DIR/.dockerignore" \
  "$SOURCE_DIR/requirements.txt" \
  "$SOURCE_DIR/compose.yaml" \
  "$SOURCE_DIR/app/main.py" \
  "$SOURCE_DIR/tests/test_security.py" \
  "$SOURCE_DIR/tests/test_conversion_smoke.py" \
  "$SOURCE_DIR/tests/test_http_smoke.sh"; do
  if [[ ! -f "$source_file" ]]; then
    echo "Falta un archivo del conversor CAD: $source_file" >&2
    exit 1
  fi
done

if ! docker network inspect rsanjur-mapas_mapas >/dev/null 2>&1; then
  echo "No existe la red Docker rsanjur-mapas_mapas; instale primero el servicio de mapas." >&2
  exit 1
fi

if [[ -L "$MAPAS_ROOT" || ( -e "$MAPAS_ROOT" && ! -d "$MAPAS_ROOT" ) ]]; then
  echo "La ruta $MAPAS_ROOT no es un directorio seguro; no se modificó." >&2
  exit 1
fi
if [[ ! -d "$MAPAS_ROOT" ]]; then
  install -d -o root -g root -m 0755 "$MAPAS_ROOT"
fi

ensure_data_directory() {
  local directory="$1"
  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    echo "La ruta $directory no es un directorio seguro; no se modificó." >&2
    exit 1
  fi
  if [[ ! -d "$directory" ]]; then
    install -d -o 10001 -g 10001 -m 0750 "$directory"
    return
  fi
  if [[ "$(stat -c '%u:%g' "$directory")" != "10001:10001" ]]; then
    echo "La carpeta existente $directory no pertenece a 10001:10001; revise sus datos antes de continuar." >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$directory")" != "750" ]]; then
    echo "La carpeta existente $directory no tiene permisos privados 0750; revise sus datos antes de continuar." >&2
    exit 1
  fi
}

ensure_data_directory "$CAD_DATA_DIR"
for subdir in originales geojson exportados logs; do
  ensure_data_directory "$CAD_DATA_DIR/$subdir"
done

if [[ -L "$CAD_DIR" || ( -e "$CAD_DIR" && ! -d "$CAD_DIR" ) ]]; then
  echo "La ruta $CAD_DIR no es un directorio seguro; no se modificó." >&2
  exit 1
fi
for subdir in app tests; do
  if [[ -L "$CAD_DIR/$subdir" || ( -e "$CAD_DIR/$subdir" && ! -d "$CAD_DIR/$subdir" ) ]]; then
    echo "La ruta $CAD_DIR/$subdir no es un directorio seguro; no se modificó." >&2
    exit 1
  fi
done
install -d -o root -g root -m 0755 "$CAD_DIR" "$CAD_DIR/app" "$CAD_DIR/tests"

install -o root -g root -m 0644 "$SOURCE_DIR/Dockerfile" "$CAD_DIR/Dockerfile"
install -o root -g root -m 0644 "$SOURCE_DIR/.dockerignore" "$CAD_DIR/.dockerignore"
install -o root -g root -m 0644 "$SOURCE_DIR/requirements.txt" "$CAD_DIR/requirements.txt"
install -o root -g root -m 0644 "$SOURCE_DIR/compose.yaml" "$CAD_DIR/compose.yaml"
install -o root -g root -m 0644 "$SOURCE_DIR/app/main.py" "$CAD_DIR/app/main.py"
install -o root -g root -m 0644 "$SOURCE_DIR/tests/test_security.py" "$CAD_DIR/tests/test_security.py"
install -o root -g root -m 0644 "$SOURCE_DIR/tests/test_conversion_smoke.py" "$CAD_DIR/tests/test_conversion_smoke.py"
install -o root -g root -m 0644 "$SOURCE_DIR/tests/test_http_smoke.sh" "$CAD_DIR/tests/test_http_smoke.sh"
install -o root -g root -m 0644 "$SOURCE_DIR/README.md" "$CAD_DIR/README.md"
install -o root -g root -m 0755 "$SOURCE_DIR/install-vps.sh" "$CAD_DIR/install-vps.sh"

# This Compose project contains only cad-converter; it cannot restart TileServer or touch MBTiles.
docker compose --project-directory "$CAD_DIR" -f "$CAD_DIR/compose.yaml" up -d --build --no-deps cad-converter
docker compose --project-directory "$CAD_DIR" -f "$CAD_DIR/compose.yaml" ps cad-converter
