from __future__ import annotations

from benchmarks import run_benchmarks


class Sampler:
    peak_mb = 12.0

    def current_mb(self):
        return 10.0

    def reset_peak(self):
        pass


class Domain:
    number_of_triangles = 10
    number_of_steps = 0

    def evolve(self, *, yieldstep, finaltime):
        for steps in (0, 3, 4):
            self.number_of_steps = steps
            yield steps


def test_run_one_accumulates_steps_across_yield_intervals(monkeypatch, tmp_path):
    monkeypatch.setattr(
        run_benchmarks,
        "_create_domain",
        lambda nx, ny, mode, output: Domain(),
    )
    monkeypatch.setattr(
        run_benchmarks.tempfile, "mkdtemp", lambda: str(tmp_path / "run")
    )

    result = run_benchmarks.run_one("small", 1, 4, Sampler())

    assert result["n_steps"] == 7
    assert result["cells_per_s"] > 0
    assert result["total_wall_time_s"] >= result["wall_time_s"]
