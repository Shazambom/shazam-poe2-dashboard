"""Worker operations whose callers must wait for completion even when cancelled."""

import asyncio
import logging
from collections.abc import Callable, Coroutine
from typing import Any

from starlette.concurrency import run_in_threadpool

log = logging.getLogger(__name__)


async def finish_write[T, **P](
    operation: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs
) -> T:
    """Let a write settle before cancellation can release its caller's lock or ownership."""
    return await finish(run_in_threadpool(operation, *args, **kwargs))


async def finish[T](operation: Coroutine[Any, Any, T]) -> T:
    """Let a multi-step operation settle, including any loop-side publication after a write."""
    task = asyncio.create_task(operation)
    cancelled = False
    while not task.done():
        try:
            await asyncio.wait({task})
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        if task.cancelled():
            raise asyncio.CancelledError
        exc = task.exception()
        if exc is not None:
            log.warning("shielded operation failed during cancellation", exc_info=exc)
            raise asyncio.CancelledError from exc
        raise asyncio.CancelledError
    return task.result()
