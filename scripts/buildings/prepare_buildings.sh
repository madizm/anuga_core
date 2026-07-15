#!/usr/bin/env bash
# Prepare building-density and Manning-roughness rasters aligned to a DEM.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)

DEM="$REPO_ROOT/bayuquan/elevation.tif"
BUILDINGS="$REPO_ROOT/OUTPUT/buildings/buildings.gpkg"
SOURCE_LAYER=building_footprints
OUTPUT_DIR="$REPO_ROOT/OUTPUT/buildings"
OVERSAMPLE=10
BOUNDS=()

usage() {
    cat <<'EOF'
Usage: prepare_buildings.sh [options]

Options:
  --dem PATH                 Reference DEM (default: bayuquan/elevation.tif)
  --buildings PATH           Building GeoPackage
  --source-layer NAME        Input layer (default: building_footprints)
  --output-dir DIR           Output directory (default: OUTPUT/buildings)
  --oversample INTEGER       Subpixels per DEM pixel (default: 10)
  --bounds XMIN YMIN XMAX YMAX
                             Processing bounds; snapped outward to the DEM grid.
                             The building extent is used when omitted.
  -h, --help                 Show this message

Outputs:
  buildings_model.gpkg              Deduplicated and dissolved building layers
  building_fraction_30m.tif         Building-covered fraction from 0 to 1
  building_density_class_30m.tif    Density classes 0..4
  manning_{low,middle,high}_30m.tif Roughness sensitivity scenarios
  buildings_model_report.log        Processing and validation report
EOF
}

while (($#)); do
    case "$1" in
        --dem) DEM=$2; shift 2 ;;
        --buildings) BUILDINGS=$2; shift 2 ;;
        --source-layer) SOURCE_LAYER=$2; shift 2 ;;
        --output-dir) OUTPUT_DIR=$2; shift 2 ;;
        --oversample) OVERSAMPLE=$2; shift 2 ;;
        --bounds)
            BOUNDS=("$2" "$3" "$4" "$5")
            shift 5
            ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ ! $OVERSAMPLE =~ ^[1-9][0-9]*$ ]]; then
    printf -- '--oversample must be a positive integer: %s\n' "$OVERSAMPLE" >&2
    exit 2
fi

for path in "$DEM" "$BUILDINGS"; do
    if [[ ! -f $path ]]; then
        printf 'Input not found: %s\n' "$path" >&2
        exit 1
    fi
done

for tool in gdal_calc.py gdal_rasterize gdalinfo gdalsrsinfo jq ogr2ogr ogrinfo; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Required tool not found: %s\n' "$tool" >&2
        exit 1
    fi
done

DEM_JSON=$(gdalinfo -json "$DEM")
read -r DEM_WIDTH DEM_HEIGHT X_ORIGIN X_RES Y_ORIGIN Y_RES <<<"$(
    jq -r '[.size[0], .size[1], .geoTransform[0], .geoTransform[1],
             .geoTransform[3], .geoTransform[5]] | @tsv' <<<"$DEM_JSON"
)"

if ! awk -v x="$X_RES" -v y="$Y_RES" \
    'BEGIN { exit !(x > 0 && y < 0 && x + y < 1e-9 && x + y > -1e-9) }'; then
    printf 'DEM must have north-up square pixels; got x=%s y=%s\n' \
        "$X_RES" "$Y_RES" >&2
    exit 1
fi
PIXEL_SIZE=$X_RES
SUBPIXEL_SIZE=$(awk -v p="$PIXEL_SIZE" -v n="$OVERSAMPLE" \
    'BEGIN { printf "%.12g", p / n }')

DEM_EPSG=$(gdalsrsinfo -e "$DEM" | awk '/EPSG:/ { print; exit }')
BUILDING_EPSG=$(ogrinfo -json -so "$BUILDINGS" "$SOURCE_LAYER" |
    jq -r '.layers[0].geometryFields[0].coordinateSystem.projjson.id |
           "\(.authority):\(.code)"')
if [[ -z $DEM_EPSG || $DEM_EPSG != "$BUILDING_EPSG" ]]; then
    printf 'CRS mismatch: DEM=%s buildings=%s\n' \
        "${DEM_EPSG:-unknown}" "${BUILDING_EPSG:-unknown}" >&2
    exit 1
fi

if ((${#BOUNDS[@]} == 0)); then
    read -r -a BOUNDS <<<"$(
        ogrinfo -json -so "$BUILDINGS" "$SOURCE_LAYER" |
            jq -r '.layers[0].geometryFields[0].extent | @tsv'
    )"
fi
if ((${#BOUNDS[@]} != 4)); then
    printf 'Could not determine four processing bounds.\n' >&2
    exit 1
fi

read -r XMIN YMIN XMAX YMAX XOFF YOFF WIDTH HEIGHT <<<"$(
    awk -v xmin="${BOUNDS[0]}" -v ymin="${BOUNDS[1]}" \
        -v xmax="${BOUNDS[2]}" -v ymax="${BOUNDS[3]}" \
        -v x0="$X_ORIGIN" -v y0="$Y_ORIGIN" -v p="$PIXEL_SIZE" \
        -v raster_width="$DEM_WIDTH" -v raster_height="$DEM_HEIGHT" '
    function floorv(x) { return (x >= 0 || x == int(x)) ? int(x) : int(x)-1 }
    function ceilv(x)  { return (x <= 0 || x == int(x)) ? int(x) : int(x)+1 }
    BEGIN {
        col0=floorv((xmin-x0)/p); col1=ceilv((xmax-x0)/p)
        row0=floorv((y0-ymax)/p); row1=ceilv((y0-ymin)/p)
        if (col0 < 0) col0=0
        if (row0 < 0) row0=0
        if (col1 > raster_width) col1=raster_width
        if (row1 > raster_height) row1=raster_height
        if (col1 <= col0 || row1 <= row0) exit 1
        printf "%.12f %.12f %.12f %.12f %d %d %d %d\n", \
            x0+col0*p, y0-row1*p, x0+col1*p, y0-row0*p, \
            col0, row0, col1-col0, row1-row0
    }'
)" || {
    printf 'Requested bounds do not overlap the DEM.\n' >&2
    exit 1
}

mkdir -p -- "$OUTPUT_DIR"
TEMP_DIR=$(mktemp -d "$OUTPUT_DIR/.prepare_buildings.XXXXXX")
trap 'rm -rf -- "$TEMP_DIR"' EXIT

MODEL_GPKG="$OUTPUT_DIR/buildings_model.gpkg"
FRACTION="$OUTPUT_DIR/building_fraction_30m.tif"
DENSITY="$OUTPUT_DIR/building_density_class_30m.tif"
REPORT="$OUTPUT_DIR/buildings_model_report.log"
TEMP_GPKG="$TEMP_DIR/buildings_model.gpkg"
FINE_RASTER="$TEMP_DIR/buildings_subpixel.tif"

printf 'Deduplicating and dissolving buildings...\n'
ogr2ogr -f GPKG "$TEMP_GPKG" "$BUILDINGS" \
    -dialect SQLite \
    -sql "SELECT MIN(building_id) AS building_id,
                 MIN(source_code) AS source_code,
                 MIN(source_id) AS source_id,
                 geom
          FROM \"$SOURCE_LAYER\"
          GROUP BY hex(ST_AsBinary(geom))" \
    -nln buildings_clean -nlt MULTIPOLYGON -lco SPATIAL_INDEX=YES
ogr2ogr -update -append "$TEMP_GPKG" "$BUILDINGS" \
    -dialect SQLite \
    -sql "SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom
          FROM \"$SOURCE_LAYER\"" \
    -nln buildings_union -nlt MULTIPOLYGON -lco SPATIAL_INDEX=YES

printf 'Rasterizing at %s m and aggregating to %s m...\n' \
    "$SUBPIXEL_SIZE" "$PIXEL_SIZE"
gdal_rasterize -q -burn 1 -init 0 -ot Byte \
    -te "$XMIN" "$YMIN" "$XMAX" "$YMAX" \
    -tr "$SUBPIXEL_SIZE" "$SUBPIXEL_SIZE" \
    -l buildings_union \
    -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER \
    "$TEMP_GPKG" "$FINE_RASTER"

gdalwarp -q -overwrite -r average -srcnodata None -ot Float32 \
    -te "$XMIN" "$YMIN" "$XMAX" "$YMAX" \
    -tr "$PIXEL_SIZE" "$PIXEL_SIZE" \
    -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=3 \
    "$FINE_RASTER" "$TEMP_DIR/building_fraction_30m.tif"

printf 'Creating density classes and Manning scenarios...\n'
gdal_calc.py --quiet --overwrite \
    -A "$TEMP_DIR/building_fraction_30m.tif" \
    --calc='1*(A>=0.05)+1*(A>=0.15)+1*(A>=0.30)+1*(A>=0.50)' \
    --type=Byte --NoDataValue=255 \
    --co=TILED=YES --co=COMPRESS=DEFLATE \
    --outfile="$TEMP_DIR/building_density_class_30m.tif"

create_manning() {
    local name=$1 values=$2
    gdal_calc.py --quiet --overwrite \
        -A "$TEMP_DIR/building_density_class_30m.tif" \
        --calc="$values" --type=Float32 --NoDataValue=-9999 \
        --co=TILED=YES --co=COMPRESS=DEFLATE --co=PREDICTOR=3 \
        --outfile="$TEMP_DIR/manning_${name}_30m.tif"
}
create_manning low \
    '0.03*(A==0)+0.04*(A==1)+0.06*(A==2)+0.08*(A==3)+0.10*(A==4)'
create_manning middle \
    '0.04*(A==0)+0.05*(A==1)+0.08*(A==2)+0.12*(A==3)+0.16*(A==4)'
create_manning high \
    '0.05*(A==0)+0.07*(A==1)+0.10*(A==2)+0.16*(A==3)+0.20*(A==4)'

SOURCE_COUNT=$(ogrinfo -ro -q "$BUILDINGS" -dialect SQLite \
    -sql "SELECT COUNT(*) AS n FROM \"$SOURCE_LAYER\"" |
    awk -F'= ' '/ n \(Integer/ { print $2 }')
CLEAN_COUNT=$(ogrinfo -ro -q "$TEMP_GPKG" -dialect SQLite \
    -sql 'SELECT COUNT(*) AS n FROM buildings_clean' |
    awk -F'= ' '/ n \(Integer/ { print $2 }')
FRACTION_STATS=$(gdalinfo -stats -json "$TEMP_DIR/building_fraction_30m.tif")
FRACTION_MIN=$(jq -r '.bands[0].metadata[""].STATISTICS_MINIMUM' \
    <<<"$FRACTION_STATS")
FRACTION_MAX=$(jq -r '.bands[0].metadata[""].STATISTICS_MAXIMUM' \
    <<<"$FRACTION_STATS")
FRACTION_MEAN=$(jq -r '.bands[0].metadata[""].STATISTICS_MEAN' \
    <<<"$FRACTION_STATS")
EPSG_CODE=${DEM_EPSG#EPSG:}
UNION_AREA=$(ogrinfo -ro -q "$TEMP_GPKG" -dialect SQLite \
    -sql "SELECT ST_Area(ST_Intersection(geom, ST_GeomFromText(
              'POLYGON (($XMIN $YMIN,$XMAX $YMIN,$XMAX $YMAX,
                        $XMIN $YMAX,$XMIN $YMIN))', $EPSG_CODE
          ))) AS area FROM buildings_union" |
    awk -F'= ' '/ area \(Real/ { print $2 }')
RASTERIZED_AREA=$(awk -v mean="$FRACTION_MEAN" -v width="$WIDTH" \
    -v height="$HEIGHT" -v pixel="$PIXEL_SIZE" \
    'BEGIN { printf "%.3f", mean * width * height * pixel * pixel }')
AREA_ERROR_PERCENT=$(awk -v raster="$RASTERIZED_AREA" -v vector="$UNION_AREA" '
    BEGIN {
        if (vector == 0) {
            printf "%s", (raster == 0 ? "0.000000" : "999999.000000")
        } else {
            printf "%.6f", 100 * (raster-vector) / vector
        }
    }')

if ! awk -v lo="$FRACTION_MIN" -v hi="$FRACTION_MAX" \
    'BEGIN { exit !(lo >= -1e-6 && hi <= 1.000001) }'; then
    printf 'Invalid building fractions: min=%s max=%s\n' \
        "$FRACTION_MIN" "$FRACTION_MAX" >&2
    exit 1
fi
if ! awk -v error="$AREA_ERROR_PERCENT" \
    'BEGIN { if (error < 0) error=-error; exit !(error <= 1.0) }'; then
    printf 'Rasterized area differs from vector area by %s%%\n' \
        "$AREA_ERROR_PERCENT" >&2
    exit 1
fi

{
    printf 'dem=%s\n' "$DEM"
    printf 'buildings=%s\n' "$BUILDINGS"
    printf 'source_layer=%s\n' "$SOURCE_LAYER"
    printf 'crs=%s\n' "$DEM_EPSG"
    printf 'dem_pixel_size=%s\n' "$PIXEL_SIZE"
    printf 'oversample=%s\n' "$OVERSAMPLE"
    printf 'subpixel_size=%s\n' "$SUBPIXEL_SIZE"
    printf 'aligned_bounds=%s,%s,%s,%s\n' "$XMIN" "$YMIN" "$XMAX" "$YMAX"
    printf 'dem_window=xoff:%s,yoff:%s,width:%s,height:%s\n' \
        "$XOFF" "$YOFF" "$WIDTH" "$HEIGHT"
    printf 'source_features=%s\n' "$SOURCE_COUNT"
    printf 'unique_exact_geometries=%s\n' "$CLEAN_COUNT"
    printf 'removed_exact_duplicates=%s\n' "$((SOURCE_COUNT-CLEAN_COUNT))"
    printf 'building_fraction_min=%s\n' "$FRACTION_MIN"
    printf 'building_fraction_max=%s\n' "$FRACTION_MAX"
    printf 'building_fraction_mean=%s\n' "$FRACTION_MEAN"
    printf 'vector_union_area_m2=%s\n' "$UNION_AREA"
    printf 'rasterized_area_m2=%s\n' "$RASTERIZED_AREA"
    printf 'rasterization_area_error_percent=%s\n' "$AREA_ERROR_PERCENT"
    printf '\nDensity classes:\n'
    printf '0: fraction < 0.05\n'
    printf '1: 0.05 <= fraction < 0.15\n'
    printf '2: 0.15 <= fraction < 0.30\n'
    printf '3: 0.30 <= fraction < 0.50\n'
    printf '4: fraction >= 0.50\n'
    printf '\nManning values by class (0,1,2,3,4):\n'
    printf 'low=0.03,0.04,0.06,0.08,0.10\n'
    printf 'middle=0.04,0.05,0.08,0.12,0.16\n'
    printf 'high=0.05,0.07,0.10,0.16,0.20\n'
    printf '\nWarning: Manning rasters are sensitivity scenarios, not calibrated values.\n'
} >"$TEMP_DIR/buildings_model_report.log"

# GDAL may have created sidecar statistics for previous outputs. They become
# stale when an atomic rename replaces only the TIFF itself.
rm -f -- "$FRACTION.aux.xml" "$DENSITY.aux.xml"
for scenario in low middle high; do
    rm -f -- "$OUTPUT_DIR/manning_${scenario}_30m.tif.aux.xml"
done

mv -f -- "$TEMP_GPKG" "$MODEL_GPKG"
mv -f -- "$TEMP_DIR/building_fraction_30m.tif" "$FRACTION"
mv -f -- "$TEMP_DIR/building_density_class_30m.tif" "$DENSITY"
for scenario in low middle high; do
    mv -f -- "$TEMP_DIR/manning_${scenario}_30m.tif" \
        "$OUTPUT_DIR/manning_${scenario}_30m.tif"
done
mv -f -- "$TEMP_DIR/buildings_model_report.log" "$REPORT"

printf 'Building model preparation complete.\n'
printf '  Model vectors: %s\n' "$MODEL_GPKG"
printf '  Fractions:     %s\n' "$FRACTION"
printf '  Density:       %s\n' "$DENSITY"
printf '  Report:        %s\n' "$REPORT"
