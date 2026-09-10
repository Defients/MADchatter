# MADchatter Autonomy Target & Change-Set Plan

**Commit:** 7327dd3 | **Date:** 2026-09-08 | **Auditor:** GLM-5.2 High

---

## Autonomy Target Selection

### Selection Criteria

The autonomy target is the single highest-value workstream that:
1. Unblocks the most critical risks
2. Preserves the most existing architecture
3. Enables the broadest set of downstream work
4. Has the clearest evidence base

### Selected Target

**"Eliminate hardcoded secrets and move all credential/token handling server-side"**

This target addresses 3 CRITICAL risks (R-CRIT-001/002/003) and 6 HIGH risks (R-HIGH-001/002/005/006/007/008/012/013/014) — the largest cluster of critical/high risks in the register. It is the prerequisite for any safe deployment, any public demo, and any external contributor access.

Without this work, every visitor to the deployed site can extract OAuth client secrets from the bundle, every XSS vector exposes all API keys, and every localStorage entry is a credential leak.

---

## Change Sets

### CS-1: Remove hardcoded Kick client secret from client bundle

**Files:** `src/lib/kick.ts:26-27`, `src/hooks/useKickAuth.ts:89-90`

**Change:**
- Remove `DEFAULT_KICK_CLIENT_SECRET` constant and its fallback
- Remove `VITE_KICK_CLIENT_SECRET` usage
- All Kick token exchange/refresh must go through server.ts `/api/kick/token` or Cloudflare proxy exclusively
- Client never sends `client_secret` in any request body

**Proof criteria:**
- `grep -r "client_secret\|CLIENT_SECRET" src/` returns no hardcoded values
- Build output (`dist/assets/*.js`) contains no Kick client secret string
- Kick OAuth flow still works end-to-end via server proxy

**Dependencies:** None
**Risk addressed:** R-CRIT-001

---

### CS-2: Remove hardcoded Joystick client secret from client bundle

**Files:** `src/lib/joystick.ts:40-41`, `src/hooks/useJoystickAuth.ts`, `cloudflare-worker/joystick-token-proxy.js:167-168`

**Change:**
- Remove `DEFAULT_JOYSTICK_CLIENT_SECRET` constant and its fallback
- Remove `VITE_JOYSTICK_CLIENT_SECRET` usage
- Remove hardcoded fallback in `joystick-token-proxy.js:167-168`
- All Joystick token exchange/refresh must go through proxy with secret from Worker env binding
- Client never sends `client_secret` in any request body

**Proof criteria:**
- `grep -r "client_secret\|CLIENT_SECRET\|hT4eRDiAs5" src/ cloudflare-worker/` returns no hardcoded values
- Build output contains no Joystick client secret string
- Joystick OAuth flow still works end-to-end via proxy

**Dependencies:** None
**Risk addressed:** R-CRIT-002, R-CRIT-003

---

### CS-3: Move AI provider API keys to server-side session

**Files:** `src/lib/keys.ts`, `src/lib/ai.ts`, `server.ts`, `src/components/SettingsPanel.tsx`

**Change:**
- Remove `localStorage.setItem("autoforge_api_keys", ...)` from `keys.ts`
- Remove `dangerouslyAllowBrowser: true` from all OpenAI/Anthropic constructors in `ai.ts`
- All AI calls (`generateChat`, `autoforgeDecide`, `refineSuggestion`, `visionRequest`, `extractMemories`) route through server.ts API endpoints
- Server resolves keys from signed session, never from request body
- SettingsPanel saves keys to server via authenticated `/api/set-keys`
- `getApiKey()` client-side returns boolean (has key) not the key itself

**Proof criteria:**
- `grep -r "dangerouslyAllowBrowser" src/` returns no results
- `grep -r "localStorage.*api_keys\|autoforge_api_keys" src/` returns no key-value storage
- Browser DevTools → Application → localStorage shows no API key values
- AI generation still works end-to-end through server proxy
- Network tab shows AI calls go to same-origin `/api/*` not third-party

**Dependencies:** CS-6 (signed sessions)
**Risk addressed:** R-HIGH-001, R-HIGH-002, R-HIGH-008

---

### CS-4: Move platform OAuth tokens to server-side session

**Files:** `src/lib/twitch.ts`, `src/lib/kick.ts`, `src/lib/joystick.ts`, `server.ts`

**Change:**
- Remove `localStorage.setItem(SESSION_KEY, ...)` for Twitch/Kick/Joystick sessions
- OAuth callback pages post token to server `/api/auth/*/callback` instead of `window.opener.postMessage`
- Server stores tokens in signed session (Redis or encrypted cookie)
- Client retrieves session status via `/api/me` (boolean: authenticated + username)
- Token refresh happens server-side; client never sees refresh tokens
- `getTwitchSession()`/`getKickSession()`/`getJoystickSession()` return `{ username, expiresAt }` only (no tokens)

**Proof criteria:**
- `grep -r "localStorage.*session\|twitch_session\|kick_session\|joystick_session" src/` returns no token storage
- Browser localStorage contains no access/refresh tokens
- Platform auth flows work end-to-end
- Token refresh happens automatically without client involvement

**Dependencies:** CS-6 (signed sessions)
**Risk addressed:** R-HIGH-005, R-HIGH-012, R-HIGH-013

---

### CS-5: Fix XSS in index.html and tighten postMessage origins

**Files:** `index.html:83`, `public/kick-auth-callback.html:60`, `public/joystick-auth-callback.html:57`, `src/hooks/useTwitchAuth.ts:42`, `src/hooks/useKickAuth.ts:50`, `src/hooks/useJoystickAuth.ts:69`

**Change:**
- Replace `document.body.innerHTML = '...' + params.get('error_description')` with `textContent`
- Replace `postMessage(payload, '*')` with `postMessage(payload, window.opener.location.origin)`
- Replace substring origin checks (`origin.includes('localhost')`) with exact match against allowlist
- Allowlist: `window.location.origin` only (or explicit configured origins)

**Proof criteria:**
- `grep -r "innerHTML.*error_description\|innerHTML.*params" index.html` returns no results
- `grep -r "postMessage.*'\*'" src/ public/` returns no results
- `grep -r "origin.includes" src/hooks/` returns no results
- Manual test: crafted error URL renders as text, not HTML
- Manual test: postMessage from wrong origin is rejected

**Dependencies:** None
**Risk addressed:** R-HIGH-003, R-HIGH-004, R-HIGH-005

---

### CS-6: Sign server session IDs with HMAC

**Files:** `server.ts:38-50, 540-564`

**Change:**
- Generate session IDs as `HMAC-SHA256(secret, randomUUID())`
- Verify session ID signature on every `getSessionId()` call
- Remove anonymous session creation in `/api/set-keys` — require authentication first
- Add `express-rate-limit` to all `/api/*` routes
- Add `helmet` for security headers
- Add CORS allowlist (same origin only, or configured origins)

**Proof criteria:**
- `grep -r "anonymous" server.ts` returns no session creation
- Forged session ID (random string) returns 401
- Rate limiting triggers on repeated requests
- Security headers present in response (`curl -I localhost:3000`)

**Dependencies:** None
**Risk addressed:** R-HIGH-006, R-HIGH-007, R-MED-001, R-MED-002

---

### CS-7: Validate AI output schema before autonomous action

**Files:** `src/lib/ai.ts`, `src/hooks/useAutoForge.ts`, `src/types.ts`

**Change:**
- Define Zod (or equivalent) schemas for `AutoForgeDecision`, `ForgeSuggestion`, `MemoryExtractionResult`
- After `JSON.parse`, validate against schema
- On validation failure, return controlled fallback (silence) not undefined
- Add moderation layer: before `sendFn(channel, action_payload)`, check against blocklist/length/platform rules
- Validate `decision.confidence` is a number before threshold comparison

**Proof criteria:**
- `grep -r "JSON.parse" src/lib/ai.ts` is followed by schema validation
- Malformed AI response (missing fields) results in `deliberate_silence`, not crash
- `decision.confidence` type-checked before comparison
- Blocklist filter prevents banned content from reaching chat

**Dependencies:** None
**Risk addressed:** R-HIGH-009, R-HIGH-011

---

### CS-8: Fix AutoForge bookkeeping-before-send

**Files:** `src/hooks/useAutoForge.ts:449-552`

**Change:**
- `await sendFn(channel, message)` before calling `addSentMsgRef`, `incrSentRef`, `addActionHistoryEntry`
- On send success: record with `success: true`
- On send failure: record with `success: false`; do not increment `messagesSent`
- Clear `followupTimerRef` on unmount (already done, but verify)
- Fix dry-run `full_forge`: do not dispatch `forge-trigger` with `autoSend: true` in dry-run mode

**Proof criteria:**
- `grep -n "addSentMsgRef\|incrSentRef\|addActionHistoryEntry" src/hooks/useAutoForge.ts` appears after `await sendFn`
- Failed send → `messagesSent` not incremented, `actionHistory` shows `success: false`
- Dry-run `full_forge` logs only, does not dispatch `forge-trigger`

**Dependencies:** None
**Risk addressed:** R-HIGH-010

---

### CS-9: Wire MessageQueue for send failure retry

**Files:** `src/hooks/useAutoForge.ts`, `src/components/TheForge.tsx`, `src/App.tsx`, `src/lib/messageQueue.ts`

**Change:**
- On `sendFn` failure in AutoForge (short_reaction, quick_followup), call `messageQueue.enqueue(message, channel, platform, error)`
- On manual send failure in TheForge/App, offer "retry" via `messageQueue.enqueue`
- `startQueueProcessor` already called in App.tsx — verify it runs
- Add UI indicator for queue depth (StatusBar)

**Proof criteria:**
- `grep -r "messageQueue.enqueue\|\.enqueue(" src/` returns call sites in useAutoForge, TheForge, App
- Simulated send failure → message appears in queue → retried after backoff
- Queue depth visible in StatusBar

**Dependencies:** CS-8
**Risk addressed:** R-HIGH-015

---

### CS-10: Unify duplicate handleForge implementations

**Files:** `src/components/TheForge.tsx:89-166`, `src/components/TuningDeck.tsx:293-374`

**Change:**
- Extract single `handleForge(options: { autoSend?: boolean })` into a shared hook or utility
- Both TheForge and TuningDeck call the same function
- Analytics recorded after send resolves, not before
- Remove `setTimeout` auto-send in TuningDeck; use `await` + explicit send
- Clear any pending timers on unmount

**Proof criteria:**
- `grep -n "handleForge" src/components/TheForge.tsx src/components/TuningDeck.tsx` shows both call shared function
- No `setTimeout` for auto-send in TuningDeck
- Analytics accurate: `messagesSent` matches actual sends

**Dependencies:** CS-8
**Risk addressed:** R-HIGH-016

---

## Execution Order

```
CS-5 (XSS/postMessage)     ──┐
CS-6 (signed sessions)     ──┤
                              ├── CS-3 (AI keys server-side) ──┐
                              ├── CS-4 (OAuth tokens server)  ──┤
CS-1 (Kick secret removal) ──┤                                  ├── CS-9 (wire MessageQueue)
CS-2 (Joystick secret)    ──┘                                  │
                                                                ├── CS-10 (unify handleForge)
CS-7 (AI schema validation) ────────────────────────────────── ─┤
CS-8 (bookkeeping fix)     ─────────────────────────────────── ─┘
```

**Phase 1 (parallel, no deps):** CS-1, CS-2, CS-5, CS-6, CS-7, CS-8
**Phase 2 (after CS-6):** CS-3, CS-4
**Phase 3 (after CS-8):** CS-9, CS-10

---

## Expected Outcome

After all 10 change sets:
- 3 CRITICAL risks eliminated (R-CRIT-001/002/003)
- 12 HIGH risks eliminated (R-HIGH-001..005, 007..014, 015, 016)
- 4 MEDIUM risks reduced (R-MED-001/002/003/006)
- Maturity score: D (1.59) → C+ (~2.8) estimated
- Product safe for private beta deployment with authenticated users
