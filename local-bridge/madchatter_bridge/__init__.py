"""MADchatter Local Bridge — local audio transcription companion.

A lightweight local service that captures livestream or system audio, transcribes
it locally with faster-whisper, and streams timestamped transcript segments to
the MADchatter web application over a loopback-only HTTP/SSE API.

Run with:  python -m madchatter_bridge
"""

__version__ = "0.1.0"
API_VERSION = "1"
