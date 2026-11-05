#!/bin/sh
set -eu

SMOKE_DIR="$(mktemp -d /tmp/cad-http-smoke.XXXXXX)"
export DATA_DIR="$SMOKE_DIR/data"
INPUT="$SMOKE_DIR/line.dxf"
LOG="$SMOKE_DIR/uvicorn.log"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT HUP INT TERM

cat > "$SMOKE_DIR/source.geojson" <<'GEOJSON'
{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"Layer":"0"},"geometry":{"type":"LineString","coordinates":[[500000,900000],[500100,900100]]}}]}
GEOJSON
ogr2ogr -f DXF "$INPUT" "$SMOKE_DIR/source.geojson" -nln line
test -s "$INPUT"

uvicorn main:app --host 127.0.0.1 --port 18090 --workers 1 --no-access-log >"$LOG" 2>&1 &
SERVER_PID=$!
attempt=0
until curl --fail --silent http://127.0.0.1:18090/health >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.25
done
curl --fail --silent --show-error --head http://127.0.0.1:18090/docs >/dev/null

status="$(curl --silent --show-error --dump-header "$SMOKE_DIR/headers" \
  --output "$SMOKE_DIR/overlay.geojson" --write-out '%{http_code}' \
  -H 'X-Map-Project-ID: pameda-2026' \
  -H 'X-Admin-Email: smoke@example.com' \
  -F 'source_crs=EPSG:32617' -F 'color=#2563eb' \
  -F "file=@$INPUT;type=application/dxf" \
  http://127.0.0.1:18090/api/convert)"
if [ "$status" != "200" ]; then
  cat "$LOG" >&2
  echo "GeoJSON conversion returned HTTP $status" >&2
  exit 1
fi

layer_id="$(awk 'tolower($1) == "x-cad-layer-id:" { gsub("\r", "", $2); print $2 }' "$SMOKE_DIR/headers")"
if [ "${#layer_id}" -ne 32 ]; then
  cat "$LOG" >&2
  echo "The response did not include a valid layer ID" >&2
  exit 1
fi

curl --fail --silent --show-error \
  http://127.0.0.1:18090/api/saved-layers/pameda-2026 \
  --output "$SMOKE_DIR/layers.json"

python3 - "$SMOKE_DIR" "$layer_id" <<'PY'
import csv
import json
import os
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
layer_id = sys.argv[2]
geojson = json.loads((root / "overlay.geojson").read_text(encoding="utf-8"))
assert geojson["type"] == "FeatureCollection" and geojson["features"]
assert layer_id in (root / "layers.json").read_text(encoding="utf-8")
data = Path(os.environ["DATA_DIR"])
originals = list((data / "originales" / "pameda-2026").iterdir())
assert len(originals) == 1
assert re.match(r"^\d{8}T\d{6}Z_pameda-2026_[0-9a-f]{32}_line\.dxf$", originals[0].name)
assert originals[0].read_bytes() == (root / "line.dxf").read_bytes()
assert (data / "geojson" / "pameda-2026" / f"{layer_id}.geojson").is_file()
with (data / "logs" / "historial_subidas.csv").open(encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle))
assert len(rows) == 1 and rows[0]["project_id"] == "pameda-2026"
assert rows[0]["filename"] == "line.dxf" and rows[0]["status"] == "ok"
PY

echo "HTTP smoke test passed: /docs, DWG/DXF upload, GeoJSON response, saved layer, original retention and audit CSV."
