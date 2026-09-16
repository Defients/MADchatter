"""Unit tests for URL validation, state machine, config parsing, and dedup.

Run with:  pytest tests/  (or:  python -m pytest tests/)
"""

import os
import sys
import pytest

# Ensure the package is importable when running from the repo root.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from madchatter_bridge.audio.stream import validate_stream_url, AudioSourceError
from madchatter_bridge.state import StateMachine, TranscriptionState
from madchatter_bridge.stt.segmenter import dedupe_against_last, _normalize
from madchatter_bridge.config import BridgeConfig


# ── URL validation ───────────────────────────────────────────────────────

class TestUrlValidation:
    def test_valid_twitch(self):
        validate_stream_url("https://www.twitch.tv/example")
        validate_stream_url("https://twitch.tv/example")
        validate_stream_url("http://twitch.tv/example")

    def test_valid_kick(self):
        validate_stream_url("https://kick.com/example")
        validate_stream_url("https://www.kick.com/example")

    def test_reject_empty(self):
        with pytest.raises(AudioSourceError) as exc:
            validate_stream_url("")
        assert exc.value.code == "STREAM_UNSUPPORTED"

    def test_reject_arbitrary_url(self):
        with pytest.raises(AudioSourceError) as exc:
            validate_stream_url("https://youtube.com/watch?v=abc")
        assert exc.value.code == "STREAM_UNSUPPORTED"

    def test_reject_non_url(self):
        with pytest.raises(AudioSourceError) as exc:
            validate_stream_url("not a url")
        assert exc.value.code == "STREAM_UNSUPPORTED"

    def test_reject_command_injection(self):
        # Shell metacharacters in a URL-shaped string are still rejected by
        # the allowlist — they never reach a subprocess.
        with pytest.raises(AudioSourceError):
            validate_stream_url("https://twitch.tv/x; rm -rf /")

    def test_reject_localhost_url(self):
        with pytest.raises(AudioSourceError):
            validate_stream_url("http://127.0.0.1:8765/health")


# ── State machine ─────────────────────────────────────────────────────────

class TestStateMachine:
    def test_initial_state_is_idle(self):
        sm = StateMachine()
        assert sm.get_state() == TranscriptionState.IDLE

    def test_legal_transition(self):
        sm = StateMachine()
        sm.transition(TranscriptionState.PREPARING_SOURCE)
        assert sm.get_state() == TranscriptionState.PREPARING_SOURCE

    def test_illegal_transition_raises(self):
        sm = StateMachine()
        # IDLE -> LISTENING is illegal (must go through PREPARING_SOURCE)
        with pytest.raises(ValueError):
            sm.transition(TranscriptionState.LISTENING)

    def test_start_while_listening_blocked_by_controller(self):
        # The controller checks is_active(); the state machine itself allows
        # LISTENING -> STOPPING but not LISTENING -> PREPARING_SOURCE.
        sm = StateMachine()
        sm.transition(TranscriptionState.PREPARING_SOURCE)
        sm.transition(TranscriptionState.LISTENING)
        with pytest.raises(ValueError):
            sm.transition(TranscriptionState.PREPARING_SOURCE)

    def test_stop_from_listening(self):
        sm = StateMachine()
        sm.transition(TranscriptionState.PREPARING_SOURCE)
        sm.transition(TranscriptionState.LISTENING)
        sm.transition(TranscriptionState.STOPPING)
        assert sm.get_state() == TranscriptionState.STOPPING
        sm.transition(TranscriptionState.IDLE)
        assert sm.get_state() == TranscriptionState.IDLE

    def test_stop_from_idle_is_noop_via_controller(self):
        # The controller guards stop() with is_active(); the state machine
        # itself has no IDLE -> STOPPING transition.
        sm = StateMachine()
        with pytest.raises(ValueError):
            sm.transition(TranscriptionState.STOPPING)

    def test_error_resets_retries_on_idle(self):
        sm = StateMachine()
        sm.transition(TranscriptionState.PREPARING_SOURCE)
        sm.set_error("STREAM_OFFLINE", "offline")
        assert sm.snapshot.last_error_code == "STREAM_OFFLINE"
        sm.transition(TranscriptionState.IDLE)
        assert sm.snapshot.retry_count == 0
        assert sm.snapshot.last_error is None

    def test_retry_increment(self):
        sm = StateMachine()
        assert sm.increment_retry() == 1
        assert sm.increment_retry() == 2
        assert sm.snapshot.retry_count == 2


# ── Dedup ────────────────────────────────────────────────────────────────

class TestDedup:
    def test_no_overlap_emits_full(self):
        assert dedupe_against_last("hello world", "goodbye") == "hello world"

    def test_exact_repeat_suppressed(self):
        assert dedupe_against_last("yeah we're going to play", "yeah we're going to play") is None

    def test_contained_suppressed(self):
        assert dedupe_against_last("going to play", "yeah we're going to play that next") is None

    def test_rolling_extension_emits_suffix(self):
        # Classic rolling-window repeat: each window extends the previous.
        last = "yeah we're going to"
        new = "yeah we're going to play that next"
        result = dedupe_against_last(new, last)
        assert result == "play that next"

    def test_shared_prefix_emits_remainder(self):
        last = "we're going to play"
        new = "we're going to play that next now"
        result = dedupe_against_last(new, last)
        assert result == "that next now"

    def test_empty_suppressed(self):
        assert dedupe_against_last("", "previous") is None
        assert dedupe_against_last("   ", "previous") is None

    def test_first_emission(self):
        assert dedupe_against_last("hello world", "") == "hello world"

    def test_case_insensitive_comparison(self):
        # Comparison normalizes case; the emitted text preserves the new
        # text's original casing.
        result = dedupe_against_last("Yeah We're Going To Play", "yeah we're going to")
        assert result == "Play"


# ── Config ───────────────────────────────────────────────────────────────

class TestConfig:
    def test_defaults(self):
        cfg = BridgeConfig()
        assert cfg.host == "127.0.0.1"
        assert cfg.port == 8765
        assert cfg.model == "small.en"
        assert cfg.device == "auto"
        assert cfg.language == "en"
        assert cfg.vad is True
        assert "*" not in cfg.allowed_origins

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("MADCHATTER_BRIDGE_PORT", "9999")
        monkeypatch.setenv("MADCHATTER_BRIDGE_MODEL", "base.en")
        cfg = BridgeConfig.load()
        assert cfg.port == 9999
        assert cfg.model == "base.en"

    def test_env_invalid_port_ignored(self, monkeypatch):
        monkeypatch.setenv("MADCHATTER_BRIDGE_PORT", "not-a-number")
        cfg = BridgeConfig.load()
        assert cfg.port == 8765

    def test_loopback_default(self):
        cfg = BridgeConfig()
        assert cfg.host in ("127.0.0.1", "localhost", "::1")
