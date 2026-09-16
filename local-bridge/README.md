# MADchatter Local Bridge v0.1

A Windows-first local transcription companion for MADchatter. Captures livestream
or system audio, transcribes it locally with `faster-whisper`, and streams
timestamped transcript segments to MADchatter over a loopback-only HTTP/SSE API.

**No per-minute speech-to-text fees. No mandatory third-party STT account.**

## Architecture

```
Direct Stream:
Twitch/Kick → Streamlink → FFmpeg → faster-whisper → Bridge → MADchatter

Fallback:
Windows WASAPI loopback → faster-whisper → Bridge → MADchatter
```

The Bridge is a separate Python process. MADchatter connects to it over
localhost HTTP + Server-Sent Events. Finalized transcript segments are routed
through the existing `appendAudioTranscript` chokepoint — the same path used by
browser Whisper and Deepgram — so Room Model, Perception Liveness, Spoken
Callouts, AutoForge, and Memory all work unchanged.

## Requirements

- **Python 3.10+** (3.11/3.12 recommended)
- **FFmpeg** — add `ffmpeg.exe` to PATH or set `FFMPEG_PATH`
- **Streamlink** — `pip install streamlink` (Twitch/Kick direct stream)
- **faster-whisper** — `pip install faster-whisper`
- **PyAudioWPatch** — `pip install PyAudioWPatch` (Windows system audio / WASAPI loopback)
- **NVIDIA GPU + CUDA** (optional, for GPU acceleration; CPU fallback is automatic)
- **Windows 10/11** (WASAPI loopback is Windows-only; direct stream works cross-platform)

## Installation

```bash
cd local-bridge

# Create a virtual environment (recommended)
python -m venv .venv
.venv\Scripts\activate

# Install the Bridge + dependencies
pip install -e .

# Verify runtime dependencies
python -m madchatter_bridge --check-deps
```

### Verifying external tools

```bash
# FFmpeg
ffmpeg -version

# Streamlink (optional — only needed for direct stream capture)
streamlink --version

# CUDA (optional — faster-whisper auto-detects)
python -c "import torch; print(torch.cuda.is_available())"
```

## Running the Bridge

### Option A: Windows launcher

Double-click `start-local-bridge.bat` in the repository root, or run it from
a terminal:

```bash
start-local-bridge.bat
```

The launcher prints a session token on first run. **Copy this token** — you'll
paste it into MADchatter to authenticate.

### Option B: Manual

```bash
cd local-bridge
python -m madchatter_bridge
```

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `MADCHATTER_BRIDGE_HOST` | `127.0.0.1` | Bind address (loopback only — do not expose to LAN) |
| `MADCHATTER_BRIDGE_PORT` | `8765` | Listen port |
| `MADCHATTER_BRIDGE_TOKEN` | (auto-generated) | Auth token (auto-saved to `%USERPROFILE%\.madchatter-bridge-token`) |
| `MADCHATTER_BRIDGE_MODEL` | `small.en` | Default faster-whisper model |
| `MADCHATTER_BRIDGE_DEVICE` | `auto` | `auto` / `cuda` / `cpu` |
| `MADCHATTER_BRIDGE_COMPUTE_TYPE` | `auto` | Whisper compute type (auto-selects based on device) |
| `MADCHATTER_BRIDGE_LANGUAGE` | `en` | Default transcription language |
| `FFMPEG_PATH` | (PATH lookup) | Path to `ffmpeg.exe` |
| `STREAMLINK_PATH` | (PATH lookup) | Path to `streamlink` |

## Connecting from MADchatter

1. Start the Bridge (see above). Note the token printed in the console.
2. Open MADchatter in your browser.
3. In the stream overlay, click the **Local** button.
4. Click **Enable**.
5. Expand **Details** and paste the token into the **Token** field.
6. The status badge should change to **Connected**.
7. Choose a source:
   - **Direct Stream** — transcribes the active Twitch/Kick channel via Streamlink.
   - **System Audio** — transcribes everything playing through your Windows audio output.
8. Click **Start Listening**. Transcript segments appear in the Audio Transcript.

## How it works

### Direct Stream path

1. MADchatter sends the active channel URL to the Bridge.
2. The Bridge runs `streamlink` to resolve the stream to an audio-only URL.
3. The Bridge pipes the audio through `ffmpeg` to decode + resample to 16 kHz mono PCM.
4. The PCM is fed to `faster-whisper` in rolling windows with VAD filtering.
5. Finalized segments are deduplicated (overlap removal) and sent to MADchatter via SSE.

### System Audio path (WASAPI loopback)

1. The Bridge enumerates Windows render endpoints (speakers, headphones).
2. The user's default render endpoint is captured in loopback mode via PyAudioWPatch.
3. The loopback stream is resampled to 16 kHz mono and fed to faster-whisper.
4. Same dedup + SSE delivery as the direct stream path.

### CUDA / CPU selection

- `device: "auto"` — tries CUDA first, falls back to CPU on init failure.
- `device: "cuda"` — forces CUDA; returns an error if unavailable.
- `device: "cpu"` — forces CPU (useful for debugging or when CUDA is flaky).

The Bridge never silently degrades from CUDA to CPU without emitting a
`CUDA_UNAVAILABLE` event to the frontend.

## Security

- **Loopback-only bind.** The Bridge binds to `127.0.0.1` by default. It is not
  reachable from other machines on the LAN.
- **Token authentication.** All privileged routes (`/v1/status`, `/v1/devices`,
  `/v1/transcription/start`, `/v1/transcription/stop`) require a `Bearer` token.
  The token is auto-generated on first run and saved to
  `%USERPROFILE%\.madchatter-bridge-token`.
- **No silent microphone capture.** The Bridge captures system audio (render
  endpoint loopback) or livestream audio — never the microphone.
- **No CORS wildcard.** CORS is restricted to localhost origins only.
- **No secrets in exports.** The token is never included in MADchatter's
  `exportSettings` — same treatment as bot sessions.

## API Reference

All routes are prefixed with `/v1`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | No | Health check + capabilities |
| `GET` | `/status` | Yes | Current transcription + model status |
| `GET` | `/devices` | Yes | Enumerate WASAPI loopback devices |
| `POST` | `/transcription/start` | Yes | Start a transcription session |
| `POST` | `/transcription/stop` | Yes | Stop the active session (idempotent) |
| `GET` | `/transcription/stream` | Yes (query param) | SSE event stream |

### Error contract

All errors return a JSON body with this shape:

```json
{
  "error": {
    "code": "STREAM_OFFLINE",
    "message": "The selected stream appears to be offline.",
    "details": null
  }
}
```

Common error codes: `INVALID_REQUEST`, `UNAUTHORIZED`,
`TRANSCRIPTION_ALREADY_ACTIVE`, `STREAM_UNSUPPORTED`, `STREAM_OFFLINE`,
`STREAM_RESOLUTION_FAILED`, `FFMPEG_NOT_FOUND`, `STREAMLINK_NOT_FOUND`,
`AUDIO_DEVICE_NOT_FOUND`, `MODEL_LOAD_FAILED`, `CUDA_UNAVAILABLE`,
`TRANSCRIPTION_FAILED`, `SOURCE_DISCONNECTED`, `INTERNAL_ERROR`.

## Testing

```bash
cd local-bridge

# Unit + integration tests (42 tests)
python -m pytest tests/ -v
```

## Troubleshooting

### "Local Bridge isn't running on this computer"

- Make sure the Bridge process is running (`python -m madchatter_bridge`).
- Check that the port matches (default `8765`).
- If MADchatter is served over HTTPS, the browser may block the HTTP localhost
  connection. Allow **Local Network Access** for the site in your browser
  settings (Chrome: `chrome://settings/content/insecureContent`).

### "FFmpeg was not found"

- Install FFmpeg and add it to PATH, or set `FFMPEG_PATH` to the full path of
  `ffmpeg.exe`.

### "Streamlink couldn't resolve this stream"

- The stream may be offline.
- Streamlink may be outdated — update with `pip install --upgrade streamlink`.
- Some streams require authentication. v0.1 does not pass Streamlink auth.

### "CUDA wasn't available, so transcription switched to CPU"

- This is informational, not an error. The Bridge fell back to CPU.
- To force CPU: set `MADCHATTER_BRIDGE_DEVICE=cpu`.
- To debug CUDA: run `python -c "import torch; print(torch.cuda.is_available())"`.

### "Model load failed"

- The model may still be downloading on first use. Check the Bridge console.
- Disk may be full. Models are cached in `~/.cache/huggingface`.

### Transcripts are delayed or missing

- The `small.en` model balances speed and accuracy. Try `tiny.en` for lower latency.
- On CPU, large models may not keep up with realtime. Use `cuda` or a smaller model.
- System Audio captures ALL output — Discord, music, and game audio may pollute
  the transcript. Direct Stream is cleaner for stream-only transcription.

### Orphan processes after stopping

- The Bridge kills child processes (FFmpeg, Streamlink) on stop. If the Bridge
  itself crashes, you may need to kill them manually:
  ```bash
  taskkill /F /IM ffmpeg.exe
  taskkill /F /IM streamlink.exe
  ```

## v0.1 Limitations

- **Twitch and Kick only** for direct stream capture. YouTube, YouTube Live,
  and other platforms are not supported (Streamlink supports them, but the
  Bridge's URL allowlist restricts to Twitch/Kick for v0.1).
- **Windows only** for system audio (WASAPI loopback). macOS/Linux would need
  a different loopback mechanism (BlackHole, PulseAudio monitor).
- **English models only** by default (`*.en` variants). Multilingual models
  (`small`, `medium`) work if you set `MADCHATTER_BRIDGE_LANGUAGE` appropriately.
- **No Streamlink auth** — subscriber-only or quality-gated streams may fail.
- **No partial transcripts** — v0.1 ships final segments only. Partials are
  received but not ingested into the transcript (prevents hallucinated text).
- **Single concurrent session** — only one transcription session at a time.
- **No speaker diarization** — transcripts are not attributed to speakers.
- **No word-level timestamps** — segments have start/end times but no per-word
  alignment.

## Files

```
local-bridge/
├── pyproject.toml
├── start-local-bridge.bat
├── README.md
├── madchatter_bridge/
│   ├── __init__.py
│   ├── __main__.py          # Entry point
│   ├── api.py               # FastAPI routes
│   ├── auth.py              # Token generation/validation
│   ├── capabilities.py      # Runtime capability detection
│   ├── config.py            # Environment-driven config
│   ├── controller.py       # Orchestrates source + engine + segmenter
│   ├── sse.py               # Bounded SSE event bus
│   ├── state.py             # Lifecycle state machine
│   ├── audio/
│   │   ├── base.py          # AudioSource protocol
│   │   ├── stream.py        # Streamlink + FFmpeg direct stream
│   │   └── system.py        # WASAPI loopback system audio
│   └── stt/
│       ├── engine.py        # faster-whisper wrapper
│       └── segmenter.py     # Rolling windows + VAD + dedup
└── tests/
    ├── test_unit.py         # 27 unit tests
    └── test_api.py          # 15 API integration tests
```
