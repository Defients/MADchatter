"""Audio source abstraction.

Two concrete sources share this interface:
  - StreamSource: Twitch/Kick URL -> Streamlink -> FFmpeg -> 16kHz mono PCM
  - SystemSource: Windows WASAPI loopback -> resample -> 16kHz mono PCM

Both yield raw s16le 16kHz mono PCM bytes via a thread-safe queue, with a
bounded buffer for backpressure. The transcription controller drains the queue
and feeds rolling windows to the STT engine.
"""

from __future__ import annotations

import abc
import threading
import queue
import time
from typing import Optional, Callable

from ..config import TARGET_SAMPLE_RATE, TARGET_CHANNELS, MAX_BUFFER_SECONDS


class AudioSourceError(Exception):
    """Base class for source errors. Carries a machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class AudioSource(abc.ABC):
    """Abstract audio source producing 16kHz mono s16le PCM bytes."""

    def __init__(self, on_status: Optional[Callable[[str, Optional[str]], None]] = None) -> None:
        self._on_status = on_status
        self._queue: queue.Queue[bytes] = queue.Queue(maxsize=int(MAX_BUFFER_SECONDS * TARGET_SAMPLE_RATE * 2))
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._dropped_samples = 0

    @property
    def stopped(self) -> bool:
        return self._stop_event.is_set()

    def request_stop(self) -> None:
        self._stop_event.set()

    def get_chunk(self, timeout: float = 0.5) -> Optional[bytes]:
        """Get a chunk of PCM bytes, or None on timeout."""
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def _push(self, data: bytes) -> None:
        """Push PCM bytes to the bounded queue. Drops on backpressure."""
        try:
            self._queue.put_nowait(data)
        except queue.Full:
            # Backpressure: drop the oldest chunk to make room.
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(data)
                self._dropped_samples += 1
            except Exception:
                pass

    def _emit_status(self, status: str, detail: Optional[str] = None) -> None:
        if self._on_status:
            try:
                self._on_status(status, detail)
            except Exception:
                pass

    @abc.abstractmethod
    def start(self) -> None:
        """Start capturing. Blocks until the source is producing or errors."""
        ...

    def stop(self) -> None:
        """Stop capturing and clean up child processes."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
        self._cleanup()

    @abc.abstractmethod
    def _cleanup(self) -> None:
        """Release process handles, audio devices, etc."""
        ...

    @property
    @abc.abstractmethod
    def source_kind(self) -> str:
        """'stream' or 'system'."""
        ...
