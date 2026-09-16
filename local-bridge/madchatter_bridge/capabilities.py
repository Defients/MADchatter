"""Runtime capability detection.

Never claim a capability merely because a package imported. We probe the
actual external processes (FFmpeg, Streamlink) and hardware (CUDA) so /health
reports the truth.
"""

from __future__ import annotations

import shutil
import importlib
from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class Capabilities:
    streamlink: bool = False
    ffmpeg: bool = False
    wasapi: bool = False
    cuda: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _has_executable(name: str) -> bool:
    return shutil.which(name) is not None


def _check_cuda() -> bool:
    """Detect whether a usable CUDA path exists for faster-whisper.

    We import ctranslate2 (faster-whisper's backend) and ask it which device
    types it supports. This avoids a full model load just to answer /health.
    """
    try:
        import ctranslate2
        supported = ctranslate2.get_supported_compute_types("cuda")
        return bool(supported)
    except Exception:
        return False


def detect_capabilities() -> Capabilities:
    caps = Capabilities()
    caps.ffmpeg = _has_executable("ffmpeg")
    caps.streamlink = _has_executable("streamlink") or _import_ok("streamlink")
    caps.wasapi = _import_ok("pyaudiowpatch")
    caps.cuda = _check_cuda()
    return caps


def _import_ok(module_name: str) -> bool:
    """Return True if a module imports cleanly. Used for optional deps."""
    try:
        importlib.import_module(module_name)
        return True
    except Exception:
        return False
