"""Entry point: python -m madchatter_bridge"""

from __future__ import annotations

import sys
import os


def main() -> None:
    # Force UTF-8 stdout/stderr — Windows cp1252 can't encode arrows/dashes.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    # Defer imports so --help and capability checks don't pull heavy deps.
    from .config import BridgeConfig, load_or_create_token
    from .capabilities import detect_capabilities
    from .stt.engine import STTEngine
    from .controller import TranscriptionController
    from .api import create_app

    config = BridgeConfig.load()
    token = load_or_create_token()
    caps = detect_capabilities()

    print(f"[bridge] MADchatter Local Bridge v0.1.0 (api v1)")
    print(f"[bridge] binding {config.host}:{config.port}")
    print(f"[bridge] capabilities: streamlink={caps.streamlink} ffmpeg={caps.ffmpeg} wasapi={caps.wasapi} cuda={caps.cuda}")
    if not caps.ffmpeg:
        print("[bridge] WARNING: FFmpeg not found -- direct stream transcription will not work. Install FFmpeg and add it to PATH.")
    if not caps.streamlink:
        print("[bridge] WARNING: Streamlink not found -- direct stream transcription will not work. Install Streamlink and add it to PATH.")
    if not caps.wasapi:
        print("[bridge] NOTE: WASAPI loopback unavailable -- system audio fallback disabled. Install PyAudioWPatch to enable it.")
    if not caps.cuda:
        print("[bridge] NOTE: CUDA not detected -- transcription will use CPU.")

    # Print the token once on first run so the user can copy it into MADchatter.
    token_path = os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "MADchatter", "LocalBridge", "bridge_token"
    ) if sys.platform == "win32" else os.path.expanduser("~/.config/madchatter/local-bridge/bridge_token")
    print(f"[bridge] local token: {token}")
    print(f"[bridge] token file: {token_path}")
    print(f"[bridge] open MADchatter -> Local Bridge panel, paste the token, and connect.")

    engine = STTEngine(config)
    controller = TranscriptionController(config, engine)
    app = create_app(config=config, token=token, capabilities=caps, engine=engine, controller=controller)

    import uvicorn
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_level="info" if not config.verbose else "debug",
        access_log=config.verbose,
    )


if __name__ == "__main__":
    main()
