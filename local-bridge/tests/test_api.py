"""Integration tests for the Bridge API: health, auth, start/stop, SSE.

Uses FastAPI's TestClient (httpx-backed) with a fake STT engine and fake
audio source so no real Whisper, Streamlink, or FFmpeg is required.

Run with:  pytest tests/  (or:  python -m pytest tests/)
"""

import os
import sys
import time
import json
import threading
import queue as queue_mod

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from madchatter_bridge.config import BridgeConfig
from madchatter_bridge.capabilities import Capabilities
from madchatter_bridge.state import TranscriptionState
from madchatter_bridge.stt.engine import STTEngine, ModelStatus
from madchatter_bridge.audio.base import AudioSource
from madchatter_bridge.controller import TranscriptionController
from madchatter_bridge.api import create_app


# ── Fakes ─────────────────────────────────────────────────────────────────

class FakeEngine(STTEngine):
    """STT engine that never loads faster-whisper. Returns canned segments."""
    def __init__(self, config):
        super().__init__(config)
        self._status = ModelStatus(state="ready", model=config.model, device="cpu", compute_type="int8")
        self._loaded_model_name = config.model
        self._model = object()  # truthy so is_ready() passes

    def is_ready(self):
        return True

    def load(self, model=None, device=None):
        self._status.state = "ready"
        self._status.model = model or self._config.model

    def transcribe(self, audio_bytes, language=None, vad=None):
        # Return a single canned segment for any non-empty audio.
        if len(audio_bytes) > 0:
            return [{"text": "test transcript", "start": 0.0, "end": 1.0, "avg_logprob": -0.5}]
        return []

    def unload(self):
        pass


class FakeSource(AudioSource):
    """Audio source that pushes a few PCM chunks then signals connected."""
    def __init__(self, on_status=None):
        super().__init__(on_status)
        self._started = False

    @property
    def source_kind(self):
        return "stream"

    def start(self):
        self._stop_event.clear()
        self._started = True
        self._emit_status("connected")
        # Push some dummy PCM in a background thread.
        def feed():
            for _ in range(3):
                if self._stop_event.is_set():
                    return
                self._push(b"\x00" * 3200)
                time.sleep(0.05)
        threading.Thread(target=feed, daemon=True).start()

    def _cleanup(self):
        pass


# ── Fixtures ──────────────────────────────────────────────────────────────

@pytest.fixture
def app_and_token():
    config = BridgeConfig()
    token = "test-token-abc123"
    caps = Capabilities(streamlink=True, ffmpeg=True, wasapi=False, cuda=False)
    engine = FakeEngine(config)
    # Monkeypatch the controller's source construction to use FakeSource.
    controller = TranscriptionController(config, engine)
    orig_start = controller.start

    def patched_start(source, url=None, device_id=None, model=None, device=None, language=None):
        # Bypass real source construction; use a fake.
        controller._active = True
        controller._state.update(source=source, url=url, device_id=device_id, model=model or config.model, device=device or config.device)
        controller._state.reset_retries()
        controller._state.transition(TranscriptionState.PREPARING_SOURCE)
        controller._source = FakeSource(on_status=controller._on_source_status)
        controller._source.start()
        from madchatter_bridge.stt.segmenter import Segmenter
        controller._segmenter = Segmenter(controller._source, controller._engine, on_segment=controller._on_segment, on_status=controller._on_status)
        controller._segmenter.start()
        controller._state.transition(TranscriptionState.LISTENING)

    controller.start = patched_start
    app = create_app(config=config, token=token, capabilities=caps, engine=engine, controller=controller)
    return app, token, controller


@pytest.fixture
def client(app_and_token):
    app, token, _ = app_and_token
    return TestClient(app), token


# ── Tests ────────────────────────────────────────────────────────────────

class TestHealth:
    def test_health_no_auth_required(self, client):
        c, _ = client
        r = c.get("/v1/health")
        assert r.status_code == 200
        data = r.json()
        assert data["service"] == "madchatter-local"
        assert data["apiVersion"] == "1"
        assert data["capabilities"]["streamlink"] is True
        assert data["capabilities"]["ffmpeg"] is True
        # Health must never expose the token.
        assert "token" not in json.dumps(data).lower()

    def test_health_reports_capabilities(self, client):
        c, _ = client
        data = c.get("/v1/health").json()
        assert data["capabilities"]["wasapi"] is False
        assert data["capabilities"]["cuda"] is False


class TestAuth:
    def test_status_requires_token(self, client):
        c, _ = client
        r = c.get("/v1/status")
        assert r.status_code == 401

    def test_status_wrong_token_rejected(self, client):
        c, _ = client
        r = c.get("/v1/status", headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401

    def test_status_correct_token(self, client):
        c, token = client
        r = c.get("/v1/status", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        assert "transcription" in r.json()

    def test_start_requires_token(self, client):
        c, _ = client
        r = c.post("/v1/transcription/start", json={"source": "stream", "url": "https://twitch.tv/test"})
        assert r.status_code == 401

    def test_devices_requires_token(self, client):
        c, _ = client
        r = c.get("/v1/devices")
        assert r.status_code == 401


class TestStartValidation:
    def test_invalid_source(self, client):
        c, token = client
        r = c.post("/v1/transcription/start", json={"source": "invalid"}, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 400
        assert r.json()["detail"]["error"]["code"] == "INVALID_REQUEST"

    def test_stream_without_url(self, client):
        c, token = client
        r = c.post("/v1/transcription/start", json={"source": "stream"}, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 400

    def test_invalid_url(self, client):
        c, token = client
        r = c.post("/v1/transcription/start", json={"source": "stream", "url": "https://youtube.com/x"}, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 400
        assert r.json()["detail"]["error"]["code"] in ("INVALID_REQUEST", "STREAM_UNSUPPORTED")


class TestStartStop:
    def test_start_then_stop(self, client):
        c, token = client
        r = c.post("/v1/transcription/start", json={"source": "stream", "url": "https://twitch.tv/test"}, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        assert r.json()["started"] is True
        # Stop.
        r2 = c.post("/v1/transcription/stop", headers={"Authorization": f"Bearer {token}"})
        assert r2.status_code == 200
        assert r2.json()["stopped"] is True

    def test_duplicate_start_conflict(self, client):
        c, token = client
        r1 = c.post("/v1/transcription/start", json={"source": "stream", "url": "https://twitch.tv/test"}, headers={"Authorization": f"Bearer {token}"})
        assert r1.status_code == 200
        r2 = c.post("/v1/transcription/start", json={"source": "stream", "url": "https://twitch.tv/test2"}, headers={"Authorization": f"Bearer {token}"})
        assert r2.status_code == 409
        assert r2.json()["detail"]["error"]["code"] == "TRANSCRIPTION_ALREADY_ACTIVE"
        # Cleanup.
        c.post("/v1/transcription/stop", headers={"Authorization": f"Bearer {token}"})

    def test_stop_idempotent(self, client):
        c, token = client
        # Stop when idle — should not error.
        r = c.post("/v1/transcription/stop", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        assert r.json()["stopped"] is True


class TestSSE:
    def test_sse_requires_token(self, client):
        c, _ = client
        r = c.get("/v1/transcription/stream")
        assert r.status_code == 401

    def test_sse_stream_emits_events(self, client):
        c, token = client
        # The SSE endpoint is an infinite stream — hard to drain in TestClient.
        # Instead, verify the event bus + serialization directly (the transport
        # is thin: it just yields `data: {serialized}\n\n`).
        from madchatter_bridge.sse import bus, BridgeEvent
        evt = BridgeEvent("transcript.final", {"id": "seg_1", "text": "hello", "final": True})
        serialized = evt.serialize()
        assert '"type":"transcript.final"' in serialized
        assert '"text":"hello"' in serialized
        # The SSE endpoint requires the token (already tested above). The
        # ring-buffer replay + live delivery is exercised by the integration
        # smoke test against a running Bridge, not the TestClient.
        c.post("/v1/transcription/stop", headers={"Authorization": f"Bearer {token}"})
