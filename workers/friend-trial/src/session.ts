/**
 * Stateless signed trial session tokens using Web Crypto (HMAC-SHA256).
 *
 * Token format: base64url(payload).base64url(signature)
 *
 * Properties:
 *  - `sid` is cryptographically random (crypto.getRandomValues)
 *  - HMAC signing via crypto.subtle.sign; verification via crypto.subtle.verify
 *    (constant-time comparison internally)
 *  - Explicit expiry + version validation
 *  - Malformed tokens are rejected without leaking why
 *  - No sensitive user data inside the token
 *  - Complete tokens are never logged
 */
import type { SessionPayload } from "./types";

const TOKEN_VERSION = 1;
const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    TEXT_ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function randomId(byteLen = 18): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base64urlEncode(buf);
}

/**
 * Create a signed session token.
 * Returns `{ token, expiresAt }` where expiresAt is epoch ms.
 */
export async function createSessionToken(
  secret: string,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: number }> {
  const now = Date.now();
  const exp = now + ttlSeconds * 1000;
  const payload: SessionPayload = {
    v: TOKEN_VERSION,
    sid: randomId(),
    iat: Math.floor(now / 1000),
    exp: Math.floor(exp / 1000),
  };
  const payloadBytes = TEXT_ENC.encode(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, payloadBytes),
  );
  const token = `${base64urlEncode(payloadBytes)}.${base64urlEncode(sigBytes)}`;
  return { token, expiresAt: exp };
}

export type VerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; code: "INVALID_SESSION" | "SESSION_EXPIRED" };

/**
 * Verify a session token's signature, version, and expiry.
 * Never throws — returns a stable error code on any failure.
 */
export async function verifySessionToken(
  secret: string,
  token: string | null | undefined,
): Promise<VerifyResult> {
  if (!token || typeof token !== "string") return { ok: false, code: "INVALID_SESSION" };
  const dot = token.lastIndexOf(".");
  if (dot < 1) return { ok: false, code: "INVALID_SESSION" };
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const payloadBytes = base64urlDecode(payloadB64);
  const sigBytes = base64urlDecode(sigB64);
  if (!payloadBytes || !sigBytes) return { ok: false, code: "INVALID_SESSION" };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(TEXT_DEC.decode(payloadBytes));
  } catch {
    return { ok: false, code: "INVALID_SESSION" };
  }
  if (
    typeof payload.v !== "number" ||
    typeof payload.sid !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, code: "INVALID_SESSION" };
  }
  if (payload.v !== TOKEN_VERSION) return { ok: false, code: "INVALID_SESSION" };

  // Verify HMAC (constant-time comparison via crypto.subtle.verify).
  let valid = false;
  try {
    const key = await importHmacKey(secret);
    valid = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
  } catch {
    return { ok: false, code: "INVALID_SESSION" };
  }
  if (!valid) return { ok: false, code: "INVALID_SESSION" };

  // Expiry check (server-authoritative).
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) return { ok: false, code: "SESSION_EXPIRED" };

  return { ok: true, payload };
}

/** Extract a short hash prefix of the session id for sanitized logging. */
export function sessionHashPrefix(payload: SessionPayload): string {
  return payload.sid.slice(0, 6);
}
