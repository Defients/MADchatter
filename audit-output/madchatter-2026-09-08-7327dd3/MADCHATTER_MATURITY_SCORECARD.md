# MADchatter Maturity Scorecard

**Commit:** 7327dd3 | **Date:** 2026-09-08 | **Auditor:** GLM-5.2 High

---

## Scoring Methodology

Each dimension scored 0-5:
- 0 = Absent / Not implemented
- 1 = Stubbed / Present but non-functional
- 2 = Partial / Works in narrow cases, major gaps
- 3 = Functional / Works for primary use case, edge cases fail
- 4 = Solid / Works well, minor gaps
- 5 = Production-grade / Hardened, tested, documented

Weighted by criticality to a shipped product.

---

## Dimension Scores

| Dimension | Score | Weight | Weighted | Evidence | Notes |
|---|---|---|---|---|---|
| **Security** | 0.5 | 25% | 0.13 | R-CRIT-001/002/003, R-HIGH-001..014 | Hardcoded secrets in bundle; plaintext localStorage keys; XSS; loose origin checks; no CORS/CSP; SSRF; unsigned sessions |
| **Auth** | 1.5 | 15% | 0.23 | MC-AUTH-001..006 | OAuth flows exist but inconsistent (implicit vs code); no PKCE on Twitch/Joystick; tokens in localStorage; no revocation; anonymous session creation |
| **AI/Forge** | 2.0 | 15% | 0.30 | MC-AI-001..017 | Generation works but no output validation; prompt injection risk; duplicate client/server; no moderation before autonomous send |
| **AutoForge** | 2.5 | 10% | 0.25 | MC-AI-005, useAutoForge | Loop runs; rate limiting + dedup + confidence + dry-run present; but bookkeeping-before-send inflates stats; dry-run can still trigger send |
| **Chat Platforms** | 2.5 | 10% | 0.25 | MC-CHAT-001..014 | All three platforms integrated; read+send functional; rate limiting + dedup; but message queue unused; Joystick global state; Twitch no refresh |
| **Memory** | 2.0 | 5% | 0.10 | MC-MEM-001..004 | IndexedDB + extraction + retrieval + decay functional; but read-modify-write races; double reload; timer reset on mount |
| **Audio/Voice** | 2.0 | 5% | 0.10 | MC-AUDIO-001..009 | Deepgram + Whisper + PTT + voice commands + TTS; but mic stream leak; Whisper load not cancellable; substring match ambiguity |
| **Build/CI** | 2.0 | 5% | 0.10 | MC-INFRA-006/008 | Build succeeds; typecheck passes; but no tests, no ESLint, no CI, 2MB bundle, 23MB WASM |
| **Observability** | 1.0 | 5% | 0.05 | All | console.* only; no structured logging, metrics, Sentry, or telemetry; in-memory health tracking |
| **Documentation** | 1.5 | 5% | 0.08 | README, .env.example | README describes features; .env.example exists; no API docs, no architecture docs, no contribution guide |

---

## Overall Score

| Category | Weighted Score |
|---|---|
| Security | 0.13 |
| Auth | 0.23 |
| AI/Forge | 0.30 |
| AutoForge | 0.25 |
| Chat Platforms | 0.25 |
| Memory | 0.10 |
| Audio/Voice | 0.10 |
| Build/CI | 0.10 |
| Observability | 0.05 |
| Documentation | 0.08 |
| **Total** | **1.59 / 5.0** |

## Grade

| Range | Grade | Label |
|---|---|---|
| 4.5-5.0 | A | Production-ready |
| 3.5-4.4 | B | Near-ready |
| 2.5-3.4 | C | Functional prototype |
| 1.5-2.4 | D | Early prototype |
| 0-1.4 | F | Pre-alpha |

**Overall Grade: D (1.59/5.0) — Early prototype**

The product has a broad feature surface and functional core loops, but is blocked from shipping by critical security issues (hardcoded secrets, plaintext keys, XSS), no test/CI infrastructure, and significant runtime correctness gaps (bookkeeping-before-send, unused message queue, no output validation).

---

## Completion Reproduction

To reproduce this score:

1. Checkout commit `7327dd3`
2. Run `npm ci` (lockfile present)
3. Run `npm run lint` (tsc --noEmit) → passes (exit 0)
4. Run `npm run build` (vite build) → passes, 2MB main bundle
5. Run `npm audit --audit-level=moderate` → multiple high-severity findings
6. Verify hardcoded secrets: `grep -r "DEFAULT_KICK_CLIENT_SECRET\|DEFAULT_JOYSTICK_CLIENT_SECRET" src/`
7. Verify no tests: search for `*.test.*` and `*.spec.*` files
8. Verify message queue unused: `grep -r "messageQueue.enqueue\|\.enqueue(" src/`
9. Cross-reference risk register and component index
