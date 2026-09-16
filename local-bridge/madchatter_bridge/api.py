"""FastAPI application — the Bridge HTTP/SSE API.

Versioned under /v1. Loopback-only bind, explicit CORS allowlist, token auth
on privileged routes. No `Access-Control-Allow-Origin: *` anywhere.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Optional

from fastapi import FastAPI, Request, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field

from . import __version__, API_VERSION
from .config import BridgeConfig, load_or_create_token, DEFAULT_ALLOWED_ORIGINS
from .capabilities import detect_capabilities, Capabilities
from .auth import require_token
from .state import TranscriptionState
from .sse import bus, BridgeEvent
from .stt.engine import STTEngine
from .controller import TranscriptionController
from .audio.stream import validate_stream_url
from .audio.system import list_loopback_devices


# ── Pydantic request models ──────────────────────────────────────────────

class StartRequest(BaseModel):
    source: str = Field(..., description="'stream' or 'system'")
    url: Optional[str] = None
    deviceId: Optional[str] = None
    model: Optional[str] = None
    device: Optional[str] = None
    language: Optional[str] = None


class StopRequest(BaseModel):
    pass


# ── Error helper ─────────────────────────────────────────────────────────

def _error(code: str, message: str, status_code: int = 400) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message, "details": None}},
    )


def _validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Normalize FastAPI/pydantic 422 errors into our error contract."""
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "INVALID_REQUEST", "message": "Invalid request body.", "details": exc.errors()}},
    )


# ── App factory ──────────────────────────────────────────────────────────

def create_app(
    config: Optional[BridgeConfig] = None,
    token: Optional[str] = None,
    capabilities: Optional[Capabilities] = None,
    engine: Optional[STTEngine] = None,
    controller: Optional[TranscriptionController] = None,
) -> FastAPI:
    """Build the FastAPI app. Defaults wire up real config/engine/controller."""
    config = config or BridgeConfig.load()
    token = token or load_or_create_token()
    capabilities = capabilities or detect_capabilities()
    engine = engine or STTEngine(config)
    controller = controller or TranscriptionController(config, engine)

    app = FastAPI(
        title="MADchatter Local Bridge",
        version=__version__,
        docs_url=None,
        redoc_url=None,
    )
    app.add_exception_handler(RequestValidationError, _validation_error_handler)

    # CORS: explicit allowlist only. Never "*".
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept"],
    )

    # Stash dependencies on app state for route handlers + tests.
    app.state.config = config
    app.state.token = token
    app.state.capabilities = capabilities
    app.state.engine = engine
    app.state.controller = controller

    # ── Auth dependency ──────────────────────────────────────────────────

    async def auth(request: Request) -> None:
        await require_token(request, app.state.token)

    # ── Routes ───────────────────────────────────────────────────────────

    @app.get("/v1/health")
    async def health() -> dict:
        """Unauthenticated health check — reports capabilities + versions only.

        Never exposes the token, config secrets, or filesystem paths.
        """
        snap = controller.state.snapshot
        model_status = engine.status
        return {
            "service": "madchatter-local",
            "serviceVersion": __version__,
            "apiVersion": API_VERSION,
            "status": "ready" if not controller.is_active() else "transcribing",
            "transcription": {
                "state": snap.state.value,
                "device": model_status.device,
                "computeType": model_status.compute_type,
                "model": model_status.model or config.model,
            },
            "capabilities": capabilities.to_dict(),
        }

    @app.get("/v1/status")
    async def get_status(_: None = Depends(auth)) -> dict:
        snap = controller.state.snapshot
        model_status = engine.status
        return {
            "service": "madchatter-local",
            "serviceVersion": __version__,
            "apiVersion": API_VERSION,
            "transcription": snap.to_dict(),
            "model": model_status.to_dict(),
        }

    @app.get("/v1/devices")
    async def get_devices(_: None = Depends(auth)) -> dict:
        devices = list_loopback_devices()
        return {"devices": devices, "wasapi": capabilities.wasapi}

    @app.post("/v1/transcription/start")
    async def start_transcription(req: StartRequest, _: None = Depends(auth)) -> dict:
        # Validate source type + URL in the handler (reliable across pydantic modes).
        if req.source not in ("stream", "system"):
            raise _error("INVALID_REQUEST", "source must be 'stream' or 'system'", 400)
        if req.source == "stream":
            if not req.url:
                raise _error("INVALID_REQUEST", "url is required for stream source", 400)
            try:
                validate_stream_url(req.url)
            except Exception as e:
                code = getattr(e, "code", "STREAM_UNSUPPORTED")
                raise _error(code, str(e), 400)
        if controller.is_active():
            raise _error("TRANSCRIPTION_ALREADY_ACTIVE", "A transcription session is already running.", 409)
        try:
            controller.start(
                source=req.source,
                url=req.url,
                device_id=req.deviceId,
                model=req.model,
                device=req.device,
                language=req.language,
            )
        except ValueError as e:
            msg = str(e)
            code = "INVALID_REQUEST"
            if ":" in msg:
                code, msg = msg.split(":", 1)
                msg = msg.strip()
            raise _error(code, msg, 400)
        except RuntimeError as e:
            msg = str(e)
            if msg == "TRANSCRIPTION_ALREADY_ACTIVE":
                raise _error("TRANSCRIPTION_ALREADY_ACTIVE", "A transcription session is already running.", 409)
            raise _error("MODEL_LOAD_FAILED", msg, 500)
        except Exception as e:
            raise _error("INTERNAL_ERROR", str(e), 500)
        return {"started": True, "state": controller.state.snapshot.to_dict()}

    @app.post("/v1/transcription/stop")
    async def stop_transcription(_: None = Depends(auth)) -> dict:
        controller.stop()
        return {"stopped": True, "state": controller.state.snapshot.to_dict()}

    @app.get("/v1/transcription/stream")
    async def transcription_stream(request: Request) -> StreamingResponse:
        # SSE: auth via query param (EventSource cannot set headers).
        await require_token(request, app.state.token)

        async def event_generator():
            q, recent = await bus.subscribe()
            try:
                # Replay recent events (ring buffer) on connect.
                for evt in recent:
                    yield f"data: {evt.serialize()}\n\n"
                # Live events.
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        evt = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"data: {evt.serialize()}\n\n"
                    except asyncio.TimeoutError:
                        # Keepalive comment — keeps the connection alive.
                        yield ": keepalive\n\n"
            finally:
                await bus.unsubscribe(q)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # ── Startup/shutdown hooks ───────────────────────────────────────────

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        controller.stop()
        engine.unload()

    app.router.lifespan_context = lifespan

    return app
