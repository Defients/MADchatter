"""Configuration for the MADchatter Local Bridge.

Defaults are safe for the happy path: loopback bind, English small model, auto
device selection, VAD enabled. The user does not need to edit configuration to
start transcribing. A per-user config file + environment variables override
defaults when present.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_MODEL = "small.en"
DEFAULT_DEVICE = "auto"
DEFAULT_LANGUAGE = "en"
DEFAULT_VAD = True

# CORS allowlist. Dev origins cover Vite's default ports; the production origin
# is derived from the canonical MADchatter deployment. Never use "*".
DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://madchatter.fun",
    "https://www.madchatter.fun",
]

# Reconnect backoff schedule (seconds) for recoverable source failures.
RECONNECT_BACKOFF = [1, 2, 4, 8, 15]
MAX_RECONNECT_ATTEMPTS = 5

# Bounded streaming: rolling transcription window length (seconds of audio).
SEGMENT_WINDOW_SECONDS = 10.0
# Overlap between consecutive windows (seconds) for boundary reconciliation.
SEGMENT_OVERLAP_SECONDS = 2.0
# Maximum in-flight audio buffer before backpressure drops stale samples.
MAX_BUFFER_SECONDS = 30.0
# Target sample rate / channels for faster-whisper input.
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1


def _user_config_dir() -> Path:
    """Return the per-user config directory for the Bridge."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return Path(base) / "MADchatter" / "LocalBridge"
    return Path(os.path.expanduser("~/.config/madchatter/local-bridge"))


def _token_file() -> Path:
    return _user_config_dir() / "bridge_token"


def load_or_create_token() -> str:
    """Load the persisted local session token, creating one on first run.

    The token is a 32-byte cryptographically random value persisted in the
    user config directory. It is never logged. The user copies it from the
    config file (or the Bridge console on first start) into MADchatter once.
    """
    path = _token_file()
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    # Restrictive permissions on Windows: the user profile dir is already
    # per-user; on POSIX we tighten the mode.
    path.write_text(token, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return token


@dataclass
class BridgeConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    model: str = DEFAULT_MODEL
    device: str = DEFAULT_DEVICE
    language: str = DEFAULT_LANGUAGE
    vad: bool = DEFAULT_VAD
    allowed_origins: list = field(default_factory=lambda: list(DEFAULT_ALLOWED_ORIGINS))
    verbose: bool = False

    @classmethod
    def load(cls) -> "BridgeConfig":
        """Load config from env vars, then a config.json in the user dir."""
        cfg = cls()
        # Environment overrides (highest priority).
        if v := os.environ.get("MADCHATTER_BRIDGE_HOST"):
            cfg.host = v
        if v := os.environ.get("MADCHATTER_BRIDGE_PORT"):
            try:
                cfg.port = int(v)
            except ValueError:
                pass
        if v := os.environ.get("MADCHATTER_BRIDGE_MODEL"):
            cfg.model = v
        if v := os.environ.get("MADCHATTER_BRIDGE_DEVICE"):
            cfg.device = v
        if v := os.environ.get("MADCHATTER_BRIDGE_LANGUAGE"):
            cfg.language = v
        if v := os.environ.get("MADCHATTER_BRIDGE_VAD"):
            cfg.vad = v.lower() in ("1", "true", "yes", "on")
        if v := os.environ.get("MADCHATTER_BRIDGE_VERBOSE"):
            cfg.verbose = v.lower() in ("1", "true", "yes", "on")
        # Config file overrides defaults (but not env).
        path = _user_config_dir() / "config.json"
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                for key, val in data.items():
                    if hasattr(cfg, key) and not os.environ.get(f"MADCHATTER_BRIDGE_{key.upper()}"):
                        setattr(cfg, key, val)
            except (json.JSONDecodeError, OSError):
                pass
        # Safety: never bind 0.0.0.0 unless the user explicitly opts in.
        if cfg.host not in ("127.0.0.1", "localhost", "::1"):
            print(f"[bridge] WARNING: non-loopback host '{cfg.host}' configured — "
                  "the Bridge will be reachable from other devices on this machine's network.")
        return cfg

    def to_dict(self) -> dict:
        return asdict(self)
