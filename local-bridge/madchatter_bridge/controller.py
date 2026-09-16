"""Transcription controller — orchestrates source, engine, segmenter, state.

Owns the single active transcription session. Handles:
  - start/stop semantics (one session per Bridge instance);
  - model lifecycle (load on first start, reuse across chunks);
  - source lifecycle (start, reconnect with bounded backoff, cleanup);
  - state machine transitions;
  - event emission (status, transcript.final, errors).

This is the single owner of the active session — no parallel Whisper models,
no orphan processes.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Optional, Callable

from .config import BridgeConfig, RECONNECT_BACKOFF, MAX_RECONNECT_ATTEMPTS
from .state import StateMachine, TranscriptionState
from .sse import bus, BridgeEvent
from .stt.engine import STTEngine
from .stt.segmenter import Segmenter
from .audio.stream import StreamSource, validate_stream_url
from .audio.system import SystemSource


class TranscriptionController:
    """Single-session transcription orchestrator."""

    def __init__(self, config: BridgeConfig, engine: STTEngine) -> None:
        self._config = config
        self._engine = engine
        self._state = StateMachine()
        self._source = None
        self._segmenter: Optional[Segmenter] = None
        self._lock = threading.Lock()
        self._active = False

    @property
    def state(self) -> StateMachine:
        return self._state

    @property
    def engine(self) -> STTEngine:
        return self._engine

    def is_active(self) -> bool:
        return self._active

    def start(
        self,
        source: str,
        url: Optional[str] = None,
        device_id: Optional[str] = None,
        model: Optional[str] = None,
        device: Optional[str] = None,
        language: Optional[str] = None,
    ) -> None:
        """Start a transcription session. Raises if one is already active."""
        with self._lock:
            if self._active:
                raise RuntimeError("TRANSCRIPTION_ALREADY_ACTIVE")
            self._active = True

        # Validate source type.
        if source not in ("stream", "system"):
            with self._lock:
                self._active = False
            raise ValueError("INVALID_REQUEST: source must be 'stream' or 'system'")

        # Validate stream URL early.
        if source == "stream":
            try:
                validate_stream_url(url or "")
            except Exception:
                with self._lock:
                    self._active = False
                raise

        # Update state metadata.
        self._state.update(
            source=source,
            url=url,
            device_id=device_id,
            model=model or self._config.model,
            device=device or self._config.device,
        )
        self._state.reset_retries()

        # Load model if not ready (or if a different model/device was requested).
        if not self._engine.is_ready() or (model and model != self._engine.status.model):
            self._state.transition(TranscriptionState.LOADING_MODEL)
            bus.publish_sync(BridgeEvent("model.status", self._engine.status.to_dict()))
            try:
                self._engine.load(model=model, device=device)
            except Exception as e:
                self._state.set_error("MODEL_LOAD_FAILED", str(e))
                bus.publish_sync(BridgeEvent("model.status", self._engine.status.to_dict()))
                bus.publish_sync(BridgeEvent("transcription.error", {"code": "MODEL_LOAD_FAILED", "message": str(e)}))
                with self._lock:
                    self._active = False
                return
            bus.publish_sync(BridgeEvent("model.status", self._engine.status.to_dict()))
        else:
            # Update state device/compute from the loaded engine.
            self._state.update(
                device=self._engine.status.device,
                compute_type=self._engine.status.compute_type,
            )

        # Build the source.
        self._state.transition(TranscriptionState.PREPARING_SOURCE)
        bus.publish_sync(BridgeEvent("source.status", {"state": "connecting"}))
        if source == "stream":
            self._source = StreamSource(url=url, on_status=self._on_source_status)
        else:
            self._source = SystemSource(device_id=device_id, on_status=self._on_source_status)

        # Start the source.
        self._source.start()

        # Build + start the segmenter.
        self._segmenter = Segmenter(
            self._source,
            self._engine,
            on_segment=self._on_segment,
            on_status=self._on_status,
        )
        self._segmenter.start()
        self._state.transition(TranscriptionState.LISTENING)
        bus.publish_sync(BridgeEvent("bridge.status", self._state.snapshot.to_dict()))

    def stop(self) -> None:
        """Stop the active session. Idempotent — safe to call when idle."""
        with self._lock:
            if not self._active:
                return
            self._active = False
        current = self._state.get_state()
        if current in (TranscriptionState.IDLE, TranscriptionState.DISCONNECTED):
            return
        try:
            self._state.transition(TranscriptionState.STOPPING)
        except ValueError:
            pass
        # Stop segmenter first (stops draining the source queue).
        if self._segmenter:
            self._segmenter.stop()
            self._segmenter = None
        # Stop the source (terminates child processes).
        if self._source:
            self._source.stop()
            self._source = None
        try:
            self._state.transition(TranscriptionState.IDLE)
        except ValueError:
            self._state.update(state=TranscriptionState.IDLE)
        bus.publish_sync(BridgeEvent("transcription.stopped", {}))
        bus.publish_sync(BridgeEvent("bridge.status", self._state.snapshot.to_dict()))

    def _on_source_status(self, status: str, detail: Optional[str]) -> None:
        """Handle source status callbacks (from the audio source thread)."""
        if status == "connected":
            self._state.reset_retries()
        elif status == "disconnected":
            self._handle_disconnect(detail or "SOURCE_DISCONNECTED")
        elif status == "error":
            self._handle_source_error(detail or "INTERNAL_ERROR")

    def _on_status(self, status: str, detail: Optional[str]) -> None:
        """Handle segmenter status callbacks."""
        if status == "error":
            self._handle_source_error(detail or "TRANSCRIPTION_FAILED")

    def _handle_disconnect(self, code: str) -> None:
        """Recoverable disconnect — attempt bounded reconnection."""
        if not self._active:
            return
        current = self._state.get_state()
        if current == TranscriptionState.STOPPING:
            return
        try:
            self._state.transition(TranscriptionState.RECONNECTING)
        except ValueError:
            return
        attempts = self._state.increment_retry()
        bus.publish_sync(BridgeEvent("source.status", {"state": "reconnecting", "retry": attempts, "max": MAX_RECONNECT_ATTEMPTS}))
        if attempts > MAX_RECONNECT_ATTEMPTS:
            self._state.set_error(code, f"Reconnect failed after {MAX_RECONNECT_ATTEMPTS} attempts.")
            bus.publish_sync(BridgeEvent("transcription.error", {"code": code, "message": self._state.snapshot.last_error}))
            with self._lock:
                self._active = False
            return
        delay = RECONNECT_BACKOFF[min(attempts - 1, len(RECONNECT_BACKOFF) - 1)]
        threading.Thread(target=self._reconnect_after, args=(delay,), daemon=True).start()

    def _reconnect_after(self, delay: float) -> None:
        time.sleep(delay)
        if not self._active or self._state.get_state() == TranscriptionState.STOPPING:
            return
        # Stop the old source + segmenter, restart fresh.
        if self._segmenter:
            self._segmenter.stop()
            self._segmenter = None
        if self._source:
            self._source.stop()
        snap = self._state.snapshot
        if snap.source == "stream":
            self._source = StreamSource(url=snap.url, on_status=self._on_source_status)
        else:
            self._source = SystemSource(device_id=snap.device_id, on_status=self._on_source_status)
        self._source.start()
        self._segmenter = Segmenter(self._source, self._engine, on_segment=self._on_segment, on_status=self._on_status)
        self._segmenter.start()
        try:
            self._state.transition(TranscriptionState.LISTENING)
        except ValueError:
            pass
        bus.publish_sync(BridgeEvent("bridge.status", self._state.snapshot.to_dict()))

    def _handle_source_error(self, code: str) -> None:
        """Fatal source error — stop and report."""
        with self._lock:
            self._active = False
        if self._segmenter:
            self._segmenter.stop()
            self._segmenter = None
        if self._source:
            self._source.stop()
            self._source = None
        self._state.set_error(code, _ERROR_MESSAGES.get(code, "Source error."))
        bus.publish_sync(BridgeEvent("transcription.error", {"code": code, "message": self._state.snapshot.last_error}))
        bus.publish_sync(BridgeEvent("bridge.status", self._state.snapshot.to_dict()))

    def _on_segment(self, seg: dict, latency_ms: float) -> None:
        """Emit a finalized transcript segment."""
        self._state.update(latency_ms=latency_ms)
        bus.publish_sync(BridgeEvent("transcript.final", seg))
        bus.publish_sync(BridgeEvent("bridge.status", self._state.snapshot.to_dict()))


_ERROR_MESSAGES = {
    "STREAMLINK_NOT_FOUND": "Streamlink was not found. Install Streamlink or add it to PATH.",
    "FFMPEG_NOT_FOUND": "FFmpeg was not found. Install FFmpeg or add it to PATH.",
    "STREAM_OFFLINE": "The selected stream appears to be offline.",
    "STREAM_UNSUPPORTED": "Streamlink couldn't resolve this stream. Try System Audio instead.",
    "STREAM_RESOLUTION_FAILED": "Streamlink couldn't resolve this stream. Try System Audio instead.",
    "AUDIO_DEVICE_NOT_FOUND": "No system audio loopback device was found.",
    "WASAPI_UNAVAILABLE": "WASAPI loopback is not available. Install the PyAudioWPatch dependency.",
    "TRANSCRIPTION_FAILED": "Transcription failed. Check the Bridge logs for details.",
    "MODEL_LOAD_FAILED": "The transcription model could not be loaded.",
    "SOURCE_DISCONNECTED": "The audio source disconnected.",
    "INTERNAL_ERROR": "An internal error occurred.",
}
