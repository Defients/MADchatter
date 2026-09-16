"""Direct stream source: Twitch/Kick URL -> Streamlink -> FFmpeg -> 16kHz mono PCM.

Streamlink resolves the URL to a stream manifest; FFmpeg decodes the audio
stream and resamples to 16kHz mono s16le. Both are invoked with argument
arrays (never shell-interpolated strings) to prevent injection.

Reconnection is handled by the transcription controller (state machine +
backoff), not here — this source either connects or raises a typed error.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from typing import Optional, Callable

from .base import AudioSource, AudioSourceError
from ..config import TARGET_SAMPLE_RATE, TARGET_CHANNELS


# URL validation: only Twitch and Kick public stream/channel URLs.
_VALID_URL_PATTERNS = [
    re.compile(r"^https?://(www\.)?twitch\.tv/[A-Za-z0-9_]{3,25}/?$", re.IGNORECASE),
    re.compile(r"^https?://(www\.)?kick\.com(/[A-Za-z0-9_-]{3,25})?/?$", re.IGNORECASE),
]


def validate_stream_url(url: str) -> None:
    """Validate that a URL is an acceptable Twitch/Kick stream URL.

    Raises AudioSourceError(STREAM_UNSUPPORTED) on rejection. This is a
    safety gate — Streamlink will also reject, but we fail fast and never
    pass an unvalidated string to a subprocess.
    """
    if not url or not isinstance(url, str):
        raise AudioSourceError("STREAM_UNSUPPORTED", "A stream URL is required.")
    url = url.strip()
    if not any(p.match(url) for p in _VALID_URL_PATTERNS):
        raise AudioSourceError("STREAM_UNSUPPORTED", f"Unsupported stream URL. Only Twitch and Kick URLs are accepted.")


class StreamSource(AudioSource):
    """Streamlink + FFmpeg direct stream source."""

    def __init__(
        self,
        url: str,
        on_status: Optional[Callable[[str, Optional[str]], None]] = None,
        streamlink_path: Optional[str] = None,
        ffmpeg_path: Optional[str] = None,
    ) -> None:
        super().__init__(on_status)
        validate_stream_url(url)
        self._url = url
        self._streamlink: Optional[subprocess.Popen] = None
        self._ffmpeg: Optional[subprocess.Popen] = None
        self._streamlink_path = streamlink_path or shutil.which("streamlink") or "streamlink"
        self._ffmpeg_path = ffmpeg_path or shutil.which("ffmpeg") or "ffmpeg"

    @property
    def source_kind(self) -> str:
        return "stream"

    def start(self) -> None:
        """Start Streamlink -> FFmpeg pipeline in a background thread."""
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="stream-source")
        self._thread.start()

    def _run(self) -> None:
        """Resolve the stream with Streamlink, then pipe to FFmpeg for decode.

        On any failure, emits a typed status and exits — the controller
        decides whether to reconnect.
        """
        if not shutil.which(self._streamlink_path):
            self._emit_status("error", "STREAMLINK_NOT_FOUND")
            return
        if not shutil.which(self._ffmpeg_path):
            self._emit_status("error", "FFMPEG_NOT_FOUND")
            return

        self._emit_status("connecting")
        try:
            # Streamlink: resolve to best audio-only stream, output to stdout.
            # --default-stream picks audio-only when available; otherwise the
            # lowest-overhead suitable stream and FFmpeg extracts audio.
            streamlink_args = [
                self._streamlink_path,
                "--stdout",
                "--default-stream", "best,audio_only,bestaudio",
                "--stream-url",
                self._url,
            ]
            self._streamlink = subprocess.Popen(
                streamlink_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            # Wait for the resolved URL on stdout. Streamlink --stream-url
            # prints the direct stream URL and exits.
            stream_url_bytes = self._streamlink.stdout.readline()
            if not stream_url_bytes:
                err = self._read_streamlink_error()
                code = self._classify_streamlink_error(err)
                self._emit_status("error", code)
                return
            stream_url = stream_url_bytes.decode("utf-8", errors="replace").strip()
            self._streamlink.wait(timeout=5)
            self._streamlink = None
            if not stream_url or not stream_url.startswith(("http://", "https://")):
                self._emit_status("error", "STREAM_RESOLUTION_FAILED")
                return

            # FFmpeg: read the resolved URL, decode audio, resample to 16kHz mono s16le.
            ffmpeg_args = [
                self._ffmpeg_path,
                "-nostdin",
                "-i", stream_url,
                "-vn",  # no video
                "-ac", str(TARGET_CHANNELS),
                "-ar", str(TARGET_SAMPLE_RATE),
                "-f", "s16le",
                "-loglevel", "error",
                "-",
            ]
            self._ffmpeg = subprocess.Popen(
                ffmpeg_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            self._emit_status("connected")
            # Read PCM chunks until stopped or FFmpeg exits.
            chunk_size = 3200  # 100ms of 16kHz mono s16le
            while not self._stop_event.is_set():
                chunk = self._ffmpeg.stdout.read(chunk_size)
                if not chunk:
                    if self._ffmpeg.poll() is not None:
                        # FFmpeg exited — likely a network interruption or stream end.
                        self._emit_status("disconnected", "SOURCE_DISCONNECTED")
                        return
                    break
                self._push(chunk)
        except FileNotFoundError:
            self._emit_status("error", "STREAMLINK_NOT_FOUND")
        except Exception as e:
            self._emit_status("error", "INTERNAL_ERROR")
            if os.environ.get("MADCHATTER_BRIDGE_VERBOSE"):
                print(f"[source] stream pipeline error: {e}")
        finally:
            self._cleanup()

    def _read_streamlink_error(self) -> str:
        if not self._streamlink or not self._streamlink.stderr:
            return ""
        try:
            err = self._streamlink.stderr.read(4096).decode("utf-8", errors="replace")
        except Exception:
            err = ""
        return err

    @staticmethod
    def _classify_streamlink_error(err: str) -> str:
        """Map a Streamlink stderr string to a machine-readable error code."""
        err_lower = err.lower()
        if "no playable streams found" in err_lower or "could not find stream" in err_lower:
            return "STREAM_OFFLINE"
        if "unable to find stream" in err_lower:
            return "STREAM_OFFLINE"
        if "404" in err_lower or "not found" in err_lower:
            return "STREAM_OFFLINE"
        if "403" in err_lower or "forbidden" in err_lower or "unauthorized" in err_lower:
            return "STREAM_RESOLUTION_FAILED"
        if "could not resolve" in err_lower or "unsupported" in err_lower:
            return "STREAM_UNSUPPORTED"
        return "STREAM_RESOLUTION_FAILED"

    def _cleanup(self) -> None:
        """Terminate child processes. No orphans."""
        for proc_attr in ("_streamlink", "_ffmpeg"):
            proc = getattr(self, proc_attr, None)
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=3.0)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            setattr(self, proc_attr, None)
