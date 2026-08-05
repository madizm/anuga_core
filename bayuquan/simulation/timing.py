"""Thread-safe wall-clock phase accounting for simulation jobs."""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from threading import Lock


class PhaseTimings:
    """Accumulate elapsed seconds by stable phase name."""

    def __init__(self) -> None:
        self._seconds: dict[str, float] = defaultdict(float)
        self._lock = Lock()

    @contextmanager
    def measure(self, phase: str) -> Iterator[None]:
        started = time.perf_counter()
        try:
            yield
        finally:
            self.add(phase, time.perf_counter() - started)

    def add(self, phase: str, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("phase duration cannot be negative")
        with self._lock:
            self._seconds[phase] += seconds

    def snapshot(self) -> dict[str, float]:
        with self._lock:
            return {
                name: round(seconds, 6)
                for name, seconds in sorted(self._seconds.items())
            }


def timed_evolve(
    domain: object,
    *,
    yieldstep: float,
    finaltime: float,
    timings: PhaseTimings,
) -> Iterator[float]:
    """Yield ANUGA states while timing only generator advancement.

    Work performed by the caller after each yield (frame analysis and output)
    is excluded. ANUGA's optional SWW write happens inside generator
    advancement and is therefore intentionally included in ``solverAdvance``.
    """
    evolution = iter(
        domain.evolve(
            yieldstep=yieldstep,
            finaltime=finaltime,
        )
    )
    while True:
        started = time.perf_counter()
        try:
            value = next(evolution)
        except StopIteration:
            timings.add("solverAdvance", time.perf_counter() - started)
            return
        timings.add("solverAdvance", time.perf_counter() - started)
        yield value
