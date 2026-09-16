"""Explicit transcription state machine.

Prevents illegal operations (START while LISTENING, STOP while IDLE causing
an exception, source switch while old FFmpeg is alive). All transitions are
deterministic and validated here.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class TranscriptionState(str, Enum):
    DISCONNECTED = "disconnected"
    IDLE = "idle"
    PREPARING_SOURCE = "preparing_source"
    LOADING_MODEL = "loading_model"
    LISTENING = "listening"
    RECONNECTING = "reconnecting"
    STOPPING = "stopping"
    ERROR = "error"


# Legal transitions: from_state -> {set of allowed to_states}
_LEGAL_TRANSITIONS: dict[TranscriptionState, set[TranscriptionState]] = {
    TranscriptionState.DISCONNECTED: {TranscriptionState.IDLE},
    TranscriptionState.IDLE: {TranscriptionState.PREPARING_SOURCE, TranscriptionState.LOADING_MODEL, TranscriptionState.ERROR},
    TranscriptionState.PREPARING_SOURCE: {TranscriptionState.LOADING_MODEL, TranscriptionState.LISTENING, TranscriptionState.ERROR, TranscriptionState.STOPPING},
    TranscriptionState.LOADING_MODEL: {TranscriptionState.LISTENING, TranscriptionState.ERROR, TranscriptionState.STOPPING},
    TranscriptionState.LISTENING: {TranscriptionState.RECONNECTING, TranscriptionState.STOPPING, TranscriptionState.ERROR, TranscriptionState.IDLE},
    TranscriptionState.RECONNECTING: {TranscriptionState.LISTENING, TranscriptionState.STOPPING, TranscriptionState.ERROR},
    TranscriptionState.STOPPING: {TranscriptionState.IDLE, TranscriptionState.ERROR},
    TranscriptionState.ERROR: {TranscriptionState.IDLE, TranscriptionState.STOPPING},
}


@dataclass
class StateSnapshot:
    state: TranscriptionState = TranscriptionState.IDLE
    source: Optional[str] = None  # "stream" | "system"
    url: Optional[str] = None
    device_id: Optional[str] = None
    model: Optional[str] = None
    device: Optional[str] = None  # "cuda" | "cpu"
    compute_type: Optional[str] = None
    last_error: Optional[str] = None
    last_error_code: Optional[str] = None
    retry_count: int = 0
    latency_ms: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "state": self.state.value,
            "source": self.source,
            "url": self.url,
            "deviceId": self.device_id,
            "model": self.model,
            "device": self.device,
            "computeType": self.compute_type,
            "lastError": self.last_error,
            "lastErrorCode": self.last_error_code,
            "retryCount": self.retry_count,
            "latencyMs": self.latency_ms,
        }


class StateMachine:
    """Thread-safe transcription state machine."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshot = StateSnapshot()

    @property
    def snapshot(self) -> StateSnapshot:
        with self._lock:
            return StateSnapshot(
                state=self._snapshot.state,
                source=self._snapshot.source,
                url=self._snapshot.url,
                device_id=self._snapshot.device_id,
                model=self._snapshot.model,
                device=self._snapshot.device,
                compute_type=self._snapshot.compute_type,
                last_error=self._snapshot.last_error,
                last_error_code=self._snapshot.last_error_code,
                retry_count=self._snapshot.retry_count,
                latency_ms=self._snapshot.latency_ms,
            )

    def get_state(self) -> TranscriptionState:
        with self._lock:
            return self._snapshot.state

    def transition(self, to: TranscriptionState) -> None:
        """Transition to a new state, validating the transition is legal.

        Raises ValueError on illegal transitions (a programming bug, not a
        user error — the API layer translates user requests into legal
        transitions or returns 409).
        """
        with self._lock:
            current = self._snapshot.state
            if to not in _LEGAL_TRANSITIONS.get(current, set()):
                raise ValueError(f"Illegal transition {current.value} -> {to.value}")
            self._snapshot.state = to
            if to == TranscriptionState.IDLE:
                self._snapshot.retry_count = 0
                self._snapshot.last_error = None
                self._snapshot.last_error_code = None
            if to == TranscriptionState.ERROR:
                pass  # error fields set via set_error()

    def set_error(self, code: str, message: str) -> None:
        with self._lock:
            self._snapshot.last_error = message
            self._snapshot.last_error_code = code
            self._snapshot.state = TranscriptionState.ERROR

    def update(self, **fields) -> None:
        """Update metadata fields on the snapshot (source, model, device, etc.)."""
        with self._lock:
            for key, val in fields.items():
                if hasattr(self._snapshot, key):
                    setattr(self._snapshot, key, val)

    def increment_retry(self) -> int:
        with self._lock:
            self._snapshot.retry_count += 1
            return self._snapshot.retry_count

    def reset_retries(self) -> None:
        with self._lock:
            self._snapshot.retry_count = 0

    def is_active(self) -> bool:
        """True if a transcription session is running or starting."""
        with self._lock:
            return self._snapshot.state in (
                TranscriptionState.PREPARING_SOURCE,
                TranscriptionState.LOADING_MODEL,
                TranscriptionState.LISTENING,
                TranscriptionState.RECONNECTING,
                TranscriptionState.STOPPING,
            )
