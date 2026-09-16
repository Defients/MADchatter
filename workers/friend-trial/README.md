# Friend Trial Worker

A Cloudflare Worker that gives invited users temporary MADchatter access through a server-held Groq API key — without requiring them to bring their own key. The Groq credential never leaves Worker secret storage.

## Architecture

```
MADchatter (Neocities)  ──HTTPS──▶  Cloudflare Worker  ──GROQ_API_KEY──▶  Groq
```

The Worker exposes three endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/trial/status` | GET | Public, non-sensitive trial availability |
| `/trial/session` | POST | Turnstile (+ optional invite) → signed session token |
| `/trial/chat` | POST | Validated, rate-limited inference via Groq |

The Worker constructs the upstream payload entirely server-side. The client cannot control the upstream URL, model, Authorization header, or output token ceiling.

## Prerequisites

- A Cloudflare account
- Wrangler CLI (`npm install -g wrangler` or use `npx`)
- A Groq API key (disposable; set a hard spending cap in the Groq console)
- A Cloudflare Turnstile widget (site key + secret key)

## Configuration

### Public variables (in `wrangler.jsonc` → `vars`)

These are non-secret and safe to commit:

| Variable | Example | Purpose |
|---|---|---|
| `TRIAL_ENABLED` | `false` | Master kill switch |
| `TRIAL_END_AT` | `2026-09-17T03:59:59Z` | Auto-expiry timestamp (ISO 8601) |
| `TRIAL_MODEL` | `llama-3.3-70b-versatile` | Server-controlled Groq model |
| `TRIAL_MAX_OUTPUT_TOKENS` | `2048` | Hard output token ceiling |
| `TRIAL_SESSION_TTL_SECONDS` | `10800` | Session token lifetime (3 hours) |
| `TRIAL_REQUIRE_INVITE` | `false` | Enable invite-code gate |
| `ALLOWED_ORIGINS` | `https://madchatter.fun` | Comma-separated allowed origins |
| `TURNSTILE_SITE_KEY` | `0x4AAAAAAA...` | Public Turnstile site key |
| `TURNSTILE_EXPECTED_HOSTNAME` | `madchatter.fun` | Turnstile hostname validation |

### Secrets (set via `wrangler secret put` — never in source)

| Secret name | Purpose |
|---|---|
| `GROQ_API_KEY` | The funded Groq API key |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile server-side secret |
| `TRIAL_SESSION_SECRET` | HMAC signing key for session tokens |
| `TRIAL_INVITE_CODE` | (Optional) Required only when `TRIAL_REQUIRE_INVITE=true` |

## Local development

```bash
cd workers/friend-trial
npm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars with placeholder values (never real production keys)
npm run dev
```

For local Turnstile testing, use Cloudflare's official test keys (already in `.dev.vars.example`):
- Always-pass secret: `1x0000000000000000000000000000000AA`
- Always-fail secret: `2x0000000000000000000000000000000AA`

## Deployment

```bash
cd workers/friend-trial
npm install

# Login to Cloudflare (one-time)
npx wrangler login

# Set secrets (never commit these — paste when prompted)
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TRIAL_SESSION_SECRET
# Only if TRIAL_REQUIRE_INVITE=true:
npx wrangler secret put TRIAL_INVITE_CODE

# Deploy
npx wrangler deploy
```

Note the deployed Worker URL (e.g. `https://friend-trial.<account>.workers.dev`).

## Frontend configuration

In MADchatter's Settings panel, under the "Friend Trial" provider tab:
1. Set the **Worker URL** to the deployed Worker URL
2. Set the **Turnstile Site Key** (public key from your Turnstile widget)
3. Click **Start Friend Trial**

Alternatively, set these via Vite env variables in `.env`:
```
VITE_TRIAL_WORKER_URL=https://friend-trial.<account>.workers.dev
VITE_TURNSTILE_SITE_KEY=0x4AAAAAAA...
```

Then rebuild and deploy the static site to Neocities.

## Creating a Turnstile widget

1. Go to the Cloudflare dashboard → Turnstile
2. Add a widget with hostname `madchatter.fun`
3. Copy the **site key** (public) → set in MADchatter frontend config
4. Copy the **secret key** (private) → `wrangler secret put TURNSTILE_SECRET_KEY`

## Trial Day operation

### Enable

1. Set `TRIAL_ENABLED=true` in `wrangler.jsonc` (or via `wrangler` dashboard)
2. Set `TRIAL_END_AT` to the desired end time
3. Deploy: `npx wrangler deploy`
4. Verify: `curl https://friend-trial.<account>.workers.dev/trial/status`

### Test

1. Open `https://madchatter.fun`
2. Settings → Friend Trial → set Worker URL + Turnstile site key
3. Click "Start Friend Trial"
4. Complete the Turnstile challenge
5. Use MADchatter normally (Forge, AutoForge, etc.)

### Disable (kill switch)

Set `TRIAL_ENABLED=false` and deploy, or set `TRIAL_END_AT` to a past timestamp. Existing BYOK users are unaffected.

### Expire

The trial auto-expires when `TRIAL_END_AT` passes. The Worker rejects all trial requests; the frontend clears the stale session and offers BYOK.

### Rotate secrets

```bash
npx wrangler secret put GROQ_API_KEY          # new disposable key
npx wrangler secret put TRIAL_SESSION_SECRET  # new HMAC secret
npx wrangler secret put TURNSTILE_SECRET_KEY # if Turnstile secret changed
```

After the event, rotate the disposable Groq key in the Groq console or delete it.

## Testing

```bash
# Worker tests (mocked upstream — no real Groq credits spent)
cd workers/friend-trial
npm test

# Frontend trial tests
cd ../..
npx tsx src/lib/trial.test.ts
```

## Security model

- `GROQ_API_KEY` exists only as a Worker secret binding — never in frontend source, static assets, localStorage, config files, or git history.
- The Worker constructs the upstream payload from an explicit input allowlist. The client cannot control the upstream URL, model, Authorization header, or token ceiling.
- CORS is strict (exact origin match, `Vary: Origin`, no `*`) but is not the primary security boundary.
- Turnstile is validated server-side through Cloudflare's siteverify flow.
- Session tokens are stateless HMAC-signed (Web Crypto), short-lived, and verified on every inference request.
- Rate limiting uses Cloudflare's native Worker rate-limiting bindings (per-IP for session bootstrap, per-session + per-IP for inference).
- Upstream errors are sanitized — raw provider diagnostic bodies are never relayed to the client.
- Trial is text-only — images are stripped client-side and rejected server-side.
