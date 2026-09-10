# MADchatter Forensic Audit — Audit Control Sheet

**Repository:** `https://github.com/Defients/MADchatter`  
**Workspace:** `H:\myProjects\MADchatter`  
**Commit:** `7327dd3f9f9485537c1925add2950a3a3d843e4e`  
**Branch:** `master` (up to date with `origin/master`)  
**HEAD date:** `2026-09-08 12:44:18 -0400`  
**Total commits:** 1 (`Initial commit`)  
**Tracked files:** 121  
**Audit mode:** `AUDIT_ONLY` (read-only; no source modified)  
**Auditor:** GLM-5.2 High (Devin)  
**Audit date:** 2026-09-08  

---

## Audit Scope

Determine:
1. What actually exists
2. What is genuinely wired, reachable, executable, and working
3. What prevents the product from being safe, coherent, maintainable, reliable, and shippable
4. What exact sequence of work extracts the greatest value from what already exists

---

## Evidence Sources

| ID | Source | Description |
|---|---|---|
| E-A1 | Lane A (Cartographer subagent) | Full file inventory, classification, architecture map, dependency graph, duplication analysis |
| E-A2 | Direct read: App.tsx, main.tsx, store.ts | Top-level orchestration, state, persistence |
| E-A3 | Direct read: store.ts, ErrorBoundary | State management, error handling |
| E-A4 | Direct read: components/ui/*, components.json | shadcn primitives, styling config |
| E-A5 | Direct read: lib/*.ts (all) | All runtime utilities, platform adapters, domain logic |
| E-A6 | Command gates: `npm run lint`, `npm run build` | Typecheck (PASS), build (PASS with warnings) |
| E-B1 | Lane B (Runtime subagent) + direct read: TheForge, TuningDeck | Workflow traces, race conditions, silent failures |
| E-B2 | Direct read: VariantCard, TheForge | Refine/send behavior |
| E-B3 | Direct read: memoryStore, memoryEngine, memoryRetrieval, useAutoMemory | Memory system traces |
| E-B4 | Direct read: AutoForgeHUD, AutoForgeReport, AnalyticsPanel | Telemetry/analytics behavior |
| E-B5 | Direct read: ForgeLayout, frameDiff | Screen capture, vision pipeline |
| E-B6 | Direct read: useAutoForge (full 671 lines) | AutoForge loop, bookkeeping, send paths |
| E-B7 | Direct read: twitch.ts, App.tsx chat section | Twitch chat read/send, ingestion |
| E-B8 | Direct read: kick.ts (full 738 lines) | Kick auth, chat, send, refresh |
| E-B9 | Direct read: joystick.ts (full 572 lines) | Joystick auth, chat, send, refresh |
| E-B10 | Direct read: messageQueue.ts | Queue implementation + grep for enqueue call sites |
| E-B11 | Lane B: audio/voice section | Deepgram, Whisper, PTT, voice commands, TTS |
| E-C1 | Lane C: security findings | Emote system, XSS surfaces |
| E-C2 | Lane C: security findings | Settings panel, key storage |
| E-C3 | Direct read: server.ts (full 1338 lines) | All server routes, session management, AI proxy |
| E-C4 | Lane C: prompt duplication | Prompt constants in client vs server |
| E-C5 | Lane C: OAuth assessment | Twitch/Kick/Joystick auth flows, callback pages |
| E-C6 | Direct read: cloudflare-worker/kick-token-proxy.js | Kick proxy CORS, hardcoded values |
| E-C7 | Direct read: cloudflare-worker/joystick-token-proxy.js | Joystick proxy CORS, hardcoded secrets |
| E-C8 | Direct read: keys.ts | API key storage mechanism |
| E-C9 | `npm audit --audit-level=moderate` | Dependency vulnerabilities |
| E-C10 | Build output inspection | Bundle sizes, chunk warnings |

---

## Command Gates

| Gate | Command | Result | Evidence |
|---|---|---|---|
| Typecheck | `npm run lint` (`tsc --noEmit`) | **PASS** (exit 0) | E-A6 |
| Build | `npm run build` (`vite build`) | **PASS** (exit 0, with warnings) | E-A6, E-C10 |
| Tests | N/A | **NOT_RUN** — no test script in package.json, no test files found | E-A5 |
| ESLint | N/A | **NOT_RUN** — no ESLint config, lint script is only tsc | E-A5 |
| CI | N/A | **NOT_RUN** — no `.github/workflows` directory | E-A5 |
| npm audit | `npm audit --audit-level=moderate` | **FAIL** — multiple high-severity vulnerabilities | E-C9 |

### Build Warnings (Preserved)

1. `node:fs` externalized for browser (Anthropic SDK imports `node:fs` in browser context)
2. `store.ts` dynamically imported by `keys.ts` but statically imported by 26+ files — dynamic import won't move to separate chunk
3. `tts.ts` dynamically imported by `useVoiceCommands` but statically imported by 5 files — same
4. `notifications.ts` dynamically imported by `TuningDeck` but statically imported by 2 files — same
5. Chunk size > 500KB: `index-B7H2BKmZ.js` = 2,023.58 kB (547.11 kB gzip)
6. `ort-wasm-simd-threaded.asyncify.wasm` = 23,567.05 kB (5,757.04 kB gzip)

### npm Audit Summary (High Severity)

| Package | Severity | Issue |
|---|---|---|
| adm-zip | HIGH | 4GB memory allocation via crafted ZIP |
| brace-expansion | HIGH | DoS via exponential expansion |
| browserslist | HIGH | Unbounded memory growth; prototype write |
| fast-uri | HIGH | Host confusion; SSRF via multiple vectors |
| ip-address | HIGH | SSRF; trust-boundary bypass |
| js-yaml | HIGH | Quadratic CPU in !!omap resolution |
| nanoid | HIGH | Non-secure generator infinite loop |
| @hono/node-server | MODERATE | Path traversal on Windows |
| body-parser | MODERATE | DoS via invalid limit value |
| hono | MODERATE | ReDoS in CORS; cross-user disclosure |

---

## Browser QA

| Check | Result | Evidence |
|---|---|---|
| Dev server starts | **PASS** — Vite on port 5174 | Direct exec |
| Initial page load | **NOT_RUN** — browser preview launched but no captures returned by user | E-A2 |
| Onboarding/welcome | **NOT_RUN** | - |
| Settings panel | **NOT_RUN** | - |
| Command palette | **NOT_RUN** | - |
| AutoForge controls | **NOT_RUN** | - |
| Analytics | **NOT_RUN** | - |
| Memory panel | **NOT_RUN** | - |
| Auth flows | **NOT_RUN** — would require real credentials (audit-only restriction) | - |
| Console errors | **NOT_RUN** | - |

**Note:** Browser preview was launched at `http://localhost:5174` but no DOM captures or console output were returned by the user. All browser QA checks are marked NOT_RUN. The dev server started successfully, confirming the Vite dev path is functional.

---

## Exit Reconciliation Table

| # | Exit Criterion | Status | Evidence IDs | Notes |
|---|---|---|---|---|
| 1 | Repository inventory reconciled | **PASS** | E-A1 | 121 tracked files; full inventory in Component Index; all classified by category/layer |
| 2 | Components indexed | **PASS** | E-A1, E-A5 | 86 components indexed across 7 categories; each has ID, status, completion %, dependencies |
| 3 | Components scored | **PASS** | E-A1, E-A5, E-B1..B11 | Progress Matrix CSV with 86 rows; each scored for completion, confidence, reachability, verification state |
| 4 | Workflows traced | **PASS** | E-B1..B11 | 12 workflow traces from trigger through persistence/side-effects/failure/recovery in Workflow Matrix |
| 5 | Critical risks verified | **PASS** | E-C5..C8, E-C10 | 3 CRITICAL risks with exact file:line evidence in Risk Register |
| 6 | High risks verified | **PASS** | E-B6, E-C3, E-C5..C8 | 16 HIGH risks with exact file:line evidence in Risk Register |
| 7 | Build/test gates | **PARTIAL** | E-A6, E-C9 | Typecheck PASS; Build PASS (with warnings); Tests NOT_RUN (none exist); npm audit FAIL |
| 8 | Browser QA | **NOT_RUN** | - | Dev server started; no captures returned; all UI checks NOT_RUN |
| 9 | Artifacts generated | **PASS** | This sheet + 6 artifacts | Control Sheet, Component Index, Progress Matrix, Workflow Matrix, Risk Register, Scorecard, Autonomy Target |
| 10 | Git custody verified | **PASS** | Direct git inspection | Single commit; clean tree at baseline; no tracked source modified during audit |

---

## Artifact Inventory

| Artifact | Path | Description |
|---|---|---|
| Audit Control Sheet | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_AUDIT_CONTROL_SHEET.md` | This file — exit reconciliation, evidence index, gate results |
| Component Index | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_COMPONENT_INDEX.md` | 86 components indexed by category, layer, status, completion |
| Progress Matrix | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_PROGRESS_MATRIX.csv` | CSV with per-component scoring, dependencies, blockers, verification state |
| Workflow Matrix | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_WORKFLOW_MATRIX.md` | 12 workflow traces with step-by-step behavior, gaps, verification |
| Risk Register | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_RISK_REGISTER.md` | 3 CRITICAL, 16 HIGH, 20 MEDIUM, 5 LOW risks with evidence, impact, remediation |
| Maturity Scorecard | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_MATURITY_SCORECARD.md` | 10-dimension weighted scoring; overall grade D (1.59/5.0) |
| Autonomy Target | `audit-output/madchatter-2026-09-08-7327dd3/MADCHATTER_AUTONOMY_TARGET.md` | Selected target: credential/secret hardening; 10 atomic change sets with proof criteria |

---

## Top-Level Findings

### What Actually Exists

A broad-featured React 19 + Vite 6 SPA (121 tracked files, ~27K lines) with:
- 3 chat platform integrations (Twitch/tmi.js, Kick/Pusher+REST, Joystick/ActionCable)
- Client-side AI generation via Gemini/OpenAI/Anthropic/OpenRouter with provider fallback
- AutoForge autonomous decision loop (15s interval, rate-limited, confidence-gated, dry-run capable)
- Memory system (IndexedDB, AI extraction, relevance retrieval, decay/pruning)
- Audio transcription (Deepgram WebSocket + local Whisper fallback)
- Screen capture + vision context (frame-diff gated)
- Push-to-talk + voice commands
- TTS (Web Speech + ElevenLabs)
- Analytics dashboard, settings export/import, command palette, tutorial
- Express server with OAuth, AI proxy routes, static hosting
- Cloudflare Worker + Deno proxy artifacts for CORS bypass

### What Works

- Typecheck passes (tsc --noEmit, exit 0)
- Build succeeds (vite build, exit 0)
- Dev server starts (Vite, port 5174)
- Core architectural wiring is intact: App → ForgeLayout → TheForge/TuningDeck → ai.ts → providers
- AutoForge loop is structurally complete: trigger → guard → context → decision → gates → action → schedule
- All 3 platform adapters have read + send paths
- Memory system has extraction → storage → retrieval → injection → decay lifecycle
- Store persistence with versioned migrations (v1→v7)

### What Blocks Shipping

1. **CRITICAL: Hardcoded OAuth client secrets in browser bundle** (Kick + Joystick) — anyone can extract and impersonate the app
2. **HIGH: All API keys/tokens in plaintext localStorage** — any XSS exposes everything
3. **HIGH: `dangerouslyAllowBrowser: true`** — AI keys sent from browser to third parties
4. **HIGH: Reflected XSS in index.html** — `error_description` injected into innerHTML
5. **HIGH: No AI output validation** — model output sent to chat without schema check or moderation
6. **HIGH: Bookkeeping before side effects** — AutoForge records success before send resolves
7. **HIGH: MessageQueue never used** — dead retry path; send failures not retried
8. **MEDIUM: No tests, no ESLint, no CI** — no quality gates
9. **MEDIUM: 2MB bundle + 23MB WASM** — severe performance impact
10. **MEDIUM: npm audit** — multiple high-severity dependency vulnerabilities

### Greatest-Value Work Sequence

**Target:** Eliminate hardcoded secrets and move all credential/token handling server-side  
**Change sets:** 10 atomic changes (CS-1 through CS-10) in 3 phases  
**Expected outcome:** 3 CRITICAL + 12 HIGH risks eliminated; maturity D → C+; safe for private beta

---

## FACT vs INFERENCE Separation

All findings in the Risk Register and Workflow Matrix are marked as VERIFIED (evidence-cited with file:line) or INFERRED (code-structure-based). No finding is based solely on:
- Filenames
- Comments
- Feature names
- README claims
- Architectural inference
- A successful build alone

Every risk has a direct file:line citation. Every workflow step has a direct file:line citation.

---

## Unknown and Blocked Checks

| Check | Status | Reason |
|---|---|---|
| Browser QA (all UI checks) | NOT_RUN | Dev server started; no DOM captures returned by user |
| Auth flow testing | BLOCKED | Would require real OAuth credentials (audit-only restriction) |
| Production runtime evidence | BLOCKED | No production deployment access |
| Test execution | NOT_RUN | No test files exist in repository |
| ESLint execution | NOT_RUN | No ESLint configuration exists |
| CI pipeline | NOT_RUN | No CI configuration exists |
| Bundle secret extraction (manual) | NOT_RUN | Build inspected for sizes/warnings; full string search of dist/ not performed |

---

## Git Custody Verification

| Check | Result |
|---|---|
| Branch | `master` |
| HEAD | `7327dd3f9f9485537c1925add2950a3a3d843e4e` |
| Origin | `https://github.com/Defients/MADchatter.git` |
| Working tree at baseline | Clean |
| Tracked source modified during audit | No |
| Audit artifacts created | Yes (in `audit-output/`, gitignored or untracked) |
| Commits made | No |
| Pushes made | No |

---

## Reproducibility

To reproduce this audit:

```bash
git clone https://github.com/Defients/MADchatter.git
cd MADchatter
git checkout 7327dd3
npm ci
npm run lint          # typecheck — PASS
npm run build         # build — PASS with warnings
npm audit             # multiple high-severity findings
# Read audit-output/madchatter-2026-09-08-7327dd3/*.md for full report
```

---

## Final Grade

**D (1.59 / 5.0) — Early prototype**

The product has a broad feature surface and functional core loops, but is blocked from shipping by critical security issues (hardcoded secrets, plaintext keys, XSS), no test/CI infrastructure, and significant runtime correctness gaps (bookkeeping-before-send, unused message queue, no output validation). The 10-change-set autonomy target provides a dependency-ordered path from D → C+.
