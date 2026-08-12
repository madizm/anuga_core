"""FastAPI application for Bayuquan scenarios and simulation jobs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import struct
import warnings
from collections.abc import Callable
from contextlib import ExitStack, asynccontextmanager
from functools import partial
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import boto3
import httpx
import numpy as np
import rasterio
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from bayuquan.simulation.area_catalog import (
    SimulationAreaCatalog,
)
from bayuquan.simulation.feature_compiler import (
    feature_mesh_preview,
    sample_elevation_profile,
)
from bayuquan.simulation.hydraulic_features import HydraulicFeaturesSpec
from bayuquan.preview.cache import (
    PreprocessingCacheMismatch,
    cache_identity,
    load_preprocessed,
)

from .config import Settings
from .db import Database
from .dem_products import (
    DemProductCatalog,
    DemProductError,
    DemProductView,
    register_manifest,
)
from .models import (
    FullPreviewJob,
    Scenario,
    SimulationFrame,
    SimulationJob,
    utcnow,
)
from .scenarios.service import (
    get_scenario,
    save_scenario,
    scenario_query,
    scenario_response,
    scenario_snapshot,
    validate_scenario,
)
from .schemas import (
    ElevationProfileRequest,
    FullPreviewCreateRequest,
    GridSelectionRequest,
    HydraulicMeshPreviewRequest,
    JobCreateRequest,
    ScenarioRequest,
    SimulationAreaResolveRequest,
)

JobDispatcher = Callable[[str, str], None]


def create_app(
    *,
    settings: Settings | None = None,
    database: Database | None = None,
    area_catalog: SimulationAreaCatalog | None = None,
    dem_catalog: DemProductCatalog | None = None,
    dispatcher: JobDispatcher | None = None,
    preview_dispatcher: JobDispatcher | None = None,
) -> FastAPI:
    settings = settings or Settings.from_environment()
    database = database or Database(settings.database_url)
    register_products = dem_catalog is None and area_catalog is None
    area_cache = settings.simulation_area_cache or (
        settings.project_root / "simulation_areas"
    )
    if dem_catalog is None:
        if area_catalog is not None:
            dem_catalog = _single_product_catalog(area_catalog)
        else:
            dem_catalog = DemProductCatalog(database, area_cache)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.auto_create_schema:
            database.create_schema()
        if register_products and settings.dem_product_manifest is not None:
            register_manifest(database, settings.dem_product_manifest)
        yield

    app = FastAPI(
        title="Bayuquan ANUGA Web GIS API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.database = database
    app.state.dem_products = dem_catalog
    app.state.dispatcher = dispatcher or _celery_dispatcher(settings)
    app.state.preview_dispatcher = (
        preview_dispatcher or _full_preview_dispatcher(settings)
    )
    app.state.s3_client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )
    preview_readiness_cache: dict[tuple, dict] = {}

    def session_dependency() -> Session:
        with database.session_factory() as session:
            yield session

    def product_or_404(
        product_id: str, *, for_new_area: bool = False
    ) -> DemProductView:
        try:
            return dem_catalog.get(product_id, for_new_area=for_new_area)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="DEM product not found"
            ) from error
        except DemProductError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    def catalog_or_404(
        product_id: str, *, for_new_area: bool = False
    ) -> SimulationAreaCatalog:
        product_or_404(product_id, for_new_area=for_new_area)
        return dem_catalog.area_catalog(
            product_id, for_new_area=for_new_area
        )

    @app.get("/api/health")
    def health() -> dict:
        try:
            default = dem_catalog.default()
        except DemProductError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {"status": "ok", "defaultDemProductId": default.id}

    @app.get("/api/dem-products")
    def dem_products() -> dict:
        try:
            default = dem_catalog.default()
        except DemProductError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {
            "defaultDemProductId": default.id,
            "products": [
                item.response()
                for item in dem_catalog.list(include_unavailable=True)
            ],
        }

    @app.get("/api/dem-products/{product_id}")
    def dem_product(product_id: str) -> dict:
        return product_or_404(product_id).response()

    def simulation_area_response(product_id: str, area) -> dict:
        grid_manifest_url = (
            f"/api/dem-products/{product_id}/simulation-areas/"
            f"{area.area_hash}/grid/manifest"
        )
        return {
            "id": area.area_hash,
            "areaHash": area.area_hash,
            "demProductId": product_id,
            "datasetVersion": area.dataset_version,
            "crs": area.crs,
            "cellCount": area.cell_count,
            "areaM2": area.area_m2,
            "cellSizeM": area.cell_size_m,
            "triangleCount": area.cell_count * 2,
            "window": {
                "rowStart": area.window[0],
                "rowStop": area.window[1],
                "columnStart": area.window[2],
                "columnStop": area.window[3],
            },
            "elevationM": area.elevation_m,
            "gridManifestUrl": grid_manifest_url,
            "boundaryCondition": "transmissive",
        }

    @app.post(
        "/api/dem-products/{product_id}/simulation-areas/resolve",
        status_code=status.HTTP_201_CREATED,
    )
    def resolve_simulation_area(
        product_id: str, request: SimulationAreaResolveRequest
    ) -> dict:
        catalog = catalog_or_404(product_id, for_new_area=True)
        try:
            area = catalog.resolve(request.geometry)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return simulation_area_response(product_id, area)

    @app.get(
        "/api/dem-products/{product_id}/simulation-areas/{area_hash}"
    )
    def read_simulation_area(product_id: str, area_hash: str) -> dict:
        catalog = catalog_or_404(product_id)
        try:
            area = catalog.area(area_hash)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        return simulation_area_response(product_id, area)

    @app.get(
        "/api/dem-products/{product_id}/simulation-areas/"
        "{area_hash}/grid/manifest"
    )
    def simulation_area_grid_manifest(
        product_id: str, area_hash: str
    ) -> JSONResponse:
        catalog = catalog_or_404(product_id)
        try:
            manifest = catalog.grid_manifest(area_hash)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        payload = {
            **manifest,
            "tiles": [
                {
                    **tile,
                    "topologyUrl": (
                        f"/api/dem-products/{product_id}/simulation-areas/"
                        f"{area_hash}/grid/tiles/{tile['id']}/topology"
                    ),
                    "fieldUrl": (
                        f"/api/dem-products/{product_id}/simulation-areas/"
                        f"{area_hash}/grid/tiles/{tile['id']}/{{field}}"
                    ),
                }
                for tile in manifest["tiles"]
            ],
        }

        return JSONResponse(
            payload,
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

    @app.get(
        "/api/dem-products/{product_id}/simulation-areas/"
        "{area_hash}/grid/tiles/{tile_id}/{field}"
    )
    def simulation_area_grid_tile(
        product_id: str, area_hash: str, tile_id: str, field: str
    ) -> Response:
        catalog = catalog_or_404(product_id)
        try:
            tile = catalog.grid_tile_binary(area_hash, tile_id, field)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation grid tile not found"
            ) from error
        return Response(
            tile,
            media_type="application/vnd.bayuquan.simulation-grid-tile",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )

    @app.post(
        "/api/dem-products/{product_id}/simulation-areas/"
        "{area_hash}/elevation-profile"
    )
    def simulation_area_elevation_profile(
        product_id: str,
        area_hash: str,
        request: ElevationProfileRequest,
    ) -> dict:
        catalog = catalog_or_404(product_id)
        try:
            area = catalog.area(area_hash)
            return sample_elevation_profile(
                request.geometry,
                area,
                str(catalog.dem_path),
                spacing_m=request.spacing_m,
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/dem-products/{product_id}/simulation-areas/"
        "{area_hash}/hydraulic-mesh-preview"
    )
    def simulation_area_hydraulic_mesh_preview(
        product_id: str,
        area_hash: str,
        request: HydraulicMeshPreviewRequest,
    ) -> dict:
        catalog = catalog_or_404(product_id)
        try:
            area = catalog.area(area_hash)
            features = HydraulicFeaturesSpec.from_list(
                request.hydraulic_features
            )
            if not features.requires_custom_mesh:
                raise ValueError(
                    "mesh preview needs a levee or channel feature"
                )
            return feature_mesh_preview(
                features, area, str(catalog.dem_path)
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(
        "/api/dem-products/{product_id}/simulation-areas/"
        "{area_hash}/selection/resolve"
    )
    def resolve_simulation_area_selection(
        product_id: str,
        area_hash: str,
        request: GridSelectionRequest,
    ) -> dict:
        catalog = catalog_or_404(product_id)
        try:
            return catalog.resolve_selection(
                area_hash, request.cell_ids, request.friction_scenario
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/dem-products/{product_id}/tilejson")
    def model_dem_tilejson(product_id: str) -> dict:
        product = product_or_404(product_id)
        return {
            "tilejson": "3.0.0",
            "name": product.name,
            "tiles": [
                f"/api/dem-products/{product.id}/tiles/"
                "{z}/{x}/{y}.png"
            ],
            "minzoom": 0,
            "maxzoom": 18,
        }

    @app.get("/api/dem-products/{product_id}/tiles/{z}/{x}/{y}.png")
    def model_dem_tile(
        product_id: str, z: int, x: int, y: int
    ) -> Response:
        product = product_or_404(product_id)
        response = httpx.get(
            f"{settings.titiler_url}/cog/tiles/WebMercatorQuad/"
            f"{z}/{x}/{y}.png",
            params={
                "url": product.dem_uri,
                "bidx": 1,
                "rescale": "-36,100",
                "colormap_name": "terrain",
                "resampling": "bilinear",
            },
            timeout=20,
        )
        if response.status_code == 404:
            return Response(
                content=TRANSPARENT_TILE,
                media_type="image/png",
                headers={"cache-control": "public, max-age=86400"},
            )
        if response.status_code != 200:
            raise HTTPException(
                status_code=502, detail="DEM tile renderer failed"
            )
        return Response(
            content=response.content,
            media_type="image/png",
            headers={"cache-control": "public, max-age=86400"},
        )

    @app.get("/api/dem-products/{product_id}/terrain/tilejson")
    def model_terrain_tilejson(product_id: str) -> dict:
        product = product_or_404(product_id)
        return {
            "tilejson": "3.0.0",
            "name": f"{product.name} 3D terrain",
            "tiles": [
                f"/api/dem-products/{product.id}/terrain/tiles/"
                "{z}/{x}/{y}.png"
            ],
            "minzoom": 0,
            "maxzoom": 14,
            "encoding": "mapbox",
        }

    @app.get(
        "/api/dem-products/{product_id}/terrain/tiles/{z}/{x}/{y}.png"
    )
    def model_terrain_tile(
        product_id: str, z: int, x: int, y: int
    ) -> Response:
        product = product_or_404(product_id)
        response = httpx.get(
            f"{settings.titiler_url}/cog/tiles/WebMercatorQuad/"
            f"{z}/{x}/{y}.png",
            params={
                "url": product.dem_uri,
                "bidx": 1,
                "resampling": "bilinear",
                "algorithm": "terrainrgb",
            },
            timeout=20,
        )
        cache_headers = {
            "cache-control": "public, max-age=2592000, immutable"
        }
        if response.status_code == 404:
            return Response(
                content=TRANSPARENT_TILE,
                media_type="image/png",
                headers=cache_headers,
            )
        if response.status_code != 200:
            raise HTTPException(
                status_code=502, detail="terrain tile renderer failed"
            )
        return Response(
            content=response.content,
            media_type="image/png",
            headers=cache_headers,
        )

    @app.post("/api/scenarios", status_code=status.HTTP_201_CREATED)
    def create_scenario(
        request: ScenarioRequest,
        session: Session = Depends(session_dependency),
    ) -> dict:
        payload = request.snapshot()
        catalog = catalog_or_404(request.dem_product_id, for_new_area=True)
        validation = validate_scenario(payload, catalog)
        if not validation["valid"]:
            raise HTTPException(status_code=422, detail=validation)
        scenario = save_scenario(session, request)
        session.commit()
        return scenario_response(scenario)

    @app.get("/api/scenarios")
    def list_scenarios(
        session: Session = Depends(session_dependency),
    ) -> list[dict]:
        scenarios = session.scalars(
            scenario_query().order_by(Scenario.updated_at.desc())
        ).all()
        return [scenario_response(item) for item in scenarios]

    @app.get("/api/scenarios/{scenario_id}")
    def read_scenario(
        scenario_id: str,
        session: Session = Depends(session_dependency),
    ) -> dict:
        scenario = get_scenario(session, scenario_id)
        if scenario is None:
            raise HTTPException(status_code=404, detail="scenario not found")
        return scenario_response(scenario)

    @app.put("/api/scenarios/{scenario_id}")
    def update_scenario(
        scenario_id: str,
        request: ScenarioRequest,
        session: Session = Depends(session_dependency),
    ) -> dict:
        scenario = get_scenario(session, scenario_id)
        if scenario is None:
            raise HTTPException(status_code=404, detail="scenario not found")
        if request.dem_product_id != scenario.dem_product_id:
            raise HTTPException(
                status_code=409,
                detail="DEM product is locked after area resolution",
            )
        catalog = catalog_or_404(request.dem_product_id)
        validation = validate_scenario(request.snapshot(), catalog)
        if not validation["valid"]:
            raise HTTPException(status_code=422, detail=validation)
        scenario = save_scenario(session, request, scenario)
        session.commit()
        return scenario_response(scenario)

    @app.post("/api/scenarios/{scenario_id}/validate")
    def validate_saved_scenario(
        scenario_id: str,
        session: Session = Depends(session_dependency),
    ) -> dict:
        scenario = get_scenario(session, scenario_id)
        if scenario is None:
            raise HTTPException(status_code=404, detail="scenario not found")
        catalog = catalog_or_404(scenario.dem_product_id)
        return validate_scenario(scenario_snapshot(scenario), catalog)

    @app.post(
        "/api/scenarios/{scenario_id}/jobs",
        status_code=status.HTTP_202_ACCEPTED,
    )
    def create_job(
        scenario_id: str,
        request: JobCreateRequest,
        session: Session = Depends(session_dependency),
    ) -> dict:
        scenario = get_scenario(session, scenario_id)
        if scenario is None:
            raise HTTPException(status_code=404, detail="scenario not found")
        product = product_or_404(scenario.dem_product_id)
        catalog = catalog_or_404(scenario.dem_product_id)
        snapshot = scenario_snapshot(scenario)
        snapshot["demProduct"] = product.response()
        snapshot["simulationArea"] = catalog.snapshot(
            scenario.simulation_area_hash
        )
        validation = validate_scenario(snapshot, catalog)
        if not validation["valid"]:
            raise HTTPException(status_code=422, detail=validation)
        if validation["warnings"] and not request.confirm_warnings:
            raise HTTPException(status_code=409, detail=validation)
        job = SimulationJob(
            scenario_id=scenario.id,
            dem_product_id=scenario.dem_product_id,
            simulation_area_hash=scenario.simulation_area_hash,
            status="QUEUED",
            scenario_snapshot=snapshot,
            frame_count=validation["summary"]["frameCount"],
        )
        session.add(job)
        session.commit()
        app.state.dispatcher(job.id, product.resource_queue)
        return job_response(job)

    @app.get("/api/jobs")
    def list_jobs(
        session: Session = Depends(session_dependency),
        limit: int = Query(default=50, ge=1, le=200),
    ) -> list[dict]:
        jobs = session.scalars(
            select(SimulationJob)
            .order_by(SimulationJob.created_at.desc())
            .limit(limit)
        ).all()
        return [job_response(job) for job in jobs]

    @app.get("/api/jobs/{job_id}")
    def read_job(
        job_id: str,
        session: Session = Depends(session_dependency),
    ) -> dict:
        job = session.get(SimulationJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job_response(job)

    @app.get("/api/jobs/{job_id}/frames")
    def list_frames(
        job_id: str,
        session: Session = Depends(session_dependency),
    ) -> list[dict]:
        if session.get(SimulationJob, job_id) is None:
            raise HTTPException(status_code=404, detail="job not found")
        frames = session.scalars(
            select(SimulationFrame)
            .where(SimulationFrame.job_id == job_id)
            .order_by(SimulationFrame.frame_index)
        ).all()
        return [frame_response(frame) for frame in frames]

    @app.get("/api/jobs/{job_id}/frames/{frame_index}")
    def read_frame(
        job_id: str,
        frame_index: int,
        session: Session = Depends(session_dependency),
    ) -> dict:
        frame = session.get(SimulationFrame, (job_id, frame_index))
        if frame is None:
            raise HTTPException(status_code=404, detail="frame not found")
        return frame_response(frame)

    @app.get("/api/jobs/{job_id}/frames/{frame_index}/point")
    def frame_point(
        job_id: str,
        frame_index: int,
        longitude: float = Query(ge=-180, le=180),
        latitude: float = Query(ge=-90, le=90),
        session: Session = Depends(session_dependency),
    ) -> dict:
        frame = session.get(SimulationFrame, (job_id, frame_index))
        if frame is None:
            raise HTTPException(status_code=404, detail="frame not found")
        response = httpx.get(
            f"{settings.titiler_url}/cog/point/{longitude},{latitude}",
            params={"url": frame.cog_uri},
            timeout=20,
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=502, detail="point sampler failed"
            )
        values = response.json().get("values", [])
        if len(values) < 3:
            raise HTTPException(
                status_code=502, detail="point sampler returned invalid data"
            )
        normalized = [
            None if value is None or value == -9999 else float(value)
            for value in values[:3]
        ]
        return {
            "timeSeconds": frame.time_seconds,
            "longitude": longitude,
            "latitude": latitude,
            "depthM": normalized[0],
            "stageM": normalized[1],
            "speedMps": normalized[2],
        }

    @app.get("/api/jobs/{job_id}/frames/{frame_index}/flow")
    def frame_flow_field(
        job_id: str,
        frame_index: int,
        max_dim: int = Query(default=512, ge=16, le=4096),
        session: Session = Depends(session_dependency),
    ) -> Response:
        frame = session.get(SimulationFrame, (job_id, frame_index))
        if frame is None:
            raise HTTPException(status_code=404, detail="frame not found")
        try:
            with ExitStack() as stack:
                if frame.cog_uri.startswith("s3://"):
                    parsed = urlparse(frame.cog_uri)
                    if not parsed.netloc or not parsed.path.lstrip("/"):
                        raise ValueError("invalid frame object URI")
                    stored = app.state.s3_client.get_object(
                        Bucket=parsed.netloc,
                        Key=parsed.path.lstrip("/"),
                    )
                    body = stored["Body"]
                    try:
                        payload = body.read()
                    finally:
                        body.close()
                    memory_file = stack.enter_context(MemoryFile(payload))
                    dataset = stack.enter_context(memory_file.open())
                else:
                    dataset = stack.enter_context(
                        rasterio.open(frame.cog_uri)
                    )
                if dataset.count < 5:
                    raise HTTPException(
                        status_code=409,
                        detail="flow field is unavailable for this frame",
                    )
                scale = max(
                    1,
                    math.ceil(
                        max(dataset.width, dataset.height) / max_dim
                    ),
                )
                out_shape = (
                    max(1, round(dataset.height / scale)),
                    max(1, round(dataset.width / scale)),
                )
                with warnings.catch_warnings():
                    warnings.filterwarnings(
                        "ignore",
                        message="Setting the shape on a NumPy array.*",
                        category=DeprecationWarning,
                    )
                    read = partial(
                        dataset.read,
                        out_shape=out_shape,
                        resampling=Resampling.bilinear,
                    )
                    depth = read(1).astype("<f4", copy=False)
                    stage = read(2).astype("<f4", copy=False)
                    velocity_u = read(4).astype("<f4", copy=False)
                    velocity_v = read(5).astype("<f4", copy=False)
                    wet = dataset.read_masks(
                        1, out_shape=out_shape,
                        resampling=Resampling.bilinear,
                    ) > 0
                wet &= (
                    np.isfinite(depth)
                    & np.isfinite(stage)
                    & np.isfinite(velocity_u)
                    & np.isfinite(velocity_v)
                )
                # Preserve the orientation of the source raster grid. A UTM
                # grid is rotated relative to a longitude/latitude bounding
                # box; encoding only transform_bounds displaced its corners
                # by roughly two 10 m cells over a 2.3 km result area.
                transformer = Transformer.from_crs(
                    dataset.crs, "OGC:CRS84", always_xy=True
                )
                left, bottom, right, top = dataset.bounds
                corner_x, corner_y = transformer.transform(
                    [left, right, left, right],
                    [top, top, bottom, bottom],
                )
                grid_corners = tuple(
                    coordinate
                    for pair in zip(corner_x, corner_y)
                    for coordinate in pair
                )
                # Version 4 packs (u, v, depth, stage) per cell as float16 in
                # texture-ready RGBA order: browsers upload the payload
                # verbatim as an RGBA16F texture. Dry cells use the exact
                # float16 sentinel depth = -1 so no NaN ever reaches a GPU
                # sampler. Its header carries the exact projected-grid corners.
                texels = np.zeros(
                    (out_shape[0], out_shape[1], 4), dtype="<f2"
                )
                texels[..., 0] = velocity_u
                texels[..., 1] = velocity_v
                texels[..., 2] = depth
                texels[..., 3] = stage
                texels[~wet] = (0, 0, -1, 0)
                header = struct.pack(
                    "<4sHHHH8d",
                    b"BQFV",
                    4,
                    out_shape[1],
                    out_shape[0],
                    0,
                    *grid_corners,
                )
        except HTTPException:
            raise
        except (
            BotoCoreError,
            ClientError,
            OSError,
            ValueError,
            rasterio.errors.RasterioError,
        ) as error:
            raise HTTPException(
                status_code=502, detail="flow field could not be read"
            ) from error
        return Response(
            content=header + texels.tobytes(order="C"),
            media_type="application/vnd.bayuquan.flow-field",
            headers={"cache-control": "public, max-age=3600, immutable"},
        )

    @app.get(
        "/api/jobs/{job_id}/frames/{frame_index}/tilejson/{quantity}"
    )
    def frame_tilejson(
        job_id: str,
        frame_index: int,
        quantity: str,
        session: Session = Depends(session_dependency),
    ) -> dict:
        _quantity_band(quantity)
        if session.get(SimulationFrame, (job_id, frame_index)) is None:
            raise HTTPException(status_code=404, detail="frame not found")
        tile_url = (
            f"/api/jobs/{job_id}/frames/{frame_index}/tiles/"
            f"{quantity}/{{z}}/{{x}}/{{y}}.png"
        )
        return {
            "tilejson": "3.0.0",
            "name": f"{quantity} at frame {frame_index}",
            "tiles": [tile_url],
            "minzoom": 0,
            "maxzoom": 22,
        }

    @app.get(
        "/api/jobs/{job_id}/frames/{frame_index}/tiles/"
        "{quantity}/{z}/{x}/{y}.png"
    )
    def frame_tile(
        job_id: str,
        frame_index: int,
        quantity: str,
        z: int,
        x: int,
        y: int,
        session: Session = Depends(session_dependency),
    ) -> Response:
        band, value_range, colormap = _quantity_band(quantity)
        frame = session.get(SimulationFrame, (job_id, frame_index))
        if frame is None:
            raise HTTPException(status_code=404, detail="frame not found")
        upstream = (
            f"{settings.titiler_url}/cog/tiles/WebMercatorQuad/"
            f"{z}/{x}/{y}.png"
        )
        response = httpx.get(
            upstream,
            params={
                "url": frame.cog_uri,
                "bidx": band,
                "rescale": value_range,
                "colormap_name": colormap,
            },
            timeout=20,
        )
        if response.status_code == 404:
            return Response(
                content=TRANSPARENT_TILE,
                media_type="image/png",
                headers={"cache-control": "public, max-age=3600"},
            )
        if response.status_code != 200:
            raise HTTPException(
                status_code=502, detail="tile renderer failed"
            )
        depth_response = httpx.get(
            upstream.removesuffix(".png") + ".tif",
            params={"url": frame.cog_uri, "bidx": 1},
            timeout=20,
        )
        if depth_response.status_code != 200:
            raise HTTPException(
                status_code=502, detail="tile mask renderer failed"
            )
        masked = _apply_depth_mask(
            response.content, depth_response.content
        )
        return Response(content=masked, media_type="image/png")

    @app.get("/api/full-previews/config")
    def full_preview_config() -> dict:
        cache = settings.full_preview_cache
        window = settings.full_preview_window
        try:
            product = product_or_404(settings.full_preview_dem_product_id)
        except HTTPException:
            product = None
        readiness = _full_preview_readiness(
            product=product,
            cache=cache,
            window=window,
            memo=preview_readiness_cache,
        )
        return {
            "available": readiness["available"],
            "domainId": settings.full_preview_domain_id,
            "demProductId": settings.full_preview_dem_product_id,
            "durationHours": 24,
            "rainfallLimitsMm": {"minimum": 0.1, "maximum": 500},
            "cacheStatus": readiness["cacheStatus"],
            "readinessError": readiness.get("error"),
            "windowConfigured": window is not None,
            "datasetVersion": (
                product.dataset_version if product is not None else None
            ),
            "cacheIdentityHash": readiness.get("cacheIdentityHash"),
            "assumptionsProfile": {
                "id": "terrain-storage-v1",
                "name": "地形蓄水快览 V1",
                "runoffCoefficient": (
                    settings.full_preview_runoff_coefficient
                ),
                "drainageIncluded": False,
                "infiltrationIncluded": (
                    settings.full_preview_runoff_coefficient < 1.0
                ),
                "spatialDistribution": "uniform",
            },
            "authority": "non-authoritative",
        }

    @app.post(
        "/api/full-previews", status_code=status.HTTP_201_CREATED
    )
    def create_full_preview(
        request: FullPreviewCreateRequest,
        session: Session = Depends(session_dependency),
    ) -> dict:
        config = full_preview_config()
        if not config["available"]:
            raise HTTPException(
                status_code=409,
                detail="full preview preprocessing cache is not ready",
            )
        coefficient = settings.full_preview_runoff_coefficient
        if not 0.0 < coefficient <= 1.0:
            raise HTTPException(
                status_code=503,
                detail="full preview runoff coefficient is invalid",
            )
        identity_hash = config["cacheIdentityHash"]
        compatibility_version = _compatibility_version(
            dataset_version=config["datasetVersion"],
            domain_id=config["domainId"],
            assumptions_profile_id=config["assumptionsProfile"]["id"],
            runoff_coefficient=coefficient,
            cache_identity_hash=identity_hash,
        )
        job = FullPreviewJob(
            dem_product_id=settings.full_preview_dem_product_id,
            domain_id=settings.full_preview_domain_id,
            dataset_version=config["datasetVersion"],
            assumptions_profile_id="terrain-storage-v1",
            runoff_coefficient=coefficient,
            cache_identity_hash=identity_hash,
            compatibility_version=compatibility_version,
            rainfall_depth_mm=request.rainfall_depth_mm,
            effective_rainfall_depth_mm=(
                request.rainfall_depth_mm * coefficient
            ),
            status="QUEUED",
            phase="QUEUED",
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        try:
            app.state.preview_dispatcher(job.id, settings.full_preview_queue)
        except Exception as error:
            job.status = "FAILED"
            job.phase = "FAILED"
            job.completed_at = utcnow()
            job.error_code = "FULL_PREVIEW_DISPATCH_FAILED"
            job.error_message = str(error)[:2000]
            session.commit()
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="full preview dispatch failed",
            ) from error
        return full_preview_response(job)

    @app.get("/api/full-previews")
    def list_full_previews(
        limit: int = Query(default=100, ge=1, le=500),
        session: Session = Depends(session_dependency),
    ) -> list[dict]:
        jobs = session.scalars(
            select(FullPreviewJob)
            .order_by(FullPreviewJob.created_at.desc())
            .limit(limit)
        ).all()
        return [full_preview_response(job) for job in jobs]

    @app.get("/api/full-previews/{job_id}")
    def read_full_preview(
        job_id: str,
        session: Session = Depends(session_dependency),
    ) -> dict:
        job = session.get(FullPreviewJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="preview not found")
        return full_preview_response(job)

    @app.get("/api/full-previews/{job_id}/events")
    async def full_preview_events(
        job_id: str, request: Request,
    ) -> StreamingResponse:
        with database.session_factory() as session:
            if session.get(FullPreviewJob, job_id) is None:
                raise HTTPException(
                    status_code=404, detail="preview not found"
                )

        async def events():
            previous = None
            while True:
                if await request.is_disconnected():
                    return
                with database.session_factory() as session:
                    job = session.get(FullPreviewJob, job_id)
                    if job is None:
                        return
                    response = full_preview_response(job)
                    marker = (job.status, job.phase)
                    if marker != previous:
                        previous = marker
                        yield _sse("preview.status", response)
                    if job.status == "COMPLETED":
                        yield _sse("preview.completed", response)
                        return
                    if job.status == "FAILED":
                        yield _sse("preview.failed", response)
                        return
                await asyncio.sleep(0.5)

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/api/full-previews/{job_id}/tilejson")
    def full_preview_tilejson(
        job_id: str,
        threshold_m: float = Query(default=0.05, ge=0.0, le=10.0),
        session: Session = Depends(session_dependency),
    ) -> dict:
        job = completed_full_preview_or_404(session, job_id)
        return {
            "tilejson": "3.0.0",
            "name": f"maximum depth preview {job_id}",
            "tiles": [
                (
                    f"/api/full-previews/{job_id}/tiles/"
                    f"{{z}}/{{x}}/{{y}}.png?thresholdM={threshold_m:g}"
                )
            ],
            "bounds": job.bounds,
            "minzoom": 0,
            "maxzoom": 22,
        }

    @app.get(
        "/api/full-previews/{job_id}/tiles/{z}/{x}/{y}.png"
    )
    def full_preview_tile(
        job_id: str,
        z: int,
        x: int,
        y: int,
        threshold_m: float = Query(
            default=0.05, alias="thresholdM", ge=0.0, le=10.0
        ),
        session: Session = Depends(session_dependency),
    ) -> Response:
        job = completed_full_preview_or_404(session, job_id)
        upstream = (
            f"{settings.titiler_url}/cog/tiles/WebMercatorQuad/"
            f"{z}/{x}/{y}.png"
        )
        response = httpx.get(
            upstream,
            params={
                "url": job.result_cog_uri,
                "rescale": f"{threshold_m:g},3",
                "colormap_name": "blues",
                "nodata": -9999,
            },
            timeout=20,
        )
        if response.status_code == 404:
            return Response(content=TRANSPARENT_TILE, media_type="image/png")
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="tile renderer failed")
        depth_response = httpx.get(
            upstream.removesuffix(".png") + ".tif",
            params={"url": job.result_cog_uri, "bidx": 1},
            timeout=20,
        )
        if depth_response.status_code != 200:
            raise HTTPException(
                status_code=502, detail="tile mask renderer failed"
            )
        masked = _apply_depth_mask(
            response.content, depth_response.content, threshold_m=threshold_m
        )
        return Response(content=masked, media_type="image/png")

    @app.get("/api/full-previews/{job_id}/point")
    def full_preview_point(
        job_id: str,
        longitude: float,
        latitude: float,
        session: Session = Depends(session_dependency),
    ) -> dict:
        job = completed_full_preview_or_404(session, job_id)
        response = httpx.get(
            f"{settings.titiler_url}/cog/point/{longitude},{latitude}",
            params={"url": job.result_cog_uri, "bidx": 1},
            timeout=20,
        )
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="point query failed")
        values = response.json().get("values", [])
        value = values[0] if values else None
        if isinstance(value, list):
            value = value[0] if value else None
        if value is None or value == -9999 or not math.isfinite(float(value)):
            value = None
        return {
            "longitude": longitude,
            "latitude": latitude,
            "maximumDepthM": value,
        }

    @app.get("/api/full-previews/{job_id}/result.cog")
    def download_full_preview(
        job_id: str,
        session: Session = Depends(session_dependency),
    ) -> StreamingResponse:
        job = completed_full_preview_or_404(session, job_id)
        bucket, key = _s3_location(job.result_cog_uri)
        try:
            stored = app.state.s3_client.get_object(
                Bucket=bucket, Key=key
            )
        except (BotoCoreError, ClientError) as error:
            raise HTTPException(
                status_code=502, detail="preview COG download failed"
            ) from error
        body = stored["Body"]

        def content():
            try:
                while block := body.read(1024 * 1024):
                    yield block
            finally:
                body.close()

        headers = {
            "content-disposition": (
                f'attachment; filename="full-preview-{job.id}.cog.tif"'
            ),
            "cache-control": "private, no-store",
        }
        if stored.get("ContentLength") is not None:
            headers["content-length"] = str(stored["ContentLength"])
        return StreamingResponse(
            content(),
            media_type=stored.get("ContentType", "image/tiff"),
            headers=headers,
        )

    @app.get("/api/jobs/{job_id}/events")
    async def job_events(job_id: str, request: Request) -> StreamingResponse:
        raw_cursor = request.headers.get("last-event-id", "-1")
        try:
            cursor = int(raw_cursor)
        except ValueError:
            cursor = -1

        async def events():
            nonlocal cursor
            previous_status = None
            while True:
                with database.session_factory() as session:
                    job = session.get(SimulationJob, job_id)
                    if job is None:
                        yield _sse("job.failed", {
                            "errorCode": "JOB_NOT_FOUND",
                            "message": "job not found",
                        })
                        return
                    frames = session.scalars(
                        select(SimulationFrame)
                        .where(
                            SimulationFrame.job_id == job_id,
                            SimulationFrame.frame_index > cursor,
                        )
                        .order_by(SimulationFrame.frame_index)
                    ).all()
                    for frame in frames:
                        cursor = frame.frame_index
                        yield _sse(
                            "frame.ready",
                            frame_response(frame),
                            event_id=str(cursor),
                        )
                    if job.status != previous_status:
                        previous_status = job.status
                        yield _sse("job.status", job_response(job))
                    if job.status == "COMPLETED":
                        yield _sse("job.completed", job_response(job))
                        return
                    if job.status == "FAILED":
                        yield _sse("job.failed", job_response(job))
                        return
                await asyncio.sleep(0.5)

        return StreamingResponse(events(), media_type="text/event-stream")

    return app


class _SingleProductCatalog:
    """Compatibility adapter for focused tests injecting one area catalog."""

    def __init__(self, area_catalog: SimulationAreaCatalog):
        metadata = area_catalog.metadata()
        self.product = DemProductView(
            id="dem-test",
            name="Test DEM",
            status="active",
            is_default=True,
            dataset_version=metadata["datasetVersion"],
            dem_uri=str(getattr(area_catalog, "dem_path", "/test/dem.tif")),
            model_inputs_uri=str(
                getattr(area_catalog, "model_inputs_path", "/test/inputs.tif")
            ),
            dem_sha256="0" * 64,
            model_inputs_sha256="1" * 64,
            crs=metadata["crs"],
            vertical_datum="test-datum",
            elevation_unit="m",
            cell_size_m=float(metadata["cellSizeM"]),
            source_resolution_m=float(metadata["cellSizeM"]),
            resampling_method="original",
            max_cells=int(metadata.get("maxSimulationAreaCells", 25_000)),
            resource_queue="standard",
            metadata={},
        )
        self.catalog = area_catalog

    def list(self, *, include_unavailable: bool = False):
        return [self.product]

    def get(self, product_id: str, *, for_new_area: bool = False):
        if product_id != self.product.id:
            raise KeyError(product_id)
        return self.product

    def default(self):
        return self.product

    def area_catalog(self, product_id: str, *, for_new_area: bool = False):
        self.get(product_id, for_new_area=for_new_area)
        return self.catalog


def _single_product_catalog(area_catalog: SimulationAreaCatalog):
    return _SingleProductCatalog(area_catalog)


def _full_preview_dispatcher(settings: Settings) -> JobDispatcher:
    if not settings.dispatch_jobs:
        return lambda job_id, queue: None

    def dispatch(job_id: str, queue: str) -> None:
        from celery import Celery
        celery = Celery(broker=settings.celery_broker_url)
        celery.send_task("bayuquan.run_full_preview", args=[job_id], queue=queue)

    return dispatch


def _celery_dispatcher(settings: Settings) -> JobDispatcher:
    if not settings.dispatch_jobs:
        return lambda job_id, queue: None

    def dispatch(job_id: str, queue: str) -> None:
        from celery import Celery
        celery = Celery(broker=settings.celery_broker_url)
        celery.send_task("bayuquan.run_job", args=[job_id], queue=queue)

    return dispatch


def completed_full_preview_or_404(
    session: Session, job_id: str
) -> FullPreviewJob:
    job = session.get(FullPreviewJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="preview not found")
    if job.status != "COMPLETED" or not job.result_cog_uri:
        raise HTTPException(status_code=409, detail="preview is not completed")
    return job


def _full_preview_readiness(
    *,
    product: DemProductView | None,
    cache,
    window: tuple[int, int, int, int] | None,
    memo: dict[tuple, dict],
) -> dict:
    if cache is None or not cache.is_file():
        return {
            "available": False,
            "cacheStatus": "MISSING",
            "error": "preprocessing cache is missing",
        }
    if product is None:
        return {
            "available": False,
            "cacheStatus": "INVALID",
            "error": "DEM product is unavailable",
        }
    if window is None:
        return {
            "available": False,
            "cacheStatus": "INVALID",
            "error": "full preview domain window is not configured",
        }

    dem_path = Path(product.compute_dem_uri)
    try:
        cache_stat = cache.stat()
        dem_stat = dem_path.stat()
    except OSError:
        return {
            "available": False,
            "cacheStatus": "INVALID",
            "error": "DEM or preprocessing cache cannot be read",
        }
    signature = (
        str(cache.resolve()), cache_stat.st_size, cache_stat.st_mtime_ns,
        str(dem_path.resolve()), dem_stat.st_size, dem_stat.st_mtime_ns,
        product.dataset_version, window,
    )
    cached = memo.get(signature)
    if cached is not None:
        return cached

    try:
        column, row, width, height = window
        with rasterio.open(dem_path) as source:
            if (
                column < 0 or row < 0 or width <= 0 or height <= 0
                or column + width > source.width
                or row + height > source.height
            ):
                raise ValueError("full preview window is outside the DEM")
            source_window = rasterio.windows.Window(*window)
            transform = source.window_transform(source_window)
        identity = cache_identity(
            dem_path=dem_path,
            window=window,
            transform=tuple(transform),
        )
        preprocessed = load_preprocessed(
            cache, expected_identity=identity
        )
        if preprocessed.basin_ids.shape != (height, width):
            raise PreprocessingCacheMismatch(
                "preprocessing basin shape does not match domain window"
            )
    except (
        OSError,
        PreprocessingCacheMismatch,
        ValueError,
        rasterio.errors.RasterioError,
    ) as error:
        result = {
            "available": False,
            "cacheStatus": "INVALID",
            "error": str(error),
        }
    else:
        result = {
            "available": True,
            "cacheStatus": "READY",
            "cacheIdentityHash": hashlib.sha256(
                identity.encode()
            ).hexdigest(),
        }
    memo.clear()
    memo[signature] = result
    return result


def _compatibility_version(
    *,
    dataset_version: str,
    domain_id: str,
    assumptions_profile_id: str,
    runoff_coefficient: float,
    cache_identity_hash: str,
) -> str:
    identity = json.dumps({
        "datasetVersion": dataset_version,
        "domainId": domain_id,
        "assumptionsProfileId": assumptions_profile_id,
        "runoffCoefficient": runoff_coefficient,
        "cacheIdentityHash": cache_identity_hash,
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(identity.encode()).hexdigest()


def full_preview_response(job: FullPreviewJob) -> dict:
    result = None
    if job.result_cog_uri:
        result = {
            "tilejsonUrl": f"/api/full-previews/{job.id}/tilejson",
            "cogDownloadUrl": f"/api/full-previews/{job.id}/result.cog",
            "bounds": job.bounds,
            "maximumDepthM": job.maximum_depth_m,
            "wetAreaM2": job.wet_area_m2,
            "thresholdAreasM2": job.threshold_areas_m2 or {},
            "inputVolumeM3": job.input_volume_m3,
            "retainedVolumeM3": job.retained_volume_m3,
            "outflowVolumeM3": job.outflow_volume_m3,
            "massBalanceErrorM3": job.mass_balance_error_m3,
        }
    return {
        "id": job.id,
        "status": job.status,
        "phase": job.phase,
        "demProductId": job.dem_product_id,
        "domainId": job.domain_id,
        "datasetVersion": job.dataset_version,
        "rainfallDepthMm": job.rainfall_depth_mm,
        "effectiveRainfallDepthMm": job.effective_rainfall_depth_mm,
        "assumptionsProfileId": job.assumptions_profile_id,
        "runoffCoefficient": job.runoff_coefficient,
        "cacheIdentityHash": job.cache_identity_hash,
        "compatibilityVersion": job.compatibility_version,
        "cacheHit": job.cache_hit,
        "result": result,
        "errorCode": job.error_code,
        "errorMessage": job.error_message,
        "createdAt": job.created_at,
        "startedAt": job.started_at,
        "completedAt": job.completed_at,
        "authority": "non-authoritative",
    }


def _s3_location(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path:
        raise HTTPException(status_code=500, detail="artifact URI is invalid")
    return parsed.netloc, parsed.path.lstrip("/")


def job_response(job: SimulationJob) -> dict:
    return {
        "id": job.id,
        "scenarioId": job.scenario_id,
        "demProductId": job.dem_product_id,
        "simulationAreaId": job.simulation_area_hash,
        "simulationAreaBounds": _simulation_area_bounds(
            job.scenario_snapshot
        ),
        "scenarioSnapshot": job.scenario_snapshot,
        "status": job.status,
        "currentFrame": job.current_frame,
        "frameCount": job.frame_count,
        "simulationTimeSeconds": job.simulation_time_seconds,
        "maximumDepthM": job.maximum_depth_m,
        "appliedVolumeM3": job.applied_volume_m3,
        "finalWaterVolumeM3": job.final_water_volume_m3,
        "errorCode": job.error_code,
        "errorMessage": job.error_message,
        "createdAt": job.created_at,
        "startedAt": job.started_at,
        "completedAt": job.completed_at,
    }


def _simulation_area_bounds(snapshot: dict) -> list[float] | None:
    """Return the immutable area extent, or None for legacy snapshots."""
    area = snapshot.get("simulationArea")
    if area is None:
        return None
    row_start, row_stop, column_start, column_stop = area["window"]
    a, b, c, d, e, f = area["transform"]
    corners = [
        (column, row)
        for column in (column_start, column_stop)
        for row in (row_start, row_stop)
    ]
    projected = [
        (a * column + b * row + c, d * column + e * row + f)
        for column, row in corners
    ]
    transformer = Transformer.from_crs(
        area["crs"], "OGC:CRS84", always_xy=True
    )
    geographic = [transformer.transform(x, y) for x, y in projected]
    longitudes, latitudes = zip(*geographic)
    return [
        min(longitudes), min(latitudes),
        max(longitudes), max(latitudes),
    ]


def frame_response(frame: SimulationFrame) -> dict:
    return {
        "jobId": frame.job_id,
        "frameIndex": frame.frame_index,
        "timeSeconds": frame.time_seconds,
        "maximumDepthM": frame.maximum_depth_m,
        "maximumSpeedMps": frame.maximum_speed_mps,
        "wetAreaM2": frame.wet_area_m2,
        "tilejson": {
            quantity: (
                f"/api/jobs/{frame.job_id}/frames/{frame.frame_index}/"
                f"tilejson/{quantity}"
            )
            for quantity in ("depth", "stage", "speed")
        },
        "createdAt": frame.created_at,
    }


def _sse(event: str, data: dict, event_id: str | None = None) -> str:
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append("data: " + json.dumps(data, ensure_ascii=False, default=str))
    return "\n".join(lines) + "\n\n"


def _quantity_band(quantity: str) -> tuple[int, str, str]:
    styles = {
        "depth": (1, "0.01,3", "blues"),
        "stage": (2, "0,30", "viridis"),
        "speed": (3, "0,3", "ylorrd"),
    }
    try:
        return styles[quantity]
    except KeyError as error:
        raise HTTPException(
            status_code=404, detail="unknown frame quantity"
        ) from error


def _apply_depth_mask(
    png: bytes, depth_tiff: bytes, *, threshold_m: float = 0.01
) -> bytes:
    with MemoryFile(depth_tiff) as memory_file, memory_file.open() as dataset:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            depth = dataset.read(1)
    wet = np.isfinite(depth) & (depth >= threshold_m) & (depth != -9999)
    image = Image.open(BytesIO(png)).convert("RGBA")
    pixels = np.asarray(image).copy()
    pixels[..., 3] = np.where(wet, pixels[..., 3], 0)
    output = BytesIO()
    Image.fromarray(pixels).save(output, format="PNG")
    return output.getvalue()


def _transparent_tile() -> bytes:
    output = BytesIO()
    Image.new("RGBA", (256, 256), (0, 0, 0, 0)).save(
        output, format="PNG", optimize=True
    )
    return output.getvalue()


TRANSPARENT_TILE = _transparent_tile()
app = create_app()
