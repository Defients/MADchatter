"""Server-Sent Events bus for one-way transcript delivery.

SSE is the preferred transport: one-way, simple, auto-reconnecting in the
browser via EventSource, and sufficient for the transcript event stream. The
client subscribes to GET /v1/transcription/stream?token=... and receives
typed events.

The bus keeps a bounded ring buffer of recent events so a reconnecting client
can receive the last few segments without losing context (optional enhancement
A from the spec, low cost to include).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass, asdict, field
from typing import Any, Optional


@dataclass
class BridgeEvent:
    type: str
    data: Any
    ts: float = field(default_factory=time.time)

    def serialize(self) -> str:
        """Serialize to an SSE `data:` line payload (JSON)."""
        return json.dumps({"type": self.type, "data": self.data, "ts": self.ts}, separators=(",", ":"))


class EventBus:
    """Bounded async event bus with a recent-event ring buffer."""

    def __init__(self, ring_size: int = 50) -> None:
        self._subscribers: list[asyncio.Queue[BridgeEvent]] = []
        self._ring: deque[BridgeEvent] = deque(maxlen=ring_size)
        self._lock = asyncio.Lock()

    async def subscribe(self) -> tuple[asyncio.Queue[BridgeEvent], list[BridgeEvent]]:
        """Subscribe to the bus. Returns (queue, recent_events)."""
        q: asyncio.Queue[BridgeEvent] = asyncio.Queue(maxsize=200)
        async with self._lock:
            self._subscribers.append(q)
            recent = list(self._ring)
        return q, recent

    async def unsubscribe(self, q: asyncio.Queue[BridgeEvent]) -> None:
        async with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    async def publish(self, event: BridgeEvent) -> None:
        """Publish an event to all subscribers. Drops on backpressure (bounded queue)."""
        async with self._lock:
            self._ring.append(event)
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Backpressure: drop the oldest event to make room, then retry.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass  # subscriber is hopelessly behind; drop this event

    def publish_sync(self, event: BridgeEvent) -> None:
        """Thread-safe publish from a non-async context (audio worker threads).

        Schedules the coroutine on the running event loop if one exists.
        """
        try:
            loop = asyncio.get_running_loop()
            asyncio.run_coroutine_threadsafe(self.publish(event), loop)
        except RuntimeError:
            # No running loop — store in ring only; subscribers will pick up
            # recent events on connect.
            self._ring.append(event)


# Module-level singleton — the single event stream for the Bridge.
bus = EventBus()
