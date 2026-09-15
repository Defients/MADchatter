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
- Zustand `persist` store, key `madchatter-storage`, schema version 24 with `migrate`.
- Legacy single-bot fields are the source of truth when `multiBotEnabled === false`.
- Multi-bot state (`bots[]`, `activeBotId`, `manualSendBotId`) is additive — enabling copies legacy state into `bots[0]`; disabling syncs back.
- `selectMultiBotActive` (exported selector): `multiBotEnabled && ≥2 bots active && authenticated`.
- Bot-scoped action twins (`addBotSentMessage`, `incrementBotStat`, etc.) mirror global actions per-bot.
- **Interface Mode (v1.0.7):** `interfaceMode: 'core' | 'studio'` — one authoritative mode drives presentation density. Core = minimal operational surface; Studio = full-density experience. Mode changes presentation only, never engine behavior or config. Default: `'core'` for new users; v22/v23 migrations force all users (including existing) to `'core'` — users who prefer Studio switch via the header toggle and their choice persists from then on.
- **STUDIO capability gating:** `interfaceMode` is the user's *preferred* mode (persisted). The *effective* mode that renders is `(studioAvailable && !studioForcedCore) ? interfaceMode : "core"`. `studioAvailable` = viewport `min-width ≥ 1280px` (`STUDIO_MIN_WIDTH` in `src/lib/studioAvailability.ts`, chosen because the TuningDeck right rail holds ~280px controls — below 1280 the three-panel workspace compresses unusably). `studioForcedCore` is a transient (non-persisted) flag set when a shrink forces a Studio user into Core or when the session starts below the threshold — it prevents an auto-snap back on expand (user re-enters manually). `setInterfaceMode` is the single chokepoint: requesting `"studio"` while unavailable opens the `studioGateOpen` interstitial instead of switching, so a saved Studio preference is never destroyed by a phone/narrow session. Components use `useEffectiveMode()` (reactive) / `getEffectiveMode()` (non-reactive); `useStudioAvailable()` is the canonical capability read; `useStudioAvailabilitySync()` (mounted in `App.tsx`) keeps the module flag in sync and fires the shrink→Core fallback toast. Gate UI: `StudioGateOverlay`.
- **Onboarding milestones (v1.0.7):** `hasSentMessage` (set on actual send success via `manualSend.ts`, not button click — dry-run sends don't count), `hasEnabledAutoForgeOnce` (set in `setAutoForgeEnabled`), `activationCelebrated` (fires once when operational), `microToursSeen` (tracks micro-tour dismissals), `personaChosen` (set when user picks a persona in Core setup; drives `personalityReady` in `useCoreReadiness`), `modeWelcomeSeen` (gates the first-run `ModeWelcomeOverlay`). `hasForgedOnce` (pre-existing) is reused for the Forge milestone.

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
- `checkOllamaHealth(baseUrl, model)` — lightweight `/v1/models` check with a 30s cache keyed by endpoint/model, bounded to 20 configurations. In-flight deduplication is configuration-specific; invalidation aborts pending checks and prevents stale cache writes. `getCachedOllamaHealth(baseUrl, model)` returns only fresh evidence for that pair.
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
- **Supercharge teardown (v1.0.5):** When Supercharge is disabled, both AutoForge loops listen for the `easter-egg-supercharge` event with `detail.active === false` and reset pacing state so bots return to normal cadence immediately. Without this, three pieces of Supercharge-era state persisted: the rate limiter was full of Supercharge action timestamps (actions are recorded unconditionally even when the `canAct` gate is bypassed), `consecutiveSilenceRef` was 0 (Supercharge produces actions, not silences, so `computeAdaptiveBackoff` never lengthened the interval), and the model returned low `estimated_next_action_minutes` because its recent-chat context still showed Supercharge-era frequent activity. On disable: the rate limiter is cleared (`actionRateLimiter.reset()` / `removeBotRateLimiter(botId)`), `consecutiveSilenceRef` resets to 0, and the next-action timestamp is pushed forward 90s so the recent-chat context ages out before the next check. Normal rate limits apply immediately on the next action.

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

### Memory (`src/lib/memoryEngine.ts`, `memoryStore.ts`, `memoryRetrieval.ts`, `memoryContinuity.ts`)
- IndexedDB stores: `memories`, `profiles`, `jokes`, `personality`, `extractionLog` — all channel-scoped (channel index / composite keys).
- `extractMemories()` calls AI to extract structured memories from chat context.
- `retrieveRelevantMemories()` scores by strength, user match, keyword overlap, recency.
- `useAutoMemory()` hook runs extraction every N seconds + decay cycles, and re-hydrates the Zustand cache (`autoMemories`/`userProfiles`/`insideJokes`/`personalityState`) from IndexedDB whenever `streamMetadata.channelName` changes (with a stale-load guard).
- **Semantic dedup (v1.0.5):** `applyExtractionResults()` runs a Jaccard similarity check (reusing `isNearDuplicate` from `antiRepetition.ts`) of each new memory against ALL existing memories before storing. New memories >70% similar to any existing one are skipped and logged. Prevents memory bloat from rephrased duplicates that slip through the AI's top-20 dedup window.
- **Extraction cursor (v1.0.6):** `src/lib/memoryContinuity.ts` provides `MemoryExtractionCursor` (message-ID set + audio tail), `captureMemoryExtractionCursor()`, and `hasNewMemorySignal()`. Replaces the count-based watermark that stalled permanently once `chatLog` hit its 150-message cap. The ID-set detects new messages even when the total count is stable; the audio tail triggers extraction on audio-only signal too. `useAutoMemory` gates on `hasNewMemorySignal()` instead of the count delta.
- **Incremental decay (v1.0.6):** `applyMemoryDecay`/`applyJokeDecay` now anchor to `lastDecayedAt` (falling back to `lastReferencedAt`/`lastUsedAt` for older saves). Each cycle applies `0.5^(elapsedSinceAnchor / halfLife)` and updates `lastDecayedAt` to `now`. Running N cycles over span T = running once over T (no compounding drift). The old code re-applied from `lastReferencedAt` every cycle, compounding the exponent — a 7-day half-life memory lost ~91% in 1 day of 30-min cycles instead of ~10%.

### Session Scope (`src/lib/sessionScope.ts`)
- **Problem solved:** All stale-channel guards compared channel-name strings, which passed on A→B→A round-trips (switch away and back mid-flight). The old session's work (decisions, sends, memory writes, vision, smart replies) would write into the restored session.
- `SessionScope` = `{ revision, platform, channel }`. `sessionRevision` (in the store, bumped on `setPlatform`, `updateStreamMetadata` channel change, `clearAllContext`) invalidates work across round-trips.
- `captureSessionScope()` / `isSessionScopeCurrent(scope)` — snapshot + compare. `normalizeSessionChannel()` strips `#`, trims, lowercases.
- `createAutoForgeExecutionGuard(identityIsCurrent)` — subscribes to the store and invalidates on: channel/platform change, AutoForge toggle, dry-run flip, multi-bot mode flip, or `identityIsCurrent()` returning false (bot deactivated/session lost). Returns `{ isCurrent(), dispose(), cancel() }`. `isCurrent()` does a live `contextMatches()` check AND checks a sticky `cancelled` flag set by the subscription. `dispose()` removes the subscription (call in `finally`); `cancel()` sets `cancelled` + unsubscribes.
- **Wiring:** Both AutoForge loops create a guard per check cycle, check `guard.isCurrent()` after each `await` (decision, generateChat, floor bid) and before each send, and `guard.dispose()` in `finally`. Deferred `quick_followup` sends use a captured `SessionScope` (the guard is disposed before the timer fires). AutoMemory extraction, vision capture, and smart-reply generation all use `captureSessionScope`/`isSessionScopeCurrent` for their async guards.
- `sessionRevision` is runtime-only (not in `partialize` — never persisted).

### Sentiment (`src/lib/sentiment.ts`)
- Lexicon-based classifier with 6 labels: positive, negative, hype, wholesome, toxic, neutral.
- **Negation & intensity (v1.0.5):** `classifySentiment()` scans for negation words ("not", "never", "don't", etc.) within 3 words before a sentiment word and flips its contribution to the opposite category (reduced weight 0.5×). Intensity amplifiers ("very", "really", "super") multiply the following word's weight by 1.5×; dampeners ("kinda", "slightly") by 0.5×. Single-word lexicon entries use word-boundary matching (prevents "what" matching "w", "kinda" matching "kind").
- `summarizeSentiment()` computes distribution + trend (rising/falling/stable) over last 50 readings.
- `addSentimentReading()` caps history at 100 entries.
- `formatSentimentContext()` produces the `[CHAT SENTIMENT]` prompt block.

### Conversation Threading (`src/lib/conversationThread.ts`)
- Twitch-only reply-thread tracker (Kick/Joystick don't support IRC reply tags).
- Captures `reply-parent-msg-id` from incoming Twitch messages (App.tsx message handler) and records bot message IDs (when `self=true`).
- Bounded map: 200 entries, 10-min TTL, pruned on every insert. Cleared on channel switch (`setThreadChannel`).
- Capacity is enforced on incoming/outgoing insertion and bot marking; message eviction removes its bot marker. An explicit bot username filters all roots, including marked roots, case-insensitively. Omitting the username retains the all-marked-bots lookup.
- Regression checks: `npx tsx --test src/lib/conversationThread.test.ts` (identity isolation, capacity, expiry, channel changes, and reply chains).
- `getActiveThreads(botUsername)` — returns threads rooted at the bot's messages with recent reply activity (5-min window).
- `formatThreadContext(botUsername)` — formats active threads into a compact `[ACTIVE CONVERSATION THREADS]` prompt block.
- Both AutoForge loops (`useAutoForge`, `useAutoForgeBot`) inject `formatThreadContext()` into `autoforgeDecide` via the `threadContext` param so the bot knows when it's being replied to.

### Smart Replies (`src/lib/smartReplies.ts`)
- `generateSmartReplies(mentionedLines, { botId })` — generates 3 short reply suggestions when the bot is mentioned.
- **Context enrichment (v1.0.5):** Now injects the same rich context as AutoForge: memory context (from `retrieveRelevantMemories` + `formatMemoryContext` + `formatDirectorNotesContext`), anti-repetition context (folded into `memoryContext`), long-term memory (pinned + golden), bot identity mode + story, available emotes, and visual context. In multi-bot mode, uses the bot's own per-bot memory and sent history.
- 30-second cooldown, 60-second expiry. Scheduled at `autonomous` priority (must not block manual Forge).
- Resolves the actual bot username from the platform session (multi-bot mode uses the explicit `botId` or `manualSendBotId`).

### Channel Snapshots (`src/lib/channelStore.ts`)
- IndexedDB `madchatter-channels` / `snapshots`, keyed by lowercase channel name — the per-channel session archive (LTM, pinned/golden, AutoForge events + decision history, analytics/stats, goals, sentiment, chatter stats, token usage, sent log, and per-bot `botSessions`).
- Switch flow (`ForgeLayout.commitChannel`): `saveCurrentChannelSnapshot` → `clearAllContext` (wipes ALL session-scoped global + per-bot runtime state, incl. the auto-memory cache and retry queue) → `updateStreamMetadata` → `restoreChannelSnapshot`.
- All `ChannelSnapshot` fields beyond the original four are optional — old snapshots load as fresh starts. Keep new session fields optional; the IndexedDB object store needs no version bump for field additions.
- Autosave every 60s + on `beforeunload`, guarded by `isSwitchingRef` during a switch.
- Per-bot session restore is gated on `multiBotEnabled` — in single-bot mode the global fields are the source of truth (restoring per-bot events would duplicate them in the report's merge).

### R34L Mode (`src/lib/prompts.ts`, `src/lib/chatStyle.ts`)
- `R34L_TYPING_PROMPT` — fixed typing texture overlay (lowercase, punctuation, rhythm). Injected when `r34lEnabled` is true.
- `STANDARD_TYPING_PROMPT` — explicit normal capitalization and grammar instruction. Injected when `r34lEnabled` is false. Without this, models default to lowercase Twitch-chat style because the recent chat log is lowercase and the base prompts say "be human-like." The standard prompt overrides that: capitalize sentences, use standard punctuation, no spelling mutations, still casual but not deliberately messy.
- `analyzeChatStyle()` — analyzes recent chat for casing, emote density, slang, punctuation.
- `formatChatStyleProfile()` — injects observed texture into the prompt as a profile block.
- Cringe tokens (`lol`, `tbh`, `ngl`, `lmao`, etc.) are excluded from the slang lexicon and punctuation signals to prevent re-encouraging trailing closers.
- **Refine prompt** has a permanent `TYPING STYLE` rule (normal capitalization/grammar) since it doesn't gate on `r34lEnabled`.

### Emote System (`src/lib/emotes.ts`)
- Fetches global + channel-specific emotes from 7TV, FrankerFaceZ, and BetterTTV. Channel emotes override globals (same name → channel version). Cached per channel (10-min TTL).
- `Emote` interface includes `provider` ("7tv" | "ffz" | "bttv") and `scope` ("channel" | "global").
- `getAvailableEmoteNames(channel, limit)` — plain emote names for chat style analysis (emote density counting).
- `getAvailableEmotesTagged(channel, limit)` — provider+scope-tagged names (e.g. `"monkaS (7tv-channel)"`) for the AI prompt. Channel emotes listed first, then globals.
- **Emote preference (v1.0.4):** All three system prompts (Forge, AutoForge, Refine) include an `EMOTE PREFERENCE` rule: favor channel-specific emotes from BTTV/7TV/FFZ, rarely use generic/standard emotes not in the list. The prompt's `AVAILABLE EMOTES` line uses the tagged format when `availableEmotesTagged` is provided, falling back to plain names otherwise.

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

### Core Mode + Interactive Launchpad (v1.0.7)
- **Two interface-density modes:** `interfaceMode: 'core' | 'studio'` — one authoritative mode drives presentation density. Core = minimal operational surface (connect, AI, personality, Forge, send, AutoForge, chat). Studio = the existing full-density experience. Mode changes presentation only, never engine behavior or config.
- **`useCoreReadiness()` hook** (`src/hooks/useCoreReadiness.ts`) — derives Launchpad readiness from real application state. Stages: Platform → AI → Personality → Forge → Send → AutoForge → Operational. Each stage derives from source-of-truth state (channel + chat connection, provider config + first Forge, active profiles, persisted milestones). AutoForge is optional — operational = Platform + AI + Personality + Forge + Send. Readiness policy is in `src/lib/coreReadiness.ts`: selected-provider configuration and cooldown plus actual connected chat determine live availability; historical milestones preserve workspace presentation without implying a live session. Provider keys and health are observed via `useSyncExternalStore` (shared 1s interval), same-tab auth ticks, and cross-tab storage events. Regression tests: `npx tsx src/lib/coreReadiness.test.ts` and `npx tsx src/lib/ollamaHealth.test.ts`.
- **`CoreMode.tsx`** (`src/components/CoreMode.tsx`) — exports `CoreTuningControls` (persona grid, humor/chaos sliders, Forge button, AutoForge toggle, Advanced disclosure), `CoreLaunchpad` (readiness bar + expandable stage details + Studio discovery), `InterfaceModeToggle` (header `[ CORE ] [ STUDIO ]` toggle), and `CoreActivationCelebration` (one-shot "MADchatter is live" overlay).
- **`CoreGreeting.tsx`** (`src/components/CoreGreeting.tsx`) — minimal first-run greeting that drops new users into Core Mode. Replaces the feature-encyclopedia Welcome overlay for first-time users. The original `WelcomeOverlay` is retained for manual "Reopen Welcome Screen" access.
- **Chat visibility:** Core Mode auto-opens the chat widget so the user always has visible stream context. Other widgets stay in their user-set state.
- **Advanced disclosure:** Core Mode's Advanced drawer shows read-only summaries of R34L, AutoMemory, context tokens, dry run, and Multi-Bot state, with a "Open Studio for full controls" link. Underlying systems continue running with their existing/default configuration.
- **AutoForge transparency:** Core Mode never hides active automation. The Launchpad shows an "AutoForge" badge (with Dry Run indicator) when AutoForge is enabled. Multi-Bot active state is shown as a badge.
- **Migration safety:** Schema v21 seeds onboarding milestones; v22/v23 force all users to `'core'` (Core Mode is the primary experience). v24 persists `personaChosen` and `modeWelcomeSeen` (previously declared but missing from `partialize`). New users get the store default `'core'`. All onboarding milestones default false. `microToursSeen` defaults empty.
- **Tutorial changes:** The 22-step monolithic tutorial no longer auto-starts (marked as seen on first load). It's retained for manual access via command palette. Core Mode's Launchpad replaces it as the onboarding surface.
- **Tests:** `npx tsx src/lib/coreMode.test.ts` (52 tests: new-user defaults, mode switching preserves settings, onboarding milestones, dry-run no send milestone, Multi-Bot survives mode switch, provider survives, micro-tour dismissal, activation celebration, phase transitions, essential vs automation readiness, error states, `personaChosen`/`modeWelcomeSeen` persistence through `partialize`).

## Conventions

- **No new features without explicit request** — prefer polish, bug fixes, and code health.
- **Multi-bot is additive** — never destroy legacy single-bot state. Copy on enable, sync back on disable.
- **Provider dispatch** — use `openAiCompatEndpoint()` for OpenAI-compatible providers. Don't duplicate the baseUrl/model ternary.
- **Smart replies and manual sends** — always record in sent log + stats + event log. Untracked sends break anti-repetition and analytics.
- **R34L** — never add cringe tokens (`lol`, `tbh`, `ngl`, `lmao`, `fr`, `lowkey`, `istg`, `frfr`) to slang lexicon, punctuation signals, or softener examples. The fixed prompt explicitly bans them as trailing closers.
- **Persistence** — new persisted fields require a `SETTINGS_VERSION` bump + migration step in `store.ts`.
- **Build warnings** — `node:fs`/`node:path` externalization and chunk-size warnings are expected; do not attempt to fix them.
- **Tests** — focused TypeScript harnesses live alongside the source and run with `npx tsx`; the conversation-thread suite uses `npx tsx --test src/lib/conversationThread.test.ts`. Run relevant regressions plus both required gates (`npm run lint` and `npm run build`); manually verify affected UI flows.

## Key File Map

| File | Responsibility |
|------|---------------|
| `src/store.ts` | Zustand store, persistence, multi-bot state, interface mode, onboarding milestones |
| `src/types.ts` | All domain types (55+ exports) |
| `src/App.tsx` | App shell, chat clients, shortcuts, hook mounting |
| `src/lib/ai.ts` | All AI generation + dispatch + JSON repair |
| `src/lib/aiScheduler.ts` | AI request orchestrator (priority, preemption, cancellation, telemetry) |
| `src/lib/aiScheduler.test.ts` | Scheduler test suite (run: `npx tsx src/lib/aiScheduler.test.ts`) |
| `src/lib/coreMode.test.ts` | Core Mode + onboarding tests (run: `npx tsx src/lib/coreMode.test.ts`) |
| `src/hooks/useCoreReadiness.ts` | Core Launchpad readiness derivation from real app state |
| `src/components/CoreMode.tsx` | CoreTuningControls, CoreLaunchpad, InterfaceModeToggle, CoreActivationCelebration |
| `src/components/CoreGreeting.tsx` | Minimal first-run greeting (drops new users into Core Mode) |
| `src/lib/sentiment.test.ts` | Sentiment classifier tests (run: `npx tsx src/lib/sentiment.test.ts`) |
| `src/lib/autoForgeCore.test.ts` | AutoForge core computation tests (run: `npx tsx src/lib/autoForgeCore.test.ts`) |
| `src/lib/antiRepetition.test.ts` | Anti-repetition + Jaccard dedup tests (run: `npx tsx src/lib/antiRepetition.test.ts`) |
| `src/lib/chatStyle.test.ts` | Chat style analyzer tests (run: `npx tsx src/lib/chatStyle.test.ts`) |
| `src/lib/personalityEngine.test.ts` | Personality engine tests (run: `npx tsx src/lib/personalityEngine.test.ts`) |
| `src/lib/memoryRetrieval.test.ts` | Memory retrieval + director notes tests (run: `npx tsx src/lib/memoryRetrieval.test.ts`) |
| `src/lib/botCoordinator.test.ts` | Bot coordinator tests (run: `npx tsx src/lib/botCoordinator.test.ts`) |
| `src/lib/ollamaHealth.ts` | Ollama endpoint/model reachability check |
| `src/lib/prompts.ts` | System prompts (Forge, AutoForge, R34L, memory) |
| `src/lib/keys.ts` | Provider keys, `openAiCompatEndpoint()` |
| `src/lib/chatStyle.ts` | Chat style analysis for R34L adaptation |
| `src/lib/emotes.ts` | 7TV/FFZ/BTTV emote fetching, parsing, tagged names for AI prompt |
| `src/lib/botCoordinator.ts` | Multi-bot speaker floor (mention-priority bidding) |
| `src/lib/autoForgeCore.ts` | Shared AutoForge computation (activity, engagement, health, goals, vibe check, adaptive backoff, dedup) |
| `src/lib/antiRepetition.ts` | Repetition analysis + Jaccard semantic dedup (`isNearDuplicate`) |
| `src/lib/conversationThread.ts` | Twitch reply-thread tracker (active thread context for AutoForge) |
| `src/lib/smartReplies.ts` | Smart reply generation (enriched with full context, v1.0.5) |
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
