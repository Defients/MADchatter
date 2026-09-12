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
- Zustand `persist` store, key `madchatter-storage`, schema version 20 with `migrate`.
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
- Priority: `critical` (manual Forge) > `interactive` (refine/briefing) > `autonomous` (AutoForge/Smart Replies/vision-on-Ollama) > `background` (AutoMemory). Vision is `interactive` on cloud providers (concurrent — preempts nothing) but `autonomous` on Ollama (single slot — competes fairly instead of starving AutoForge).
- Ollama: single active slot with priority-based preemption. Cloud providers run concurrently.
- Queued Ollama requests have a wait deadline (`enqueuedAt + (queueTimeoutMs ?? timeoutMs)`) — a hung active request cannot block the slot forever. `queueTimeoutMs` lets background ops wait out contention longer than their execution timeout.
- Priority aging: a queued request is promoted one rank per 30s of wait when picking the next free slot (ties → oldest first). Prevents background ops (AutoMemory) from starving behind a steady stream of autonomous/interactive requests. Aging never preempts in-flight work.
- AutoForge-off priority boost: when `autoForgeEnabled` is false, AutoMemory extraction runs at `autonomous` instead of `background` (no autonomous competition = take the free slot immediately). When AutoForge is on, it stays at `background` so realtime-first decisions keep priority.
- Real cancellation via `AbortSignal` passed to all SDKs. Timeout = `abortController.abort()`.
- `buildProviderRequestOptions("ollama")` adds `reasoning_effort: "none"` to prevent hidden GPU deliberation.
- `getOperationTokenBudget()` scales output budgets by operation type and card count.
- `getOperationTimeout()` gives each operation+provider pair an appropriate timeout.
- Error taxonomy: `AIRequestTimeoutError` (with `queued` flag for queue-wait timeouts), `AIRequestPreemptedError`, `AIRequestCancelledError`. Use `isSchedulerCancellation()` for preemption/cancellation and `isQueueTimeout()` for queue-wait timeouts — both avoid poisoning provider health on intentional/capacity issues. `SyntaxError` from `JSON.parse` (malformed model output) is also rethrown without `recordProviderFailure` — it's a model quality issue, not a provider health issue, so a smaller model producing occasional bad JSON no longer triggers the 3-failure → 5min cooldown cascade.
- `getMetricsSummary()` / `getMetricsHistory()` for diagnostics.
- Tests: `npx tsx src/lib/aiScheduler.test.ts` (41 deterministic tests).

### Ollama Health Check (`src/lib/ollamaHealth.ts`)
- `checkOllamaHealth(baseUrl, model)` — lightweight `/v1/models` check with 30s cache.
- States: `configured`, `connecting`, `ready`, `model_unavailable`, `endpoint_unreachable`.
- `invalidateOllamaHealthCache()` — call when endpoint/model changes.

### AutoForge Loops
- Legacy: `useAutoForge()` — 15s interval, self-disables when `selectMultiBotActive` is true.
- Per-bot: `useAutoForgeBot(botId)` — 15s interval per bot, requests speaker floor from `botCoordinator`. Intervals are staggered by bot index across the 15s window so they don't all fire at once and flood the single Ollama slot.
- Orchestrator: `useMultiBotOrchestrator()` — returns JSX with `<BotLoopHost>` that mounts per-bot hooks. Must be rendered in App.tsx.
- Both loops run a `vibeCheck()` pre-filter before the expensive `autoforgeDecide` AI call — skips dead-chat/offline/user-forging cycles without spending tokens. Never skips mentions or spikes.
- When AutoForge is OFF but smart replies are enabled, both loops fall back to a lightweight mention-only check on the same 15s interval — detects mentions and generates smart reply suggestions without the AutoForge decision loop, so the user still gets reply suggestions while AutoForge is disabled.
- Both loops track `consecutiveSilenceRef` and apply `computeAdaptiveBackoff()` to lengthen the check interval during dead periods (resets on any action; mentions/spikes bypass).
- Watchdogs (120s): the in-flight check guard and global `isForging` self-heal if a hung await wedges them. Force bypasses a live `isForging` gate; scheduler cancellations and queue timeouts reschedule quietly (+20s) without error toasts.
- Queue timeouts (`isQueueTimeout()`) are capacity issues (too many bots queued for the single Ollama slot), NOT provider failures — they don't poison provider health or trigger cooldown.
- NEXT CHECK toggle (`autoForgeAutoCheckEnabled`, schema v19, default true): HUD-local clock button in the header pauses the 15s auto-scheduling tick in both loops. Force ignores it (only the master `autoForgeEnabled` gates force). When paused, the HUD shows "Paused" and Force buttons switch to an amber accent.
- NEXT CHECK display has three visual states: **Processing** (cyan, animated brain + sweeping bar — an AI check is in-flight, derived from `isAutoForgeThinking` / per-bot `runtime.isAutoForgeThinking`), **Waiting** (dimmed gray pulse — timer hit 0 but the 15s interval hasn't fired yet), and the normal color-coded countdown. The header Brain icon also turns cyan with a processing pulse when a check is active.
- **Multi-bot parity (v1.0.4):** Per-bot rate limiters (`getBotRateLimiter(botId)` in `actionRateLimiter.ts`) — each bot gets its own `ActionRateLimiter` so quotas are independent. The legacy loop uses the shared `actionRateLimiter` singleton. Rule Engine `force_autoforge_check` dispatches a targeted event (`detail: { botId }`) in multi-bot mode so only the firing bot checks. AutoForge Sequences overlay includes a bot identity selector in multi-bot mode; sends use the selected bot's identity and `full_forge` steps target the selected bot. The per-bot direct-send branch matches the legacy loop's decision set (includes `meta_observation` — a light meta comment is a valid send, not a silence). Forced checks bypass the per-bot sent-history dedup guards (the `SendGuard` dedup at the Twitch layer still catches exact duplicates within 60s).
- **Supercharge Mode (Easter egg, v1.0.4):** Runtime-only flag (`superchargeActive`, not persisted) toggled by `Ctrl+Shift+S` (or `Cmd+Shift+S` on Mac). The typed-word trigger was removed because "supercharge" contains letters (s, p, c, h, a, r) that collide with single-key hotkeys. Suspends AutoForge rate limits (per-bot + per-action), bypasses the vibe check, clamps the next-check interval to ≤1.5 min, shrinks the coordinator floor gap from 15s → 2s (`useMultiBotOrchestrator` calls `botCoordinator.configure`), and injects `SUPERCHARGE_DIRECTIVE` (`prompts.ts`) + `fellowBotUsernames` into `autoforgeDecide` so bots actively converse with and reference each other. Works in both loops (legacy single-bot + per-bot). Visual: exclusive `.supercharge-theme` CSS class on the document root — hot-pink + rainbow palette, puffy cloud backdrops, twinkling sparkles, animated rainbow viewport border (all CSS-driven, no overlay element).

### Speaker Coordinator (`src/lib/botCoordinator.ts`)
- Singleton `botCoordinator`. `requestFloor(botId, candidate)` opens a 2.5s bid window; highest `confidence + personaFit * 0.001 + (isMentioned ? 0.15 : 0)` wins. 15s floor gap between speaks. Manual sends bypass the coordinator.
- `BotCandidate.isMentioned` gives mentioned bots a 0.15 bidding bonus so they win the floor over slightly-higher-confidence non-mentioned competitors.

### Send Path (`src/lib/platformSend.ts`)
- `getPlatformSendFn(platform, botId?)` — returns a send function. `botId` omitted = legacy singleton; provided = per-bot identity with independent rate limiter.

### Twitch Mention Rendering (`src/lib/twitch.ts`, `src/lib/twitchReplyCache.ts`)
- Twitch's web chat only renders `@username` as a clickable, highlighted mention when the user is currently in the channel's chatters list. When a bot sends `@username` via IRC, users who aren't present (or other bots that haven't spoken recently) render as plain text.
- **Fix (v1.0.4):** The app uses Twitch's IRC reply tags to force mention rendering. `twitchReplyCache.ts` caches the most recent Twitch message ID per username (10-min TTL, 500-entry cap, cleared on channel switch). Message IDs are captured from incoming chat messages (`tags.id` in `App.tsx`'s `client.on('message')` handler).
- The `SendGuard` scans every outgoing message for `@username` mentions. If a mentioned user has a cached message ID, the message is sent as a Twitch reply via `client.raw()` with the `@reply-parent-msg-id=<id>` IRC tag. This makes the `@username` render as a clickable mention regardless of the user's presence. Falls back to a regular `client.say()` if the reply tag fails (stale/invalid ID).
- Twitch only (Kick/Joystick don't use IRC reply tags). Works in both legacy and multi-bot modes.

### Director Notes (`src/types.ts`, `src/lib/memoryRetrieval.ts`, `src/components/directorNoteShared.tsx`, `src/components/MultiBotPanel.tsx`, `src/components/AutoForgeHUD.tsx`)
- Private streamer-to-bot directives. Never sent to chat. Injected into the AutoForge decision context as a high-priority `[DIRECTOR NOTES]` block via `formatDirectorNotesContext()` (extracted from `formatMemoryContext` so it can be called independently).
- **Always injected** — even when AutoMemory is disabled. Director notes are user-authored directives, not auto-extracted memories. Both AutoForge loops (`useAutoForge`, `useAutoForgeBot`) build a `memoryContext` from director notes alone when AutoMemory is off.
- **Timed notes (v1.0.4):** `DirectorNote.expiresAt` (optional Unix-ms timestamp). `null` = until manually canceled. `formatDirectorNotesContext()` filters out expired notes so the AI never sees stale directives. Duration selector in the UI: "Until canceled", "5 min", "15 min", "30 min", "1 hour".
- **Active notes display:** The Director Note input shows an "N active" button that expands a dismissible chip list of active notes for the selected target, with remaining-time labels and per-note cancel buttons.
- **Priority & reordering (v1.0.4):** The array order IS the priority. Position 0 = PRIORITY 1 (highest), 1 = PRIORITY 2, 2 = PRIORITY 3, 3+ = STANDARD. `formatDirectorNotesContext()` labels the top 3 as `[PRIORITY 1/2/3]` and the rest as `[STANDARD]`; the header says "follow these directives in priority order." Active notes are drag-reorderable via framer-motion `Reorder.Group`/`Reorder.Item` (new notes append to bottom = lowest priority). In multi-bot mode, reordering is per-bot (select a specific bot); the "all bots" grouped view is read-only.
- **Shared primitives (v1.0.4):** `src/components/directorNoteShared.tsx` exports `DIRECTOR_NOTE_DURATIONS`, `formatNoteExpiry()`, `directorNoteSummary()`, `priorityBadge()`, and the `DirectorNoteChip` component. Both UIs consume this module so duration options, expiry labels, priority badges, and chip styling stay consistent across modes.
- **Multi-bot UI:** `DirectorNoteInput` in `MultiBotPanel.tsx` — target selector (all bots or one bot), duration selector, active notes grouped by identical text across bots (one dismiss cancels all copies). When a specific bot is selected, notes are drag-reorderable.
- **Single-bot UI (v1.0.4):** `SingleBotDirectorNoteInput` in `AutoForgeHUD.tsx` — rendered at the bottom of the expanded HUD when multi-bot mode is disabled. Mirrors the multi-bot input's duration selector, active-notes chip list, per-note cancellation, and drag-to-reorder. Uses the legacy `addDirectorNote` / `removeDirectorNote` / `clearDirectorNotes` / `reorderDirectorNotes` store actions.
- **Store actions:** `addDirectorNote(text, durationMs?)`, `removeDirectorNote(noteId)`, `clearDirectorNotes()`, `reorderDirectorNotes(noteIds)` (legacy single-bot); `addBotDirectorNote(botId, text, durationMs?)`, `removeBotDirectorNote(botId, noteId)`, `clearBotDirectorNotes(botId)`, `reorderBotDirectorNotes(botId, noteIds)` (multi-bot). Notes are capped at 50 per bot. Reorder actions place active notes first in the specified ID order; expired notes keep their relative order at the end.

### Memory (`src/lib/memoryEngine.ts`, `memoryStore.ts`, `memoryRetrieval.ts`)
- IndexedDB stores: `memories`, `profiles`, `jokes`, `personality`, `extractionLog` — all channel-scoped (channel index / composite keys).
- `extractMemories()` calls AI to extract structured memories from chat context.
- `retrieveRelevantMemories()` scores by strength, user match, keyword overlap, recency.
- `useAutoMemory()` hook runs extraction every N seconds + decay cycles, and re-hydrates the Zustand cache (`autoMemories`/`userProfiles`/`insideJokes`/`personalityState`) from IndexedDB whenever `streamMetadata.channelName` changes (with a stale-load guard).

### Channel Snapshots (`src/lib/channelStore.ts`)
- IndexedDB `madchatter-channels` / `snapshots`, keyed by lowercase channel name — the per-channel session archive (LTM, pinned/golden, AutoForge events + decision history, analytics/stats, goals, sentiment, chatter stats, token usage, sent log, and per-bot `botSessions`).
- Switch flow (`ForgeLayout.commitChannel`): `saveCurrentChannelSnapshot` → `clearAllContext` (wipes ALL session-scoped global + per-bot runtime state, incl. the auto-memory cache and retry queue) → `updateStreamMetadata` → `restoreChannelSnapshot`.
- All `ChannelSnapshot` fields beyond the original four are optional — old snapshots load as fresh starts. Keep new session fields optional; the IndexedDB object store needs no version bump for field additions.
- Autosave every 60s + on `beforeunload`, guarded by `isSwitchingRef` during a switch.
- Per-bot session restore is gated on `multiBotEnabled` — in single-bot mode the global fields are the source of truth (restoring per-bot events would duplicate them in the report's merge).

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
- `getHealthyFallbackChain(provider)` — returns only the user-selected provider (a stored API key alone does NOT opt a provider into the chain). Health-based cooldown still applies: if the selected provider is in cooldown, the chain is empty and the operation fails rather than silently rerouting to an unselected provider.
- Health tracking: 3 failures → 5min cooldown. `recordProviderFailure/Success`. Infrastructure preserved for future opt-in fallback.

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
| `src/lib/channelStore.ts` | Per-channel session snapshots in IndexedDB (save/restore on channel switch) |
| `src/lib/platformSend.ts` | Platform send functions (Twitch/Kick/Joystick) |
| `src/lib/twitchReplyCache.ts` | Twitch message-ID cache for reply-tagged mentions |
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
