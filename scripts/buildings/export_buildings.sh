#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
OUTPUT_PATH=${1:-"$REPO_ROOT/OUTPUT/buildings/buildings.gpkg"}
LAYER_NAME=building_footprints
EXPORT_SQL_FILE="$SCRIPT_DIR/export_buildings.psql"
INSPECT_SQL_FILE="$SCRIPT_DIR/inspect_buildings.psql"

: "${PGHOST:=172.24.130.2}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=geovis-scd-yjglyzt}"
: "${PGUSER:=postgres}"
export PGHOST PGPORT PGDATABASE PGUSER

PSQL=${PSQL:-$(command -v psql || true)}
OGR2OGR=${OGR2OGR:-$(command -v ogr2ogr || true)}
OGRINFO=${OGRINFO:-$(command -v ogrinfo || true)}
SQLITE3=${SQLITE3:-$(command -v sqlite3 || true)}

for tool_name in PSQL OGR2OGR OGRINFO SQLITE3; do
    if [[ -z ${!tool_name} ]]; then
        printf 'Required tool not found: %s\n' "$tool_name" >&2
        exit 1
    fi
done

if [[ -z ${PGPASSWORD:-} && -z ${PGPASSFILE:-} && ! -f "$HOME/.pgpass" ]]; then
    printf 'Set PGPASSWORD, PGPASSFILE, or ~/.pgpass before running this script.\n' >&2
    exit 1
fi

OUTPUT_DIR=$(dirname -- "$OUTPUT_PATH")
OUTPUT_BASE=$(basename -- "$OUTPUT_PATH" .gpkg)
TEMP_PATH="$OUTPUT_DIR/.${OUTPUT_BASE}.tmp.gpkg"
INSPECTION_REPORT="$OUTPUT_DIR/${OUTPUT_BASE}_source_report.log"
VALIDATION_REPORT="$OUTPUT_DIR/${OUTPUT_BASE}_validation.log"
mkdir -p -- "$OUTPUT_DIR"
rm -f -- "$TEMP_PATH"

printf 'Inspecting source tables...\n'
"$PSQL" -X -v ON_ERROR_STOP=1 -f "$INSPECT_SQL_FILE" >"$INSPECTION_REPORT"

EXPORT_SQL=$(<"$EXPORT_SQL_FILE")
PG_DSN="PG:host='$PGHOST' port='$PGPORT' dbname='$PGDATABASE' user='$PGUSER'"

printf 'Exporting %s to EPSG:32651...\n' "$LAYER_NAME"
"$OGR2OGR" \
    -f GPKG "$TEMP_PATH" "$PG_DSN" \
    -sql "$EXPORT_SQL" \
    -nln "$LAYER_NAME" \
    -nlt MULTIPOLYGON \
    -dim XY \
    -a_srs EPSG:32651 \
    -lco SPATIAL_INDEX=YES \
    -gt 65536

EXPECTED_ROWS=$("$PSQL" -X -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM ($EXPORT_SQL) AS exported_buildings")
EXPORTED_ROWS=$("$SQLITE3" "$TEMP_PATH" \
    "SELECT count(*) FROM \"$LAYER_NAME\";")
UNIQUE_IDS=$("$SQLITE3" "$TEMP_PATH" \
    "SELECT count(DISTINCT building_id) FROM \"$LAYER_NAME\";")

if [[ "$EXPECTED_ROWS" != "$EXPORTED_ROWS" ]]; then
    printf 'Row-count mismatch: expected %s, exported %s\n' \
        "$EXPECTED_ROWS" "$EXPORTED_ROWS" >&2
    exit 1
fi
if [[ "$EXPORTED_ROWS" != "$UNIQUE_IDS" ]]; then
    printf 'building_id is not unique: %s rows, %s unique IDs\n' \
        "$EXPORTED_ROWS" "$UNIQUE_IDS" >&2
    exit 1
fi

{
    printf 'output=%s\n' "$OUTPUT_PATH"
    printf 'layer=%s\n' "$LAYER_NAME"
    printf 'crs=EPSG:32651\n'
    printf 'expected_rows=%s\n' "$EXPECTED_ROWS"
    printf 'exported_rows=%s\n' "$EXPORTED_ROWS"
    printf 'unique_building_ids=%s\n' "$UNIQUE_IDS"
    printf '\n'
    "$OGRINFO" -ro -so "$TEMP_PATH" "$LAYER_NAME"
    printf '\nGeometry validation:\n'
    "$OGRINFO" -ro -q "$TEMP_PATH" -dialect SQLite \
        -sql "SELECT COUNT(*) AS invalid_geometries FROM \"$LAYER_NAME\" WHERE NOT ST_IsValid(geom)"
} >"$VALIDATION_REPORT"

mv -f -- "$TEMP_PATH" "$OUTPUT_PATH"
printf 'Export complete: %s (%s features)\n' "$OUTPUT_PATH" "$EXPORTED_ROWS"
printf 'Reports: %s, %s\n' "$INSPECTION_REPORT" "$VALIDATION_REPORT"
