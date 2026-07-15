"""FastAPI application for Bayuquan scenarios and simulation jobs."""

from __future__ import annotations

import asyncio
import json
import warnings
from io import BytesIO

import numpy as np
from PIL import Image
from rasterio.io import MemoryFile
from collections.abc import Callable
from contextlib import asynccontextmanager
import httpx
from bayuquan.simulation.area_catalog import (
    SimulationAreaCatalog,
    model_input_version,
)
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi import status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .db import Database
from .models import (
    Scenario,
    SimulationFrame,
    SimulationJob,
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
    GridSelectionRequest,
    JobCreateRequest,
    ScenarioRequest,
    SimulationAreaResolveRequest,
)


JobDispatcher = Callable[[str], None]


def create_app(
    *,
    settings: Settings | None = None,
    database: Database | None = None,
    area_catalog: SimulationAreaCatalog | None = None,
    dispatcher: JobDispatcher | None = None,
) -> FastAPI:
    settings = settings or Settings.from_environment()
    database = database or Database(settings.database_url)
    model_dem_path = settings.model_dem_path or (
        settings.project_root / "OUTPUT/model/web/elevation_cog.tif"
    )
    area_cache = settings.simulation_area_cache or (
        settings.project_root / "simulation_areas"
    )
    if area_catalog is None:
        model_inputs_path = settings.model_inputs_path or (
            settings.project_root / "OUTPUT/model/web/model_inputs_cog.tif"
        )
        area_catalog = SimulationAreaCatalog(
            model_dem_path,
            area_cache,
            dataset_version=model_input_version(
                model_inputs_path, settings.model_dataset_version
            ),
            model_inputs_path=model_inputs_path,
            max_cells=settings.max_simulation_area_cells,
        )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.auto_create_schema:
            database.create_schema()
        yield

    app = FastAPI(
        title="Bayuquan ANUGA Web GIS API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.database = database
    app.state.area_catalog = area_catalog
    app.state.dispatcher = dispatcher or _celery_dispatcher(settings)

    def session_dependency() -> Session:
        with database.session_factory() as session:
            yield session

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "datasetVersion": area_catalog.metadata()["datasetVersion"],
        }

    @app.get("/api/model")
    def model_metadata() -> dict:
        return area_catalog.metadata()

    @app.post(
        "/api/model/simulation-areas/resolve",
        status_code=status.HTTP_201_CREATED,
    )
    def resolve_simulation_area(
        request: SimulationAreaResolveRequest,
    ) -> dict:
        try:
            area = area_catalog.resolve(request.geometry)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        grid_url = f"/api/model/simulation-areas/{area.area_hash}/grid"
        return {
            "id": area.area_hash,
            "areaHash": area.area_hash,
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
            "gridUrl": grid_url,
            "boundaryCondition": "transmissive",
        }

    @app.get("/api/model/simulation-areas/{area_hash}/grid")
    def simulation_area_grid(area_hash: str) -> JSONResponse:
        try:
            grid = area_catalog.grid(area_hash)
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        return JSONResponse(grid)

    @app.post(
        "/api/model/simulation-areas/{area_hash}/selection/resolve"
    )
    def resolve_simulation_area_selection(
        area_hash: str,
        request: GridSelectionRequest,
    ) -> dict:
        try:
            return area_catalog.resolve_selection(
                area_hash,
                request.cell_ids,
                request.friction_scenario,
            )
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="simulation area not found"
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/model/dem/tilejson")
    def model_dem_tilejson() -> dict:
        return {
            "tilejson": "3.0.0",
            "name": "Bayuquan DEM",
            "tiles": ["/api/model/dem/tiles/{z}/{x}/{y}.png"],
            "minzoom": 0,
            "maxzoom": 18,
        }

    @app.get("/api/model/dem/tiles/{z}/{x}/{y}.png")
    def model_dem_tile(z: int, x: int, y: int) -> Response:
        upstream = (
            f"{settings.titiler_url}/cog/tiles/WebMercatorQuad/"
            f"{z}/{x}/{y}.png"
        )
        response = httpx.get(
            upstream,
            params={
                "url": settings.model_dem_url,
                "bidx": 1,
                "rescale": "-36,100",
                "colormap_name": "terrain",
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

    @app.post("/api/scenarios", status_code=status.HTTP_201_CREATED)
    def create_scenario(
        request: ScenarioRequest,
        session: Session = Depends(session_dependency),
    ) -> dict:
        payload = request.snapshot()
        validation = validate_scenario(payload, area_catalog)
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
            scenario_query().order_by(Scenario.created_at)
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
        validation = validate_scenario(request.snapshot(), area_catalog)
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
        return validate_scenario(scenario_snapshot(scenario), area_catalog)

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
        snapshot = scenario_snapshot(scenario)
        snapshot["simulationArea"] = area_catalog.snapshot(
            scenario.simulation_area_hash
        )
        validation = validate_scenario(snapshot, area_catalog)
        if not validation["valid"]:
            raise HTTPException(status_code=422, detail=validation)
        if validation["warnings"] and not request.confirm_warnings:
            raise HTTPException(status_code=409, detail=validation)
        job = SimulationJob(
            scenario_id=scenario.id,
            simulation_area_hash=scenario.simulation_area_hash,
            status="QUEUED",
            scenario_snapshot=snapshot,
            frame_count=validation["summary"]["frameCount"],
        )
        session.add(job)
        session.commit()
        app.state.dispatcher(job.id)
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


def _celery_dispatcher(settings: Settings) -> JobDispatcher:
    if not settings.dispatch_jobs:
        return lambda job_id: None

    def dispatch(job_id: str) -> None:
        from celery import Celery
        celery = Celery(broker=settings.celery_broker_url)
        celery.send_task("bayuquan.run_job", args=[job_id])

    return dispatch


def job_response(job: SimulationJob) -> dict:
    return {
        "id": job.id,
        "scenarioId": job.scenario_id,
        "simulationAreaId": job.simulation_area_hash,
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


def _apply_depth_mask(png: bytes, depth_tiff: bytes) -> bytes:
    with MemoryFile(depth_tiff) as memory_file:
        with memory_file.open() as dataset:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                depth = dataset.read(1)
    wet = np.isfinite(depth) & (depth >= 0.01) & (depth != -9999)
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
