#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
IMAGE=${ANUGA_DOCKER_IMAGE:-anuga-core:local}
MODEL_DIR="$REPO_ROOT/OUTPUT/model"
BUILDING_DIR="$MODEL_DIR/buildings"
MAPPING_DIR="$MODEL_DIR/grid_mapping"

for tool in docker gdal_translate ogr2ogr ogrinfo; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Required tool not found: %s\n' "$tool" >&2
        exit 1
    fi
done

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -t "$IMAGE" "$REPO_ROOT"
fi

mkdir -p -- "$MODEL_DIR"

# AAIGrid provides a small dependency-free raster input for the ANUGA image.
gdal_translate -q -of AAIGrid -a_nodata -9999 \
    "$BUILDING_DIR/building_fraction_30m.tif" \
    "$MODEL_DIR/building_fraction_30m.asc"
for scenario in low middle high; do
    gdal_translate -q -of AAIGrid \
        "$BUILDING_DIR/manning_${scenario}_30m.tif" \
        "$MODEL_DIR/manning_${scenario}_30m.asc"
done

rm -rf -- "$MAPPING_DIR"
docker run --rm \
    --workdir /workspace \
    --volume "$REPO_ROOT:/workspace" \
    "$IMAGE" \
    sh -c 'python -m bayuquan.build_grid_triangle_mapping && \
        python -m bayuquan.build_raster_interpolation_mapping'

TEMP_GPKG="$MAPPING_DIR/.dem_grid_cells.tmp.gpkg"
rm -f -- "$TEMP_GPKG"
ogr2ogr -f GPKG "$TEMP_GPKG" "$MAPPING_DIR/dem_grid_cells.geojson" \
    -nln dem_grid_cells \
    -nlt POLYGON \
    -s_srs OGC:CRS84 \
    -t_srs EPSG:32651 \
    -lco SPATIAL_INDEX=YES
mv -f -- "$TEMP_GPKG" "$MAPPING_DIR/dem_grid_cells.gpkg"

FEATURES=$(ogrinfo -ro -so "$MAPPING_DIR/dem_grid_cells.gpkg" dem_grid_cells |
    awk -F': ' '/Feature Count/ { print $2 }')
printf 'Grid-to-triangle mapping complete: %s selectable cells\n' "$FEATURES"
printf 'Report: %s\n' "$MAPPING_DIR/mapping_report.json"
