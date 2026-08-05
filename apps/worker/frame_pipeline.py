"""Bounded, ordered background processing for immutable frame snapshots."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Generic, TypeVar

T = TypeVar("T")


class OrderedBoundedPipeline(Generic[T]):
    """Process items in order on one worker with bounded producer lead.

    A single consumer preserves frame publication order. ``max_pending`` bounds
    the running plus queued items, so frame snapshots cannot grow without limit.
    Consumer failures are re-raised in the producer or by :meth:`close`.
    """

    def __init__(
        self,
        consumer: Callable[[T], None],
        *,
        max_pending: int = 2,
        thread_name_prefix: str = "frame-publisher",
    ) -> None:
        if max_pending < 1:
            raise ValueError("max_pending must be at least one")
        self._consumer = consumer
        self._max_pending = max_pending
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix=thread_name_prefix,
        )
        self._pending: deque[Future[None]] = deque()
        self._closed = False

    def submit(self, item: T) -> None:
        if self._closed:
            raise RuntimeError("pipeline is closed")
        self._collect_completed()
        if len(self._pending) >= self._max_pending:
            self._pending.popleft().result()
        self._pending.append(self._executor.submit(self._consumer, item))

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        failure: Exception | None = None
        try:
            while self._pending:
                try:
                    self._pending.popleft().result()
                except Exception as error:  # noqa: BLE001
                    # Drain every submitted frame before re-raising the first
                    # consumer failure; consumer implementations are external.
                    if failure is None:
                        failure = error
        finally:
            self._executor.shutdown(wait=True, cancel_futures=False)
        if failure is not None:
            raise failure

    def abort(self) -> None:
        """Stop accepting items and cancel work that has not started."""
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)
        self._pending.clear()

    def _collect_completed(self) -> None:
        while self._pending and self._pending[0].done():
            self._pending.popleft().result()
