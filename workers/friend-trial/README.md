# Friend Trial Worker

Cloudflare Worker for MADchatter's keyless Friend Trial. Groq credentials remain in Worker secret storage; mobile Trial sessions receive a server-authoritative weighted daily allowance backed by a Durable Object.

## Architecture

```text
Mobile MADchatter
  ├─ POST /trial/session + anonymous installation UUID
  │    └─ Turnstile/invite verification → signed session with opaque quota id
  ├─ GET /trial/usage
  │    └─ per-client Durable Object → authoritative balance
  └─ POST /trial/chat
       ├─ validate session, origin, rate limits, and payload
       ├─ atomically reserve 1 text use or 2 vision uses
       ├─ server-controlled request → Groq
       └─ commit success or refund upstream failure
```

The Durable Object name is a keyed HMAC of a locally generated anonymous UUID. The raw UUID is not stored in Durable Object storage, returned by the Worker, or written to application logs. Reissuing a session for the same browser installation resolves to the same ledger and does not reset usage.

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/trial/status` | GET | Public, non-sensitive availability and generic product policy |
| `/trial/session` | POST | Turnstile plus optional invite and anonymous client id → signed session |
| `/trial/usage` | GET | Authenticated authoritative mobile allowance; non-mobile sessions return `limited: false` |
| `/trial/chat` | POST | Validated, rate-limited inference with atomic quota reservation |

Successful limited chat responses remain OpenAI-compatible and add:

```text
X-MADchatter-Trial-Used
X-MADchatter-Trial-Remaining
X-MADchatter-Trial-Limit
X-MADchatter-Trial-Reset-At
```

Exhaustion returns HTTP `429`, error code `TRIAL_DAILY_LIMIT_REACHED`, the current `usage` object, and a reset-based `Retry-After`. It does not invalidate the session.

## Quota policy

- Mobile allowance: `30` weighted uses by default (`TRIAL_MOBILE_DAILY_LIMIT`).
- Text inference: `1` use.
- Vision inference: `2` uses, determined from the validated request server-side.
- Reset boundary: `12:00 PM America/New_York`, calculated with timezone data so EST, EDT, and 23/25-hour DST days remain correct.
- Reservation is atomic and occurs before the Groq call.
- Successful inference commits the reservation; upstream 429, timeout, and failure refund it.
- A short pending-reservation lease repairs interrupted requests that never reach commit/refund.
- Durable Object/storage failure fails closed before paid inference.
- Existing rate-limit bindings remain independent short-window abuse controls.

## Configuration

Public, non-secret variables live in `wrangler.jsonc`:

| Variable | Example | Purpose |
|---|---|---|
| `TRIAL_ENABLED` | `false` | Master kill switch |
| `TRIAL_END_AT` | `2026-09-17T03:59:59Z` | Campaign expiry instant |
| `TRIAL_MODEL` | `openai/gpt-oss-120b` | Server-controlled text model |
| `TRIAL_VISION_MODEL` | `qwen/qwen3.6-27b` | Optional server-controlled vision model |
| `TRIAL_MAX_OUTPUT_TOKENS` | `2048` | Output ceiling |
| `TRIAL_SESSION_TTL_SECONDS` | `10800` | Signed session lifetime |
| `TRIAL_MOBILE_DAILY_LIMIT` | `30` | Weighted daily mobile allowance |
| `TRIAL_REQUIRE_INVITE` | `false` | Invite-code gate |
| `ALLOWED_ORIGINS` | `https://madchatter.fun` | Exact comma-separated origins |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAAA...` | Public Turnstile key |
| `TURNSTILE_EXPECTED_HOSTNAME` | `madchatter.fun` | Turnstile hostname validation |

Secrets must be set with Wrangler and never committed:

```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TRIAL_SESSION_SECRET
# Only when TRIAL_REQUIRE_INVITE=true:
npx wrangler secret put TRIAL_INVITE_CODE
```

`wrangler.jsonc` binds `TRIAL_USAGE` to `TrialUsageDurableObject` and includes the `v1-trial-usage` SQLite-class migration. Preserve the migration tag after it has shipped; later storage changes need a new migration tag.

## Local development and verification

```bash
cd workers/friend-trial
npm install
copy .dev.vars.example .dev.vars   # Windows; use cp on macOS/Linux
npm run dev

npm run lint
npm test
npm run types
npm run dry-run
```

The test harness mocks Turnstile, Groq, rate limits, and serialized Durable Object storage. No Groq credits or production secrets are used.

Frontend public configuration remains:

```text
VITE_TRIAL_WORKER_URL=https://friend-trial.<account>.workers.dev
VITE_TURNSTILE_SITE_KEY=0x4AAAAAAA...
```

## Deployment checklist

Deployment is intentionally separate from local implementation and validation:

1. Review `TRIAL_ENABLED` and set a future `TRIAL_END_AT` for the intended campaign.
2. Confirm all secrets are present in the target Cloudflare environment.
3. Confirm the `TRIAL_USAGE` Durable Object binding and `v1-trial-usage` migration are included.
4. Run all four local verification commands above.
5. Deploy with `npx wrangler deploy` only when explicitly authorized.
6. Smoke-test `/trial/status`, mobile activation, `/trial/usage`, one text request, one vision request (if enabled), exhaustion, and reset behavior.

The checked-in campaign end date may already be in the past. This patch does not silently re-enable the Trial or deploy anything.

## Security and privacy model

- The Groq key exists only as a Worker secret binding.
- The client cannot control the upstream URL, model, authorization header, quota cost, or output ceiling.
- Turnstile is verified server-side; CORS is strict but is not treated as the primary security boundary.
- Session tokens are short-lived HMAC credentials. Version 2 embeds only a random session id, an opaque quota id, server-derived client class, and timestamps.
- Pre-quota version 1 session tokens are intentionally rejected after deployment; affected users reactivate through the existing Friend Trial flow.
- The browser keeps one random anonymous installation UUID in localStorage. Clearing site data creates a new identity; this is a privacy-conscious lightweight control, not durable account identity.
- Mobile classification is derived from User-Agent at activation. It is sufficient for product segmentation but is not strong device attestation.
- No raw anonymous UUID, IP address, prompt, image, quota balance, or provider response is deliberately logged. Existing logs use short session/IP prefixes and safe error categories.
- Upstream diagnostic bodies are never relayed to clients.
- Vision inputs accept only validated inline image data when `TRIAL_VISION_MODEL` is configured; otherwise images are stripped in the client and rejected by the Worker.
