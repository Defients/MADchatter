"""Streaming segmentation + overlap deduplication.

A livestream is indefinite. We never call Whisper on an ever-growing recording.
Instead, the segmenter accumulates PCM bytes into a bounded rolling buffer,
flushes a window to the STT engine at a fixed cadence, and deduplicates
overlapping text between consecutive windows so the transcript stays stable.

Dedup strategy (pragmatic, predictable):
  - Normalize each candidate segment (lowercase, strip, collapse spaces).
  - Compare against the tail of recently-emitted text.
  - If the new text is a prefix-extension of the last emission (rolling
    overlap), emit only the new suffix.
  - If the new text is fully contained in the last emission, suppress it.
  - Otherwise emit the full new text.

This prevents the classic "yeah we're going to..." / "yeah we're going to
play..." / "we're going to play that next..." triple-emission pattern.
"""

from __future__ import annotations

import os
import re
import time
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional, Callable

from ..config import SEGMENT_WINDOW_SECONDS, SEGMENT_OVERLAP_SECONDS, TARGET_SAMPLE_RATE


def _normalize(text: str) -> str:
    """Lowercase, collapse whitespace, strip. For comparison only."""
    return re.sub(r"\s+", " ", text.lower()).strip()


def _make_id() -> str:
    return "seg_" + uuid.uuid4().hex[:24]


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def dedupe_against_last(new_text: str, last_text: str) -> Optional[str]:
    """Return the text to emit, or None to suppress.

    Handles three cases:
      1. new_text is contained in last_text -> suppress (None)
      2. new_text extends last_text -> emit only the suffix
      3. new_text shares a prefix with last_text -> emit the non-overlapping part
      4. no overlap -> emit new_text as-is
    """
    new_n = _normalize(new_text)
    last_n = _normalize(last_text)
    if not new_n:
        return None
    if not last_n:
        return new_text.strip()
    # Case 1: new is fully contained in last.
    if new_n in last_n:
        return None
    # Case 2: last is a prefix of new (rolling overlap extension).
    if new_n.startswith(last_n):
        suffix = new_text.strip()[len(last_text.strip()):].strip()
        return suffix or None
    # Case 3: shared prefix — find the longest common prefix and emit the rest.
    # Use word-level alignment to avoid splitting words.
    last_words = last_n.split(" ")
    new_words = new_n.split(" ")
    overlap = 0
    max_check = min(len(last_words), len(new_words), 8)
    for i in range(max_check, 0, -1):
        if new_words[:i] == last_words[-i:]:
            overlap = i
            break
    if overlap > 0:
        remaining = new_words[overlap:]
        if remaining:
            return " ".join(remaining)
        return None
    # Case 4: no overlap.
    return new_text.strip()


class Segmenter:
    """Bounded rolling buffer + windowed transcription + dedup.

    Runs in its own thread, draining the audio source queue and feeding
    fixed-length windows to the STT engine. Emits finalized transcript
    segments via the callback.
    """

    def __init__(
        self,
        source,
        engine,
        on_segment: Callable[[dict], None],
        on_status: Optional[Callable[[str, Optional[str]], None]] = None,
    ) -> None:
        self._source = source
        self._engine = engine
        self._on_segment = on_segment
        self._on_status = on_status
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._last_emitted: str = ""
        self._buffer = bytearray()
        self._window_bytes = int(SEGMENT_WINDOW_SECONDS * TARGET_SAMPLE_RATE * 2)  # s16le = 2 bytes/sample
        self._overlap_bytes = int(SEGMENT_OVERLAP_SECONDS * TARGET_SAMPLE_RATE * 2)
        self._source_kind = source.source_kind

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="segmenter")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            chunk = self._source.get_chunk(timeout=0.5)
            if chunk:
                self._buffer.extend(chunk)
            # Flush when we have a full window.
            if len(self._buffer) >= self._window_bytes and not self._stop_event.is_set():
                self._flush_window()
        # Final flush of remaining audio.
        if len(self._buffer) > 0 and not self._stop_event.is_set():
            self._flush_window()

    def _flush_window(self) -> None:
        """Transcribe one window, dedupe, emit finalized segment."""
        # Take the window, keep overlap for the next window.
        window = bytes(self._buffer[:self._window_bytes])
        # Keep overlap tail for boundary reconciliation.
        del self._buffer[: self._window_bytes - self._overlap_bytes]
        if len(window) < 3200:  # < 100ms, skip
            return
        t_start = time.time()
        try:
            segments = self._engine.transcribe(window)
        except Exception as e:
            if self._on_status:
                self._on_status("error", "TRANSCRIPTION_FAILED")
            if os.environ.get("MADCHATTER_BRIDGE_VERBOSE"):
                print(f"[stt] transcription error: {e}")
            return
        if not segments:
            return
        # Combine all segment texts in this window into one line.
        combined = " ".join(s["text"] for s in segments).strip()
        if not combined:
            return
        # Dedup against the last emission.
        to_emit = dedupe_against_last(combined, self._last_emitted)
        if not to_emit:
            return
        self._last_emitted = (self._last_emitted + " " + to_emit).strip()[-500:]
        latency_ms = (time.time() - t_start) * 1000
        seg = {
            "id": _make_id(),
            "text": to_emit,
            "startedAt": _iso_now(),
            "endedAt": _iso_now(),
            "source": self._source_kind,
            "final": True,
        }
        try:
            self._on_segment(seg, latency_ms)
        except Exception:
            pass
