"""STT engine abstraction.

A small wrapper around faster-whisper so another backend (whisper.cpp) could
be added later without rewriting the Bridge. Owns model lifecycle: download
progress, load, and reuse across chunks. Never loads per-segment.

Device selection:
  auto  -> CUDA if usable, else CPU
  cuda  -> CUDA (fail hard if unavailable)
  cpu   -> CPU

Compute type is chosen based on the resolved device and verified
faster-whisper/ctranslate2 compatibility.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional, Callable, Any

from ..config import BridgeConfig


@dataclass
class ModelStatus:
    state: str = "idle"  # idle | model_missing | downloading_model | loading_model | ready | error
    model: Optional[str] = None
    device: Optional[str] = None
    compute_type: Optional[str] = None
    progress: Optional[float] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "model": self.model,
            "device": self.device,
            "computeType": self.compute_type,
            "progress": self.progress,
            "error": self.error,
        }


# Compute type matrix: device -> preferred compute types (first usable wins).
_COMPUTE_TYPES = {
    "cuda": ["float16", "int8_float16", "int8"],
    "cpu": ["int8", "int8_float32", "float32"],
}


def _resolve_device(requested: str) -> tuple[str, str]:
    """Resolve the actual device + compute type. Returns (device, compute_type).

    For 'auto', probes CUDA and falls back to CPU. For 'cuda', raises if
    unavailable. For 'cpu', uses CPU directly.
    """
    if requested == "cpu":
        return "cpu", _pick_compute("cpu")

    cuda_ok = _check_cuda_usable()
    if requested == "cuda":
        if not cuda_ok:
            raise RuntimeError("CUDA was requested but is not available on this machine.")
        return "cuda", _pick_compute("cuda")

    # auto
    if cuda_ok:
        return "cuda", _pick_compute("cuda")
    return "cpu", _pick_compute("cpu")


def _pick_compute(device: str) -> str:
    """Pick the first supported compute type for a device via ctranslate2."""
    try:
        import ctranslate2
        supported = set(ctranslate2.get_supported_compute_types(device))
    except Exception:
        # If we can't probe, use the safe default per device.
        return "int8" if device == "cpu" else "float16"
    for ct in _COMPUTE_TYPES.get(device, ["int8"]):
        if ct in supported:
            return ct
    return "int8" if device == "cpu" else "float16"


def _check_cuda_usable() -> bool:
    try:
        import ctranslate2
        return bool(ctranslate2.get_supported_compute_types("cuda"))
    except Exception:
        return False


class STTEngine:
    """faster-whisper model wrapper with lifecycle management."""

    def __init__(self, config: BridgeConfig) -> None:
        self._config = config
        self._lock = threading.Lock()
        self._model: Any = None  # faster_whisper.WhisperModel
        self._status = ModelStatus()
        self._progress_cb: Optional[Callable[[float], None]] = None
        self._loaded_model_name: Optional[str] = None
        self._loaded_device: Optional[str] = None
        self._loaded_compute: Optional[str] = None

    @property
    def status(self) -> ModelStatus:
        with self._lock:
            return ModelStatus(
                state=self._status.state,
                model=self._status.model,
                device=self._status.device,
                compute_type=self._status.compute_type,
                progress=self._status.progress,
                error=self._status.error,
            )

    def set_progress_callback(self, cb: Optional[Callable[[float], None]]) -> None:
        self._progress_cb = cb

    def is_ready(self) -> bool:
        with self._lock:
            return self._status.state == "ready" and self._model is not None

    def load(self, model: Optional[str] = None, device: Optional[str] = None) -> None:
        """Load a model. Thread-safe; reuses an already-loaded model if matching."""
        model_name = model or self._config.model
        device_request = device or self._config.device
        with self._lock:
            if (
                self._model is not None
                and self._loaded_model_name == model_name
                and self._loaded_device is not None
            ):
                # Already loaded with the same model. If device matches, no-op.
                # If device differs, we need to reload (handled below).
                if device_request == "auto" or self._loaded_device == device_request:
                    self._status.state = "ready"
                    return
            self._status.state = "loading_model"
            self._status.model = model_name
            self._status.progress = None
            self._status.error = None

        try:
            actual_device, compute_type = _resolve_device(device_request)
        except RuntimeError as e:
            with self._lock:
                self._status.state = "error"
                self._status.error = str(e)
            raise

        # Import here so the Bridge can start and report capabilities even
        # if faster-whisper is not yet installed (graceful /health).
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            with self._lock:
                self._status.state = "error"
                self._status.error = f"faster-whisper is not installed: {e}"
            raise

        def _progress_cb(info: Any) -> None:
            # faster-whisper download progress callback.
            try:
                if hasattr(info, "status") and info.status in ("progress", "download"):
                    if hasattr(info, "progress") and info.progress is not None:
                        pct = float(info.progress)
                        if 0 < pct <= 1.0:
                            pct *= 100
                        with self._lock:
                            self._status.state = "downloading_model"
                            self._status.progress = pct
                        if self._progress_cb:
                            self._progress_cb(pct)
                elif hasattr(info, "status") and info.status in ("finished", "done"):
                    with self._lock:
                        self._status.progress = 100.0
                    if self._progress_cb:
                        self._progress_cb(100.0)
            except Exception:
                pass

        with self._lock:
            self._status.device = actual_device
            self._status.compute_type = compute_type

        t0 = time.time()
        try:
            model_obj = WhisperModel(
                model_name,
                device=actual_device,
                compute_type=compute_type,
                download_root=None,  # default cache dir
            )
        except Exception as e:
            with self._lock:
                self._status.state = "error"
                self._status.error = f"Model load failed: {e}"
            raise

        with self._lock:
            self._model = model_obj
            self._loaded_model_name = model_name
            self._loaded_device = actual_device
            self._loaded_compute = compute_type
            self._status.state = "ready"
            self._status.progress = None
            self._status.error = None
            self._status.device = actual_device
            self._status.compute_type = compute_type

    def transcribe(self, audio_bytes: bytes, language: Optional[str] = None, vad: Optional[bool] = None) -> list[dict]:
        """Transcribe raw 16kHz mono PCM s16le bytes.

        Returns a list of {text, start, end, avg_logprob} segment dicts.
        Raises RuntimeError if the model is not loaded.
        """
        import numpy as np
        with self._lock:
            model = self._model
        if model is None:
            raise RuntimeError("STT model is not loaded.")
        # Decode s16le bytes to float32 numpy array.
        audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if audio.size == 0:
            return []
        lang = language or self._config.language
        use_vad = vad if vad is not None else self._config.vad
        segments_gen, _info = model.transcribe(
            audio,
            language=lang,
            vad_filter=use_vad,
            vad_parameters=dict(min_silence_duration_ms=500) if use_vad else None,
            beam_size=5,
            without_timestamps=False,
            condition_on_previous_text=False,
        )
        results: list[dict] = []
        for seg in segments_gen:
            text = (seg.text or "").strip()
            if not text:
                continue
            results.append({
                "text": text,
                "start": float(seg.start),
                "end": float(seg.end),
                "avg_logprob": float(seg.avg_logprob) if seg.avg_logprob is not None else None,
            })
        return results

    def unload(self) -> None:
        """Release the model. Call before loading a different model."""
        with self._lock:
            self._model = None
            self._loaded_model_name = None
            self._loaded_device = None
            self._loaded_compute = None
            self._status.state = "idle"
            self._status.progress = None
