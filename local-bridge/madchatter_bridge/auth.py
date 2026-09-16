"""Token-based authentication for privileged Bridge routes.

The Bridge generates a cryptographically random local session token on first
run (see config.load_or_create_token). MADchatter must present it via the
`Authorization: Bearer <token>` header on all privileged routes. /health and
the SSE stream endpoints accept the token via a `?token=` query param too,
because EventSource cannot set custom headers.

Unrelated web origins are rejected by CORS (see api.py) before reaching auth.
"""

from __future__ import annotations

from typing import Optional

from fastapi import Request, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials


_bearer = HTTPBearer(auto_error=False)


async def require_token(request: Request, token: str) -> None:
    """Validate the local session token from header or query param.

    Raises HTTPException(401) if missing/invalid. Call from privileged routes.
    """
    # Header path (preferred for fetch requests).
    creds: Optional[HTTPAuthorizationCredentials] = await _bearer(request)
    presented: str | None = None
    if creds and creds.credentials:
        presented = creds.credentials
    # Query param path (EventSource cannot set headers).
    if presented is None:
        presented = request.query_params.get("token")
    if not presented or presented != token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "UNAUTHORIZED", "message": "Missing or invalid local bridge token."}},
        )
