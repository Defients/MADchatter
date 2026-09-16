"""Windows system-audio source via WASAPI loopback.

Uses PyAudioWPatch (a PyAudio fork with WASAPI loopback support) to capture
whatever audio is playing through the selected Windows output device. This
is explicitly labeled as system/output audio — it captures Discord, music,
game audio, and anything routed through that device, not just the streamer.

PyAudioWPatch is an optional dependency. If it is not installed, the source
fails with a clear AUDIO_DEVICE_NOT_FOUND / WASAPI-unavailable error rather
than crashing the Bridge.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from typing import Optional, Callable, Any

from .base import AudioSource, AudioSourceError
from ..config import TARGET_SAMPLE_RATE, TARGET_CHANNELS


def list_loopback_devices() -> list[dict]:
    """Enumerate available WASAPI loopback devices.

    Returns a list of {id, name, sampleRate, channels}. Empty if PyAudioWPatch
    is not installed or WASAPI is unavailable.
    """
    try:
        import pyaudiowpatch as pyaudio
    except ImportError:
        return []
    devices: list[dict] = []
    try:
        with pyaudio.PyAudio() as p:
            try:
                wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
            except OSError:
                return []
            for loopback in p.get_loopback_device_info_generator():
                devices.append({
                    "id": str(loopback["index"]),
                    "name": loopback["name"],
                    "sampleRate": int(loopback["defaultSampleRate"]),
                    "channels": int(loopback["maxInputChannels"]),
                })
    except Exception:
        pass
    return devices


class SystemSource(AudioSource):
    """WASAPI loopback capture source."""

    def __init__(
        self,
        device_id: Optional[str] = None,
        on_status: Optional[Callable[[str, Optional[str]], None]] = None,
    ) -> None:
        super().__init__(on_status)
        self._device_id = device_id  # None = default loopback
        self._pyaudio: Any = None
        self._stream: Any = None

    @property
    def source_kind(self) -> str:
        return "system"

    def start(self) -> None:
        """Start WASAPI loopback capture in a background thread."""
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="system-source")
        self._thread.start()

    def _run(self) -> None:
        try:
            import pyaudiowpatch as pyaudio
            import numpy as np
        except ImportError:
            self._emit_status("error", "WASAPI_UNAVAILABLE")
            return

        try:
            self._pyaudio = pyaudio.PyAudio()
            try:
                wasapi = self._pyaudio.get_host_api_info_by_type(pyaudio.paWASAPI)
            except OSError:
                self._emit_status("error", "WASAPI_UNAVAILABLE")
                return

            # Resolve the loopback device.
            if self._device_id:
                try:
                    idx = int(self._device_id)
                    dev = self._pyaudio.get_device_info_by_index(idx)
                    if not dev.get("isLoopbackDevice"):
                        # Find the loopback analogue of this output device.
                        dev = self._pyaudio.get_wasapi_loopback_analogue_by_index(idx)
                except Exception:
                    self._emit_status("error", "AUDIO_DEVICE_NOT_FOUND")
                    return
            else:
                # Default loopback for default speakers.
                try:
                    dev = self._pyaudio.get_default_wasapi_loopback()
                except Exception:
                    self._emit_status("error", "AUDIO_DEVICE_NOT_FOUND")
                    return

            device_rate = int(dev["defaultSampleRate"])
            device_channels = int(dev["maxInputChannels"])
            if device_channels == 0:
                self._emit_status("error", "AUDIO_DEVICE_NOT_FOUND")
                return

            self._emit_status("connected", dev["name"])

            # Capture callback: resample to 16kHz mono s16le and push to queue.
            def callback(in_data, frame_count, time_info, status, *extra):
                try:
                    audio = np.frombuffer(in_data, dtype=np.int16).astype(np.float32) / 32768.0
                    # Downmix to mono if multi-channel.
                    if device_channels > 1 and audio.size % device_channels == 0:
                        audio = audio.reshape(-1, device_channels).mean(axis=1)
                    # Resample if needed (linear interpolation — adequate for speech).
                    if device_rate != TARGET_SAMPLE_RATE:
                        n_out = int(audio.size * TARGET_SAMPLE_RATE / device_rate)
                        indices = np.linspace(0, audio.size - 1, n_out)
                        audio = np.interp(indices, np.arange(audio.size), audio)
                    pcm = (audio * 32768.0).clip(-32768, 32767).astype(np.int16).tobytes()
                    if not self._stop_event.is_set():
                        self._push(pcm)
                except Exception:
                    pass
                return (in_data, pyaudio.paContinue)

            self._stream = self._pyaudio.open(
                format=pyaudio.paInt16,
                channels=device_channels,
                rate=device_rate,
                frames_per_buffer=1024,
                input=True,
                input_device_index=dev["index"],
                stream_callback=callback,
            )

            # Keep the thread alive while capturing.
            while not self._stop_event.is_set():
                if self._stream and not self._stream.is_active():
                    self._emit_status("disconnected", "SOURCE_DISCONNECTED")
                    return
                time.sleep(0.2)
        except Exception as e:
            self._emit_status("error", "INTERNAL_ERROR")
            if os.environ.get("MADCHATTER_BRIDGE_VERBOSE"):
                print(f"[source] wasapi error: {e}")
        finally:
            self._cleanup()

    def _cleanup(self) -> None:
        if self._stream:
            try:
                if self._stream.is_active():
                    self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._pyaudio:
            try:
                self._pyaudio.terminate()
            except Exception:
                pass
            self._pyaudio = None
