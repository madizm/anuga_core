#!/usr/bin/env python3
"""Run a validated multi-inlet scenario on the fixed Bayuquan mesh."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from bayuquan.raster import CogWriter, FrameRasterizer
from bayuquan.raster import RasterInterpolationMapping
from bayuquan.simulation.fixed_model import FixedModelPaths
from bayuquan.simulation.grid_mapping import GridTriangleMapping
from bayuquan.simulation.runner import run_simulation, snapshot_scenario
from bayuquan.simulation.spec import ScenarioSpec


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scenario",
        type=Path,
        default=Path("/workspace/bayuquan/default_scenario.json"),
        help="Multi-inlet scenario JSON",
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path("/workspace"),
        help="Repository root containing OUTPUT/model",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/workspace/OUTPUT/model/web_gis_run"),
    )
    parser.add_argument(
        "--no-sww",
        action="store_true",
        help="Do not write the optional ANUGA SWW result file",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    paths = FixedModelPaths.under(args.project_root)
    mapping = GridTriangleMapping.load(paths.mapping)
    spec = ScenarioSpec.load(args.scenario, mapping)
    raster_mapping = RasterInterpolationMapping.load(
        paths.raster_mapping,
        mesh_path=paths.mesh,
        triangle_count=len(mapping.triangle_cell_index),
    )
    rasterizer = FrameRasterizer(raster_mapping)
    cog_writer = CogWriter(raster_mapping.grid)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    snapshot_scenario(args.scenario, args.output_dir)

    print(
        f"Running {spec.name!r}: {len(spec.inlets)} inlet(s), "
        f"Q={spec.total_discharge_m3s:g} m3/s, "
        f"duration={spec.duration_seconds:g} s",
        flush=True,
    )

    def progress(time_seconds: float, frame_index: int) -> None:
        print(
            f"frame={frame_index} t={time_seconds:g}/"
            f"{spec.duration_seconds:g} s",
            flush=True,
        )

    def publish_frame(domain, time_seconds: float, frame_index: int) -> None:
        frame = rasterizer.rasterize(domain, time_seconds)
        filename = f"{int(time_seconds):09d}.tif"
        written = cog_writer.write(
            frame, args.output_dir / "frames" / filename
        )
        print(
            f"published frame={frame_index} path={written.path} "
            f"max_depth={frame.maximum_depth_m:.3f} m",
            flush=True,
        )

    report = run_simulation(
        spec,
        paths,
        args.output_dir,
        frame_sink=publish_frame,
        progress_sink=progress,
        write_sww=not args.no_sww,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
