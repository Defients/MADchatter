# MADchatter Risk Register

**Commit:** 7327dd3 | **Date:** 2026-09-08 | **Auditor:** GLM-5.2 High

Severity scale: CRITICAL > HIGH > MEDIUM > LOW
Verification: VERIFIED (evidence-cited) | INFERRED (code-structure-based) | NOT_RUN

---

## CRITICAL Risks

| ID | Risk | Severity | Evidence | Impact | Remediation | Verification |
|---|---|---|---|---|---|---|
| R-CRIT-001 | Hardcoded Kick OAuth client secret in browser bundle | CRITICAL | `src/lib/kick.ts:27` — `DEFAULT_KICK_CLIENT_SECRET = import.meta.env.VITE_KICK_CLIENT_SECRET \|\| "1d65cf46..."` | Secret exposed to every visitor; can impersonate app in Kick OAuth; refresh tokens mintable | Remove secret from client; move all Kick token ops to server/worker proxy; rotate secret | VERIFIED |
| R-CRIT-002 | Hardcoded Joystick OAuth client secret in browser bundle | CRITICAL | `src/lib/joystick.ts:41` — `DEFAULT_JOYSTICK_CLIENT_SECRET = import.meta.env.VITE_JOYSTICK_CLIENT_SECRET \|\| "hT4eRDiAs5jhyOJbgup-JQ"` | Secret exposed to every visitor; bot credentials compromised | Remove secret from client; move all Joystick token ops to proxy; rotate secret | VERIFIED |
| R-CRIT-003 | Hardcoded Joystick credentials in Cloudflare Worker | CRITICAL | `cloudflare-worker/joystick-token-proxy.js:167-168` — fallback `clientSecret = "hT4eRDiAs5jhyOJbgup-JQ"` | Worker source is public-deployable; secret in deployed worker | Remove hardcoded fallback; require secret via Worker env binding; rotate | VERIFIED |

## HIGH Risks

| ID | Risk | Severity | Evidence | Impact | Remediation | Verification |
|---|---|---|---|---|---|---|
| R-HIGH-001 | AI provider API keys stored in plaintext localStorage | HIGH | `src/lib/keys.ts:41-49` — `localStorage.setItem("autoforge_api_keys", JSON.stringify(merged))` | Any XSS exposes all AI keys; persists across sessions | Move keys server-side; use httpOnly cookie session; never persist in localStorage | VERIFIED |
| R-HIGH-002 | `dangerouslyAllowBrowser: true` for OpenAI/Anthropic | HIGH | `src/lib/ai.ts:251,275,343,442` — `new OpenAI({ apiKey, dangerouslyAllowBrowser: true })` | API keys sent from browser to third-party; CORS/network exposure | Route all AI calls through server.ts proxy | VERIFIED |
| R-HIGH-003 | Reflected XSS in index.html via error_description | HIGH | `index.html:83` — `document.body.innerHTML = '...' + params.get('error_description')` | Attacker-crafted OAuth error URL injects HTML/JS | Use `textContent` instead of `innerHTML`; sanitize | VERIFIED |
| R-HIGH-004 | Loose postMessage origin validation (substring match) | HIGH | `useTwitchAuth.ts:42`, `useKickAuth.ts:50`, `useJoystickAuth.ts:69` — `origin.includes('localhost')` | Malicious origin containing substring can receive auth tokens | Use exact origin allowlist; remove wildcard fallback | VERIFIED |
| R-HIGH-005 | OAuth callback postMessage with targetOrigin '*' | HIGH | `public/kick-auth-callback.html:60`, `public/joystick-auth-callback.html:57`, `server.ts:312-332` | Auth tokens broadcast to any window | Set exact opener origin | VERIFIED |
| R-HIGH-006 | Server session ID accepted without signature | HIGH | `server.ts:38-50` — `getSessionId` accepts `Authorization: Bearer` or `x-session-id` with no HMAC | Session forgery; impersonation | Sign session IDs with HMAC; verify on every request | VERIFIED |
| R-HIGH-007 | Anonymous in-memory session creation via /api/set-keys | HIGH | `server.ts:540-564` — creates session with `username: 'anonymous'` from any caller | Anyone can create server sessions; store arbitrary keys | Require authentication; rate-limit; remove anonymous session creation | VERIFIED |
| R-HIGH-008 | SSRF via user-supplied customBaseUrl | HIGH | `server.ts:716,900` — `baseUrl = session?.customBaseUrl \|\| 'https://openrouter.ai/api/v1'`; `src/lib/ai.ts:144` | User can force server/browser to send API key to internal endpoints (e.g., cloud metadata) | Validate customBaseUrl against allowlist; block private IP ranges | VERIFIED |
| R-HIGH-009 | AI output not schema-validated before autonomous action | HIGH | `src/lib/ai.ts:300,480,702` — `JSON.parse(cleanJsonStr(...))` with no validation; `useAutoForge.ts:449-552` sends `action_payload` directly | Malformed/injected AI output sent to chat; no moderation layer | Validate against JSON schema; add moderation/classification layer before send | VERIFIED |
| R-HIGH-010 | Bookkeeping before side effects in AutoForge | HIGH | `useAutoForge.ts:457-505,516-549` — `addSentMsgRef`, `incrSentRef`, `addActionHistoryEntry({success:true})` called before `sendFn` resolves | Inflated stats; action history shows success for failed sends | Await sendFn; record success/failure after resolution | VERIFIED |
| R-HIGH-011 | Prompt injection via unsanitized chat/audio/visual context | HIGH | `src/lib/ai.ts:179-214`, `server.ts:756-785,1218-1249` — concatenation without instruction/data separation | Attacker in chat can inject instructions to AI; hijack autonomous actions | Separate instructions from data; sanitize context; add system prompt guardrails | VERIFIED |
| R-HIGH-012 | Twitch access token persisted in localStorage | HIGH | `src/lib/twitch.ts:146-177` — `localStorage.setItem(SESSION_KEY, JSON.stringify(session))` | XSS exposes Twitch token; persists across sessions | Use server-side session; httpOnly cookie | VERIFIED |
| R-HIGH-013 | Kick/Joystick access+refresh tokens in localStorage | HIGH | `src/lib/kick.ts:524-557`, `src/lib/joystick.ts:307-365` | XSS exposes all platform tokens; refresh tokens compromised | Move to server-side session | VERIFIED |
| R-HIGH-014 | ElevenLabs API key persisted in Zustand localStorage | HIGH | `src/store.ts:897-932` — `elevenlabsApiKey` in `partialize` | XSS exposes ElevenLabs key | Move to server-side; never persist in localStorage | VERIFIED |
| R-HIGH-015 | MessageQueue never enqueued — dead retry path | HIGH | `src/lib/messageQueue.ts` — `enqueue()` has zero call sites (grep confirmed) | Send failures are not retried; user must manually retry | Wire enqueue on send failure in useAutoForge/TheForge/App | VERIFIED |
| R-HIGH-016 | Duplicate handleForge implementations diverge | HIGH | `TheForge.tsx:89-166` vs `TuningDeck.tsx:293-374` — TuningDeck auto-sends + pre-records analytics; TheForge does not | Inconsistent behavior; inflated analytics; user confusion | Unify into single forge handler | VERIFIED |

## MEDIUM Risks

| ID | Risk | Severity | Evidence | Impact | Remediation | Verification |
|---|---|---|---|---|---|---|
| R-MED-001 | No CORS/CSP/security headers on server | MEDIUM | `server.ts` — no helmet, no CSP, no CORS config | Cross-origin attacks; no defense in depth | Add helmet, CSP, CORS allowlist | VERIFIED |
| R-MED-002 | express.json limit 50mb enables DoS | MEDIUM | `server.ts:16` — `express.json({ limit: '50mb' })` | Large payloads exhaust memory | Reduce to 1-5mb; add rate limiting | VERIFIED |
| R-MED-003 | Cloudflare Worker CORS is '*' | MEDIUM | `cloudflare-worker/kick-token-proxy.js:15`, `joystick-token-proxy.js:14` | Any website can call proxy with leaked credentials | Set origin allowlist | VERIFIED |
| R-MED-004 | In-memory server sessions not multi-instance safe | MEDIUM | `server.ts` — `twitchSessions = new Map()` | Sessions lost on restart; doesn't scale | Use Redis or persistent session store | VERIFIED |
| R-MED-005 | Twitch implicit flow (no PKCE) in client | MEDIUM | `src/lib/twitch.ts:180-183` — `response_type=token` | Token in URL fragment; less secure than PKCE | Switch to authorization-code + PKCE | VERIFIED |
| R-MED-006 | OAuth state stored in localStorage (XSS-readable) | MEDIUM | `useKickAuth.ts`, `useJoystickAuth.ts` — `localStorage.setItem('kick_oauth_state', ...)` | XSS can steal state; CSRF possible | Use sessionStorage or state cookie | VERIFIED |
| R-MED-007 | Joystick global mutable state for sends | MEDIUM | `src/App.tsx:62-64` — `window.__joystickChatClient` assigned in no-deps effect | Send may fail if global is null during reconnect | Use ref or context; remove global | VERIFIED |
| R-MED-008 | TmiClient ref not set before 100ms timer | MEDIUM | `src/App.tsx:307-327` — ref assigned in timer; cleanup can miss it | Half-connected client leaks on unmount | Set ref immediately; cleanup in all paths | VERIFIED |
| R-MED-009 | Memory read-modify-write races | MEDIUM | `memoryEngine.ts:304-332`, `jokeEngine.ts:47-60` — load-all, mutate-one, write-all | Concurrent boosts overwrite each other | Use IndexedDB transactions; atomic updates | VERIFIED |
| R-MED-010 | Shared mic stream never stopped | MEDIUM | `usePushToTalk.ts:5-21` — `sharedMicStream` module-level, never stopped | Mic indicator stays active; privacy concern | Stop stream on unmount | VERIFIED |
| R-MED-011 | Whisper model load not cancellable | MEDIUM | `src/lib/whisper.ts` — timeout rejects but load continues | 23MB download continues after timeout | Add AbortController; cancel underlying load | VERIFIED |
| R-MED-012 | 2MB main bundle (547KB gzip) | MEDIUM | Build output — `index-B7H2BKmZ.js = 2,023.58 kB` | Slow initial load; poor mobile experience | Code-split; lazy-load AI SDKs | VERIFIED |
| R-MED-013 | 23MB WASM payload in bundle | MEDIUM | Build output — `ort-wasm-simd-threaded.asyncify.wasm = 23,567.05 kB` | Massive download for Whisper; CDN cache pressure | Lazy-load WASM; load on demand only | VERIFIED |
| R-MED-014 | Broad Zustand subscriptions cause re-renders | MEDIUM | `useAutoForge.ts:23-67` — destructures ~50 fields from `useAppStore()` | Performance degradation on state changes | Use selectors; split subscriptions | VERIFIED |
| R-MED-015 | npm audit: multiple high-severity vulnerabilities | MEDIUM | `npm audit` — adm-zip (high), brace-expansion (high), browserslist (high), fast-uri (high), ip-address (high), js-yaml (high), nanoid (high), hono (moderate), body-parser (moderate) | DoS, SSRF, path traversal in transitive deps | `npm audit fix`; review unmaintained tmi.js | VERIFIED |
| R-MED-016 | No tests, no ESLint, no CI | MEDIUM | No `*.test.*` files; `lint` is only `tsc --noEmit`; no `.github/workflows` | Regressions undetected; no quality gates | Add test framework, ESLint, CI pipeline | VERIFIED |
| R-MED-017 | Duplicate prompt constants (client vs server) | MEDIUM | `src/lib/prompts.ts` vs `server.ts:91-263,931-1172` | Drift between client/server prompts | Single source of truth; import from shared | VERIFIED |
| R-MED-018 | Three duplicate Kick proxy implementations | MEDIUM | `cloudflare-worker/kick-token-proxy.js`, `deno/kick-proxy.js`, `deno/kick-proxy.ts` | Maintenance burden; drift; dead TS copy | Consolidate to one implementation | VERIFIED |
| R-MED-019 | Orphan server routes not consumed by client | MEDIUM | `server.ts` — `/api/auth/twitch/url`, `/auth/callback`, `/api/send-message`, `/api/generate-chat`, `/api/refine-suggestion`, `/api/autoforge-decide` | Dead code; confusing architecture; maintenance burden | Wire client to server routes or remove | VERIFIED |
| R-MED-020 | AI error responses leak raw model output | MEDIUM | `server.ts:894-897` — `res.status(500).json({ error: 'Generation failed: ' + ... })` | Internal details exposed to client | Generic error messages; log details server-side | VERIFIED |

## LOW Risks

| ID | Risk | Severity | Evidence | Impact | Remediation | Verification |
|---|---|---|---|---|---|---|
| R-LOW-001 | window.__joystickChatClient global exposure | LOW | `src/App.tsx:62-64` | Internal object accessible to console | Use ref; remove global | VERIFIED |
| R-LOW-002 | Voice command substring match ambiguity | LOW | `src/lib/voiceCommands.ts:61-67` — `normalized.includes(p)` | Shorter command triggers on longer phrase | Use word-boundary matching | VERIFIED |
| R-LOW-003 | No token revocation endpoints | LOW | All auth flows — no revoke implementation | Tokens remain valid until expiry | Add revocation endpoints | INFERRED |
| R-LOW-004 | Provider health in-memory only | LOW | `src/lib/providerFallback.ts:38` — `healthMap = new Map()` | Health resets on reload; cooldown lost | Persist health to sessionStorage | VERIFIED |
| R-LOW-005 | StreamOverlay innerHTML clear | LOW | `src/components/StreamOverlay.tsx:97` — `el.innerHTML = ""` | Clears own element only; not user input | None needed (safe) | VERIFIED |
