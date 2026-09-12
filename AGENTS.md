# AGENTS.md — Contributor Guide

## Build & Verify

```bash
npm install          # install deps
npm run dev          # start dev server (Vite)
npm run build        # production build — must pass before committing
npm run lint         # tsc --noEmit — type-check only, no emit
npm run server       # run Express/OAuth backend (tsx server.ts)
```

**Always run `npm run lint` and `npm run build` before considering work done.** Both must exit 0.

Known non-fatal Vite build warnings (safe to ignore):
- `node:fs` / `node:path` externalized for browser (Anthropic SDK imports)
- Dynamic/static import chunking warnings for store.ts, ai.ts, tts.ts, notifications.ts
- Chunks > 500 kB (large single-page bundle)

## Architecture Overview

### State (`src/store.ts`)
- Zustand `persist` store, key `madchatter-storage`, schema version 19 with `migrate`.
- Legacy single-bot fields are the source of truth when `multiBotEnabled === false`.
- Multi-bot state (`bots[]`, `activeBotId`, `manualSendBotId`) is additive — enabling copies legacy state into `bots[0]`; disabling syncs back.
- `selectMultiBotActive` (exported selector): `multiBotEnabled && ≥2 bots active && authenticated`.
- Bot-scoped action twins (`addBotSentMessage`, `incrementBotStat`, etc.) mirror global actions per-bot.

### AI Pipeline (`src/lib/ai.ts`)
- `generateChat()` — main Forge generation; returns `{ suggestions, analysis, tokenUsage }`.
- `rankVariants()` — scores variants by confidence, length fit, anti-repetition, emote density.
- `autoforgeDecide()` — autonomous decision engine; returns `AutoForgeDecision`.
- `refineSuggestion()` — single-variant refinement.
- `generateVisionContext()` — visual snapshot description.
- `generateAutoForgeBriefing()` — session briefing.
- Provider dispatch: 3 branches (Gemini / OpenAI-compatible / Claude) per function.
- `openAiCompatEndpoint(provider, keys)` in `keys.ts` centralizes OpenRouter + Ollama defaults.
- JSON repair: `repairTruncatedJson()` closes unterminated strings and balances brackets.

### AI Request Scheduler (`src/lib/aiScheduler.ts`)
- Centralized orchestrator: priority, preemption, real cancellation, telemetry, error taxonomy.
- Priority: `critical` (manual Forge) > `interactive` (refine/vision/briefing) > `autonomous` (AutoForge/Smart Replies) > `background` (AutoMemory).
- Ollama: single active slot with priority-based preemption. Cloud providers run concurrently.
- Queued Ollama requests have a wait deadline (`enqueuedAt + timeoutMs`) — a hung active request cannot block the slot forever.
- Real cancellation via `AbortSignal` passed to all SDKs. Timeout = `abortController.abort()`.
- `buildProviderRequestOptions("ollama")` adds `reasoning_effort: "none"` to prevent hidden GPU deliberation.
- `getOperationTokenBudget()` scales output budgets by operation type and card count.
- `getOperationTimeout()` gives each operation+provider pair an appropriate timeout.
- Error taxonomy: `AIRequestTimeoutError`, `AIRequestPreemptedError`, `AIRequestCancelledError`. Use `isSchedulerCancellation()` to avoid poisoning provider health on intentional preemption.
- `getMetricsSummary()` / `getMetricsHistory()` for diagnostics.
- Tests: `npx tsx src/lib/aiScheduler.test.ts` (38 deterministic tests).

### Ollama Health Check (`src/lib/ollamaHealth.ts`)
- `checkOllamaHealth(baseUrl, model)` — lightweight `/v1/models` check with 30s cache.
- States: `configured`, `connecting`, `ready`, `model_unavailable`, `endpoint_unreachable`.
- `invalidateOllamaHealthCache()` — call when endpoint/model changes.

### AutoForge Loops
- Legacy: `useAutoForge()` — 15s interval, self-disables when `selectMultiBotActive` is true.
- Per-bot: `useAutoForgeBot(botId)` — 15s interval per bot, requests speaker floor from `botCoordinator`.
- Orchestrator: `useMultiBotOrchestrator()` — returns JSX with `<BotLoopHost>` that mounts per-bot hooks. Must be rendered in App.tsx.
- Both loops run a `vibeCheck()` pre-filter before the expensive `autoforgeDecide` AI call — skips dead-chat/offline/user-forging cycles without spending tokens. Never skips mentions or spikes.
- Both loops track `consecutiveSilenceRef` and apply `computeAdaptiveBackoff()` to lengthen the check interval during dead periods (resets on any action; mentions/spikes bypass).
- Watchdogs (120s): the in-flight check guard and global `isForging` self-heal if a hung await wedges them. Force bypasses a live `isForging` gate; scheduler cancellations reschedule quietly (+20s) without error toasts.
- NEXT CHECK toggle (`autoForgeAutoCheckEnabled`, schema v19, default true): HUD-local clock button in the header pauses the 15s auto-scheduling tick in both loops. Force ignores it (only the master `autoForgeEnabled` gates force). When paused, the HUD shows "Paused" and Force buttons switch to an amber accent.

### Speaker Coordinator (`src/lib/botCoordinator.ts`)
- Singleton `botCoordinator`. `requestFloor(botId, candidate)` opens a 2.5s bid window; highest `confidence + personaFit * 0.001 + (isMentioned ? 0.15 : 0)` wins. 15s floor gap between speaks. Manual sends bypass the coordinator.
- `BotCandidate.isMentioned` gives mentioned bots a 0.15 bidding bonus so they win the floor over slightly-higher-confidence non-mentioned competitors.

### Send Path (`src/lib/platformSend.ts`)
- `getPlatformSendFn(platform, botId?)` — returns a send function. `botId` omitted = legacy singleton; provided = per-bot identity with independent rate limiter.

### Memory (`src/lib/memoryEngine.ts`, `memoryStore.ts`, `memoryRetrieval.ts`)
- IndexedDB stores: `memories`, `profiles`, `jokes`, `personality`, `extractionLog`.
- `extractMemories()` calls AI to extract structured memories from chat context.
- `retrieveRelevantMemories()` scores by strength, user match, keyword overlap, recency.
- `useAutoMemory()` hook runs extraction every N seconds + decay cycles.

### R34L Mode (`src/lib/prompts.ts`, `src/lib/chatStyle.ts`)
- `R34L_TYPING_PROMPT` — fixed typing texture overlay (lowercase, punctuation, rhythm).
- `analyzeChatStyle()` — analyzes recent chat for casing, emote density, slang, punctuation.
- `formatChatStyleProfile()` — injects observed texture into the prompt as a profile block.
- Cringe tokens (`lol`, `tbh`, `ngl`, `lmao`, etc.) are excluded from the slang lexicon and punctuation signals to prevent re-encouraging trailing closers.

### Provider Keys (`src/lib/keys.ts`)
- `getApiKey(provider)` — returns key or null. Ollama returns a dummy `"ollama-local"`.
- `hasAnyApiKey()` — true if any cloud key exists, or if Ollama is the active provider.
- `getProviderWithKey()` — returns first provider with a key, or Ollama if active.
- `openAiCompatEndpoint(provider, keys)` — centralizes OpenRouter/Ollama base URL + model defaults.

### Fallback (`src/lib/providerFallback.ts`)
- `getHealthyFallbackChain(provider)` — ordered list of available providers.
- Health tracking: 3 failures → 5min cooldown. `recordProviderFailure/Success`.

### First Message Mode (multi-bot)
- Header toggle (`FirstMessageToggle` in `MultiBotPanel.tsx`) — only shown when `multiBotEnabled`. Enabling creates a **cohort** of the currently active+authenticated bots.
- State: `firstMessageModeEnabled` (persisted preference) + `firstMessageCohort` (ephemeral runtime — never persisted). Schema v18.
- Per-bot status: `"armed" | "sending" | "complete"` in `cohort.status`.
- Prompt injection: `FIRST_MESSAGE_DIRECTIVE` (`prompts.ts`) appended to the system prompt when `firstMessageMode` is true in `generateChat` / `autoforgeDecide` (`ai.ts`). Additive only — never alters the bot's persona.
- Generation lock: `acquireFirstMessageLock(botId)` (armed→sending) prevents duplicate concurrent first-message generations; released on any non-send outcome, completed on successful send.
- Completion: hooked in `addBotSentMessage` (the single send-success point) → `completeBotFirstMessage`. Failed sends never consume the state.
- Cohort semantics: fixed at toggle-on; newly activated bots do NOT join; deactivated/removed bots are dropped (can't deadlock completion).
- Celebration: `FirstMessageWatcher` (`src/components/FirstMessageWatcher.tsx`) fires a one-shot dual-corner `fireConfetti("bottom")` when all members complete. Guarded by `cohort.celebrated` + a per-cohort-id ref.
- Stream/channel change → `resetFirstMessageCohort()` (clean state, no leak). Reload → re-arms from current active bots if the preference is on.

## Conventions

- **No new features without explicit request** — prefer polish, bug fixes, and code health.
- **Multi-bot is additive** — never destroy legacy single-bot state. Copy on enable, sync back on disable.
- **Provider dispatch** — use `openAiCompatEndpoint()` for OpenAI-compatible providers. Don't duplicate the baseUrl/model ternary.
- **Smart replies and manual sends** — always record in sent log + stats + event log. Untracked sends break anti-repetition and analytics.
- **R34L** — never add cringe tokens (`lol`, `tbh`, `ngl`, `lmao`, `fr`, `lowkey`, `istg`, `frfr`) to slang lexicon, punctuation signals, or softener examples. The fixed prompt explicitly bans them as trailing closers.
- **Persistence** — new persisted fields require a `SETTINGS_VERSION` bump + migration step in `store.ts`.
- **Build warnings** — `node:fs`/`node:path` externalization and chunk-size warnings are expected; do not attempt to fix them.
- **No test runner** — `npm run lint` (tsc) is the only automated quality gate. Verify manually after changes.

## Key File Map

| File | Responsibility |
|------|---------------|
| `src/store.ts` | Zustand store, persistence, multi-bot state |
| `src/types.ts` | All domain types (55+ exports) |
| `src/App.tsx` | App shell, chat clients, shortcuts, hook mounting |
| `src/lib/ai.ts` | All AI generation + dispatch + JSON repair |
| `src/lib/aiScheduler.ts` | AI request orchestrator (priority, preemption, cancellation, telemetry) |
| `src/lib/aiScheduler.test.ts` | Scheduler test suite (run: `npx tsx src/lib/aiScheduler.test.ts`) |
| `src/lib/ollamaHealth.ts` | Ollama endpoint/model reachability check |
| `src/lib/prompts.ts` | System prompts (Forge, AutoForge, R34L, memory) |
| `src/lib/keys.ts` | Provider keys, `openAiCompatEndpoint()` |
| `src/lib/chatStyle.ts` | Chat style analysis for R34L adaptation |
| `src/lib/botCoordinator.ts` | Multi-bot speaker floor (mention-priority bidding) |
| `src/lib/autoForgeCore.ts` | Shared AutoForge computation (activity, engagement, health, goals, vibe check, adaptive backoff, dedup) |
| `src/lib/antiRepetition.ts` | Repetition analysis + Jaccard semantic dedup (`isNearDuplicate`) |
| `src/lib/platformSend.ts` | Platform send functions (Twitch/Kick/Joystick) |
| `src/lib/providerFallback.ts` | Provider health + failover |
| `src/hooks/useAutoForge.ts` | Legacy AutoForge loop |
| `src/hooks/useAutoForgeBot.ts` | Per-bot AutoForge loop |
| `src/hooks/useMultiBotOrchestrator.tsx` | Mounts per-bot loops |
| `src/components/ForgeLayout.tsx` | Main 3-column layout, Chat Pulse, smart replies |
| `src/components/TheForge.tsx` | Center panel, forge flow, setup checklist |
| `src/components/TuningDeck.tsx` | Right panel, all tuning controls |
| `src/components/MultiBotPanel.tsx` | Multi-bot UI, ChatSender, persona controls |
| `src/components/SettingsPanel.tsx` | Provider picker, API keys, platform config |
| `src/components/WelcomeOverlay.tsx` | Onboarding, patch notes, setup warnings |
| `server.ts` | Express backend, server-side AI generation |
