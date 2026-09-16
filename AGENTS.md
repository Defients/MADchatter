# AGENTS.md — Contributor Guide

## Build & Verify

```bash
npm install          # install deps
npm run dev          # start dev server (Vite)
npm run build        # production build — must pass before committing
npm run lint         # tsc --noEmit — type-check only, no emit
npm test             # isolated regression suites + local send/channel harnesses
npm run server       # run Express/OAuth backend (tsx server.ts)
```

**Always run `npm run lint` and `npm run build` before considering work done.** Both must exit 0.

Run `npm test` for regression verification. It discovers `src/**/*.test.ts`, runs
each in a separate process, and routes channel-switch coverage through its bundled
harness. Manual-send and platform-send harnesses use local delivery fakes. The
runner reports every failing suite and returns nonzero on failures or timeouts.

Known non-fatal Vite build warnings (safe to ignore):
- `node:fs` / `node:path` externalized for browser (Anthropic SDK imports)
- Dynamic/static import chunking warnings for store.ts, ai.ts, tts.ts, notifications.ts
- Chunks > 500 kB (large single-page bundle)

## Architecture Overview

### State (`src/store.ts`)
- Zustand `persist` store, key `madchatter-storage`, schema version 30 with `migrate`.
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

### Independent Vision Provider (`src/lib/visionProvider.ts`, v26)
- **Split-provider routing:** Text generation and screenshot interpretation can use different providers. The user picks a vision mode in Settings → Vision:
  - `"text"` (default, backward-compatible) — vision flows through the active text provider exactly as before.
  - `"ollama"` — screenshots are routed to a separately configured local Ollama endpoint + image-capable model. The text provider (e.g. Groq) never receives the raw image — only the textual observation.
- **Centralized resolver:** `resolveVisionConfig()` is the single chokepoint. It returns `{ mode, provider, baseUrl, model, apiKey, independent, ollamaConfigured, prefersOllama }`. Every vision call site (`visionRequest`, `generateVisionContext`) routes through it. `isIndependentVisionActive()` gates the screenshot-stripping in `generateChat`.
- **Degradation:** When the user picks `"ollama"` but hasn't set a model, `resolveVisionConfig()` degrades to `"text"` mode so vision keeps working through the text provider. `prefersOllama` stays true so the UI surfaces "configuration incomplete."
- **No image leakage:** When `isIndependentVisionActive()` is true, `generateChat` strips `params.screenshot` before building the text request — the image is never attached, never retried text-only after a rejection, and never sent to a cloud fallback. The textual observation (`visualContext`) is the only visual signal the text provider receives.
- **No text-config mutation:** Vision settings (`visionOllamaBaseUrl`, `visionOllamaModel`) are independent from text-provider Ollama config (`customBaseUrl`, `customModel` in `keys.ts`). Editing vision never overwrites Groq/legacy settings.
- **Session isolation:** `visionConfigRevision` (runtime-only, not persisted) bumps on every vision config change. The setters also clear `visualContextTags` + `visualSnapshotUrl` so a superseded provider's observation is never presented as current. ForgeLayout's vision capture captures the revision before the async call and discards results from an older revision (in addition to the existing `captureSessionScope` channel guard).
- **Scheduler isolation:** Vision requests are tagged `provider: "ollama"` when independent; text requests keep their own provider tag. A local vision failure never poisons cloud text-provider health (separate health tracking). Ollama's single-slot priority behavior applies to the vision Ollama endpoint independently.
- **Multi-bot sharing:** Vision capture is single (ForgeLayout); the observation lives in the shared `visualContextTags`. Both AutoForge loops read the same state — multiple bots do NOT analyze the screenshot separately.
- **Capability honesty:** The Settings "Check Model Availability" button verifies the endpoint is reachable and the model is listed (via `checkOllamaHealth`), but does NOT claim image analysis works — a text-only model can pass. The status line distinguishes "ready" (model listed) from "model_unavailable"/"endpoint_unreachable". Image analysis is verified on the first real capture. MADchatter never downloads models or hard-codes an unverified "recommended" vision model.
- **Persistence (schema v26):** `visionProvider`, `visionOllamaBaseUrl`, `visionOllamaModel` persist via `partialize` + `exportSettings`/`importSettings`. `visionConfigRevision` is runtime-only (never persisted). Migration v26 defaults existing users to `"text"` (legacy behavior preserved).
- Tests: `npx tsx src/lib/visionProvider.test.ts` (77 scenarios: routing, isolation, freshness, capability, no-image-to-text, persistence, multi-bot sharing).

### Room Model / Moment Timeline (`src/lib/roomModel.ts`, v28)
- **Shared situational-awareness substrate:** one deterministic engine turns MADchatter's perception (chat, audio energy, transcript, vision, platform events, threads, sentiment, agent sends) into a continuous `RoomState` + a bounded `RoomMoment[]` timeline. Facts first, synthesis second — timestamps, velocity, fusion, significance, confidence, lifecycle, and retention are 100% deterministic; the Room Model works with no provider configured, Ollama offline, or most lanes dark.
- **Engine (`RoomModelEngine`, module singleton `roomModel`):** pure module (no store/timers/AI imports). `noteChat` / `noteAgentSend` / `noteAudioEnergy` / `noteVision` / `notePlatformEvent` / `noteTranscript` / `noteConversation` ingest; `tick(now)` runs lifecycle maintenance (idle close, quiet moments, retention); `getState()` / `getMoments()` / `exportSnapshot()` read. Significance ≠ confidence (significance = mattered; confidence = evidence agreement). Human vs bot activity is attributed at every layer — bot-only chatter can never inflate chat velocity, significance, or moments.
- **Fusion:** chat surges (relative to the session's own rolling baseline), audio spikes, vision deltas, platform events, sentiment polarity flips, and multi-user conversation formation become scored events. Compatible events within a fusion window (9s default; 30s stream-event aftermath; 90s conversation; 30s late-vision enrich) merge into ONE moment — one physical event never becomes four moments. Platform events (raid/sub/cheer/host) anchor moments deterministically at 0.95+ confidence.
- **Lifecycle/retention:** moments idle-close (60s reaction / 240s conversation), a new incompatible high-significance event closes the old one, and sustained human silence becomes at most ONE bounded `quiet` moment per 10 min. Hard caps everywhere: 150 signals, 60 moments, 24 evidence refs, 6 evidence lines per moment (see `ROOM_MODEL_LIMITS`).
- **Wiring (`src/hooks/useRoomModel.ts`, mounted in App.tsx):** binds the engine to the live channel (sessionRevision + channelName), ticks ~1/s (thread/participant/mention facts → `tick` → mirror flush into the store with content-signature dedup + 10s heartbeat), and drives sparse AI synthesis.
- **Ingestion is store-action-level, not render-level:** `setVisualSnapshot` → `noteVision` (tags + delta), `setAudioEnergy` → `noteAudioEnergy`, `addStreamEvent(event, detail?)` → `notePlatformEvent` (Twitch handlers pass structured `RoomPlatformEventDetail`; strings parse deterministically via `parsePlatformEventSummary`), `appendAudioTranscript` → `noteTranscript`, `addSentMessage`/`addBotSentMessage` → `noteAgentSend`, and `App.tsx processIncomingMessage` → `noteChat` (sentiment + mention carried — never recomputed). Own-bot messages are filtered before `processIncomingMessage`, so chat notes are human/foreign only.
- **Store mirror:** `roomState` / `roomMoments` (session-scoped like chatLog — NOT in localStorage partialize; archived per channel in the `roomModel` field of the channelStore snapshot). `clearAllContext` calls `roomModel.reset(null)` and wipes the mirror; `restoreChannelSnapshot` calls `roomModel.restore(channel, snapshot.roomModel)` — closed moments survive as history, the active moment force-closes, and all volatile state (freshness, baselines) resets (stream-restart semantics). `roomModelSynthesisEnabled` is the persisted user toggle.
- **AutoForge integration:** both loops pass `roomStateContext: formatRoomStateContext(roomModel.getState(), roomModel.getMoments())` into `autoforgeDecide`. The block is advisory by construction — it declares in-prompt that direct evidence (mentions, transcript, recent chat) outranks it; it never replaces raw context.
- **AI synthesis (sparse enrichment only):** on close, moments with significance ≥ 0.75 queue for synthesis. The hook drains the queue at most once per 10 min (and only one moment per drain), only when `roomModelSynthesisEnabled` + a provider key exist, via `generateMomentSynthesis` (`ai.ts`) at scheduler `background` priority. Results apply only through `roomModel.applySynthesis(momentId, channel, …)` — channel-guarded, idempotent, and restricted to `title` / `summary` / `topicHints` / `provenance`. Deterministic fields can never be touched; failure is quiet (the moment keeps its deterministic fallback title via `deterministicMomentTitle`). Token usage records under the `moment_synthesis` feature key.
- **UI (pure consumer):** `RoomReadCard` (`src/components/RoomReadCard.tsx`) renders the semantic Room Read (headline, signal chips, Why? evidence, moment timeline) over the shared `RoomReadState` contract. Three density variants over one contract: core (CoreWorkspace, above TheForge), compact (CoreMobileWorkspace), studio (ForgeLayout center panel, above TheForge, with sig/conf meters + perception lane table). Never recomputes anything.
- Tests: `npx tsx src/lib/roomModel.test.ts` (94 deterministic scenarios: fusion, lifecycle, quiet, conversations, raids, bot-inflation, late-vision, synthesis guards, channel isolation, A→B→A restore, retention bounds, concurrent-flood race).

### Room Read Contract (`src/lib/roomRead.ts`, `src/hooks/useRoomRead.ts`)
- **One canonical derived read:** `deriveRoomRead(input)` turns the Room Model mirror (`roomState` + `roomMoments`) plus contextual facts (`botsActiveRecent`, `streamerCallout`) into a single `RoomReadState`: status (`observing`/`ready`/`quiet`/`partial`/`stale`), a confidence-scaled headline, 3–5 human chips, evidence groups, per-lane freshness, `semanticKey` anchor, and priority. Pure — no store/React/AI. All surfaces (CORE/compact/studio) consume this shape; the card owns presentation only.
- **Headline priority:** streamer callout (transcript fuzzy name match, 60s window) > platform anchor (raid/cheer/etc., 120s window, 0.95 — deterministic facts) > fresh active Moment (AI `summary` when present, else deterministic per-kind template; 90s/240s freshness) > contextual synthesis from live signals (spike / streamer-talking / threads / rising) > factual fallback. **Semantic TTL:** expired moments never anchor — stale vision/audio can't stay present-tense.
- **Confidence scales language:** band high ≥ 0.65 (assertive: "Chat just erupted."), medium ≥ 0.4 ("Chat seems to be reacting…"), low → factual only. Moment confidence age-decays past 2 min. Quiet rooms render as valid quiet reads, never broken; partial perception keeps surviving lanes useful with dim stale-lane warnings.
- **Bot/human truth:** activity is engine-computed human-only. When only MADchatter bots are talking, the read is "Chat is quiet — MADchatter bots are currently active." (status `quiet`, dim bot chip) — never a busy room.
- **Stability (`stabilizeRoomRead`):** same `semanticKey` keeps the headline (no synonym roulette); a new anchor waits `minHeadlineLifetimeMs` (10s) unless it outranks the current one (callout/raid/platform preempt instantly; truthfulness — stale/observing — always wins); quiet↔ready status has activity hysteresis (ambient reads only — moment anchors are exempt). Fast deterministic layers (chips/freshness/lanes) update every derivation.
- **Hook (`useRoomRead`):** one derivation per second via `useAppStore.getState()` polling — raw chat messages never rerender the card. Detects the streamer callout from `audioTranscript` growth (`isNameMentioned` against per-bot + legacy session usernames), computes `botsActiveRecent` from self-sent/marked chatLog lines, and resets both the previous read and any callout on `sessionRevision` bumps (channel A's read can never render in channel B, even for one tick). Emits only on signature change or every 2s (age labels stay live). `getRoomReadDebug()` exposes the observability snapshot.
- Tests: `npx tsx src/lib/roomRead.test.ts` (60 deterministic checks: lifecycle states, headline priority, confidence-scaled wording, semantic TTL, bot attribution, stability/hysteresis/preemption, stale-async moment guard, observability shape).

### Perception Liveness (`src/lib/perceptionLiveness.ts`, `src/hooks/usePerceptionLiveness.ts`)
- **Canonical sensor-truth substrate:** pure deterministic engine answers "can MADchatter see, hear, and read the room right now?" Tracks 4 lanes (chat, audio, vision, platform_events) across capture, transport, transcription, and semantic stages.
- **Truth states:** `live` (flowing fresh), `quiet` (connected/supported but naturally silent — a connected chat socket with no messages is never marked stale or broken), `stale` (was live, stopped past timeout), `degraded` (unsupported platform capability or partial fallback), `error` (explicit pipeline failure with classification reason codes), `off` (intentional user disable).
- **Wiring (`usePerceptionLiveness`):** binds to live channel (~1s tick), mirrors to `perceptionSummary` in store with content dedup. Ingestion at store-action level: `noteChatInput`, `noteAudioEnergy`, `noteTranscript`, `notePlatformEvent`, `noteVisionCapture`.
- **Consumers:** `RoomReadCard` (renders `PerceptionStrip` inline), `autoforgeDecide` (appends `formatPerceptionContext` so AI never treats dead sensors as fresh evidence).
- Tests: `npx tsx src/lib/perceptionLiveness.test.ts` (85 deterministic scenarios: stage transitions, recovery, reason codes, capabilities, export).

### Semantic Coordination (`src/lib/semanticCoordination.ts`)
- **Conversational awareness substrate for Multi-Bot:** prevents the swarm problem where multiple active bots talk over each other or repeat jokes. Pure deterministic ledger tracks conversational ownership, speaker balance, turn debt, and cross-bot duplication.
- **Coordinator integration (`botCoordinator.ts`):** `requestFloor` evaluates semantic fit, persona affinity, and recent turn history before granting the floor. Directly addressed bots take priority; others defer.
- **Bot disposition:** inspectable receipt per bot (`speak` / `defer` / `silence` with human-readable reason) rendered on bot cards in `MultiBotPanel`.
- **Session safety:** ledger resets on channel switch (volatile conversational debt never carries over).
- Tests: `npx tsx src/lib/semanticCoordination.test.ts` (127 deterministic checks: balance, floor resolution, cross-bot dedup, simulation harness).

### Participation Awareness & Annoyance Control (`src/lib/participationAwareness.ts`, `src/components/ParticipationControl.tsx`)
- **Unified restraint engine (v28):** replaces scattered heuristic backoffs with a single state machine: `open` → `cautious` → `cooling_down` → `direct_only` → `quiet`.
- **Signals:** chat volume drops, user sentiment toxicity, streamer instructions ("be quiet"), and bot send density trigger progressive restraint. Mentions and direct streamer addresses always pass.
- **Hard controls:** `botsGlobalStop` (persisted user toggle) blocks ALL automated send paths at the `platformSend` chokepoint immediately. Manual operator sends from chat input remain available.
- **UI (`ParticipationControl.tsx`):** compact status chip (Listening / Cooling down / Direct-only) + global STOP button mounted in `CoreWorkspace` and `AutoForgeHUD`.
- **Persistence (schema v28):** `participationManualMode`, `participationAwarenessEnabled`, `botsGlobalStop` persist via `partialize`. Volatile risk state resets per channel visit.

### Episodic Memory (`src/lib/episodicMemory.ts`, `src/hooks/useEpisodicMemory.ts`, v29)
- **Shared experience substrate ("what happened?"):** bridges working memory (Room Model) and semantic memory (AutoMemory). Turns closed Room Moments into bounded, provenance-aware `Episode`s — shared events with boundaries, participants, topics, significance, and confidence.
- **Engine (`EpisodicMemoryEngine`, module singleton `episodicMemory`):** pure, deterministic consolidation. Moments below candidate threshold (<0.55) are ignored; bot-only moments cannot open episodes (capped at 0.30 significance). Retention: `persistent` (≥0.62, survives sessions) vs `session` (≥0.50, stream-local) vs discard (<0.50).
- **Wiring (`useEpisodicMemory`, mounted in App.tsx):** feeds closed moments from the Room Model, runs ~1s tick (idle close, compaction, archival), mirrors `episodes` to store, and drives sparse background AI synthesis of closed high-significance episodes (at most 1 per 10 min, channel-guarded, token usage under `episode_synthesis`).
- **Context injection:** both AutoForge loops build bounded `episodicContext` via `buildAutoForgeEpisodicContext` (gated on `episodicMemoryEnabled`). Injected into `autoforgeDecide` with `EPISODIC_AWARENESS_PROMPT` — framed explicitly as past events; direct evidence outranks it.
- **Channel persistence:** retained episodes archive in `ChannelSnapshot.episodicMemory` via `channelStore`; restored on switch-back.
- Tests: `npx tsx src/lib/episodicMemory.test.ts` (22 deterministic checks: candidate formation, human-evidence guard, fusion, retention, fallback title/summary, retrieval, mutations, channel isolation).

### Spoken Callout Priority (`src/lib/spokenCallout.ts`, v29)
- **Voice priority substrate:** detects when the streamer verbally addresses a bot in the audio transcript ("Gremlin, what do you think?"). Direct address confirms and routes an immediate opportunity; third-person speech ("Gremlin said that earlier") is rejected.
- **Intent taxonomy:** `direct_question` (summons with question), `command_request` (imperative verb), `greeting` ("hey bot"), `negative_instruction` ("be quiet" — routes to restraint, never reply), `acknowledgment`, `generic_address`.
- **Anti-false-positive:** common-word names ("May", "can", "will") require strictly stronger vocative syntax; bot TTS echo suppression detects speech heard back through the microphone via Jaccard overlap (12s window); colliding aliases yield `ambiguous` (never routes arbitrarily).
- **Ensemble address:** "MADchatter" or syntax-gated "bots" targets all bots; routes to a single bot when only one is addressable.
- **Routing:** confirmed callouts dispatch `autoforge-force-check` with `detail: { botId, spokenCallout: true }`. Consumed on send via `spokenCallouts.consumeForBot(botId)` with response latency tracked for diagnostics. Repeats merge within 20s.
- **Channel safety:** engine is channel-scoped; channel switch resets active callout and echo buffer. Never persisted (reload = clean slate).
- Tests: `npx tsx src/lib/spokenCallout.test.ts` (36 deterministic checks: vocative syntax, negative suppression, echo protection, common-word penalties, ensemble, multi-bot, engine lifecycle, TTL expiry).

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

### Channel Learning (`src/lib/channelLearning.ts`, v27)
- **Closed feedback loop:** post-send engagement observations (D4) and silence decisions now feed a per-channel learning profile that AutoForge consumes as *advisory historical evidence*. Previously those signals terminated in `actionAccuracy` analytics.
- **Normalization (`computeNormalizedOutcome`):** outcome score ∈ [-1, +1] from human mentions of the bot (0.45), human reactions (0.2), and chat continuation measured **relative to the pre-send 60s baseline** (0.25) plus a mild ignore penalty (−0.2, only when an active room goes fully silent). Raw volume cannot masquerade as success — a 100 msg/min room continuing at pace scores ~neutral. Mention-response sends get a 0.7 mention discount (an active exchange already implies replies).
- **Bot attribution (`collectBotUsernames`):** every configured bot username (active or not — deactivated bots' earlier lines are still synthetic) plus the legacy session is excluded from human counts. Bot-to-bot replies structurally cannot reward each other (multi-bot false-reward prevention). Bot-only replies in an active room score *negative*.
- **Aggregation (`recordLearningOutcome` / `getLearnedActionStats`):** exponential decay (14-day half-life; 2-day recent half-life for trend), shrinkage toward neutral (`PRIOR_WEIGHT = 5` pseudo-samples), confidence = weight/(weight+prior). Minimum effective weight 3 (`MIN_EFFECTIVE_WEIGHT`) gates prompt injection — below it an action is informational only. Max 12 tracked action types (stale/renamed taxonomies pruned oldest-first).
- **Silence is first-class:** `computeSilenceOutcome` records *positive-only* restraint evidence (score capped +0.2, sample weight 0.3, at most one observation per 10 min via `shouldRecordSilenceObservation`) when the room stays organically healthy without the bot. No negative silence evidence is ever fabricated (counterfactuals are unknowable). Silence evidence can inform restraint but structurally cannot dominate send evidence.
- **Decision integration:** `buildSelfPerformanceContext()` renders the compact `[SELF-PERFORMANCE — HISTORICAL EVIDENCE FROM THIS CHANNEL]` block (only when some action is actionable — cold start omits it entirely, preserving existing behavior exactly). Injected via `AutoForgeParams.selfPerformanceContext` in both loops; `SELF_PERFORMANCE_PROMPT` (prompts.ts) fixes interpretation rules: never optimize for engagement, conversational obligations always win, low-sample actions stay eligible. `buildSessionGoalsContext()` renders bounded `[SESSION OBJECTIVES]` steering pressure from unmet enabled goals (null when all met).
- **Persistence (schema v27):** `learningProfiles: Record<normalizedChannel, ChannelLearningProfile>` + `adaptiveLearningEnabled` (default true) in `partialize`. Channel-scoped by key — A→B→A isolation is automatic, learning survives reloads, and the map is pruned to 30 channels by `lastUpdatedAt`. `clearAllContext` never wipes it (long-lived, keyed per channel — not session-scoped). Included in `exportSettings`/`importSettings` (sanitized per profile). Migration v27 seeds defaults; all persisted profiles pass through `sanitizeLearningProfile` (malformed data degrades to fresh).
- **Controls:** `recordLearningOutcome` (writes to the current channel's profile; no-op when no channel connected), `resetChannelLearning` (clears ONLY the current channel — memories/settings/other channels untouched, confirm-gated in UI), `setAdaptiveLearningEnabled(false)` = analytics-only mode (outcomes still collected, no prompt injection). All surfaced in the AnalyticsPanel "Channel Learning" section (status, per-action ↑/↓ with confidence, reset, toggle) + `channelLearning` diagnostics in the exported session report.
- **Multi-bot calibration:** the profile is channel-level (shared by all bots) — the room's tolerance is not bot-specific, and per-bot splits would fragment the evidence. All loops write to/read from the same channel entry.
- **Cost:** fully deterministic local computation — zero additional AI calls. The injected block is ~10 lines, only when evidence exists.
- **Session guards:** all scheduled observations (engagement checks + silence checks in both loops) capture a `SessionScope` at schedule time and discard the outcome if the channel switched during the 30s window — a pending observation from channel A can never train channel B's profile.
- Tests: `npx tsx src/lib/channelLearning.test.ts` (69 checks: cold start, min samples, gradual learning, outlier resistance, recency decay, busy-chat normalization, bot attribution, silence evidence, channel scoping, malformed data, goals pressure, diagnostics, bounded influence) and `npx tsx src/store.learning.test.ts` (23 checks: v26→v27 migration, channel isolation A→B→A, reset scoping, reload persistence, no-channel guard).

### Speaker Coordinator (`src/lib/botCoordinator.ts`)
- Singleton `botCoordinator`. `requestFloor(botId, candidate)` opens a 2.5s bid window; highest `confidence + personaFit * 0.001 + (isMentioned ? 0.15 : 0)` wins. 15s floor gap between speaks. Manual sends bypass the coordinator.
- `BotCandidate.isMentioned` gives mentioned bots a 0.15 bidding bonus so they win the floor over slightly-higher-confidence non-mentioned competitors.

### Rule Execution (`src/lib/ruleEngine.ts`)
- `fireRule` and `evaluateAllRules` capture session and bot identity before execution. Their shared batch guard remains invalid after channel/mode/identity round trips; checks surround delays and awaited actions. Subscriptions are disposed in `finally`.
- Both AutoForge callers recheck their own execution guard immediately after awaiting rules, before recording activity or events. Per-bot identity checks include platform, username, and user ID.
- Rules can intentionally toggle AutoForge and then perform another action (for example, the late-night preset's notification); the rule guard preserves this behavior. It does not reuse the AutoForge guard's master-enable requirement.
- `fired` means the rule was admitted and its fire count/cooldown consumed. Inspect `reason` and `actionsExecuted` for partial failure or cancellation. No-condition previews and execution both reject the rule.
- Rule delays now clear their timers on cancellation. The rule guard passes its signal into delivery; queued admission, rate waits, Twitch connection preparation, and Kick requests observe it. A write already handed to the network cannot be recalled. Completion/error toasts and subsequent rule actions are suppressed after invalidation.
- Regression harness: `node scripts/check-rule-engine.mjs` (19 scenarios, real store and session scope with local transport/audio/toast fakes); included in `npm test`.

### Send Path (`src/lib/platformSend.ts`)
- `getPlatformSendFn(platform, botId?)` — returns a send function. `botId` omitted = legacy singleton; provided = per-bot identity with independent rate limiter.
- The returned function accepts an optional third `AbortSignal`; existing two-argument calls remain valid. Each invocation also binds to its current session revision/platform, multi-bot mode, and sending identity. Store changes and same-tab/cross-tab identity events abort stale sends. Same-identity token refresh remains valid.
- `SendCancelledError` is intentional withdrawal, never an automatic retry signal. `sendCancellation.ts` owns cancellable preparation/delay helpers. Rate-wait cancellation clears timers and uses no additional attempt capacity. Caller cancellation can finish promptly while the ordered delivery tail still observes a non-abortable IRC write; confirmed success retains deduplication.
- Twitch connection/join preparation has an eight-second combined deadline, removes join listeners/timers on exit, and isolates retired clients from current connection state. Cancellation never triggers reply-to-plain-message fallback. Kick propagates signals through lookup, initial refresh, direct/proxy sends and refresh retry; cancellation stops fallback and credential writes. Joystick checks cancellation before queued WebSocket delivery.
- Both AutoForge loops pass their execution signals to immediate sends and suppress stale success/failure accounting. Deferred followups retain their captured scope and use the platform wrapper's session binding. The retry queue aborts its active run on clear and discards a cancelled ready batch rather than rescheduling it.
- Focused cancellation integration: `node scripts/check-send-cancellation.mjs` (22 scenarios with real managers/store/manual-send path and local I/O fakes). See `docs/SEND_CANCELLATION_REVIEW_2026-09-15.md` for verification and remote-delivery limits.
- `SendRateLimiter.sendWithRateLimit` serializes sends per manager, rechecks capacity after waits, reserves attempt capacity before delivery, and records duplicate history only after transport success. A rejected send releases the queue. Twitch, Kick, and Joystick all use this shared path; per-bot managers retain independent limits. Failed attempts consume capacity, and Kick's internal fallback/refresh requests remain within one logical send attempt.
- `sendManualMessage` checks the captured session revision/platform/channel and selected bot identity before applying completion history, statistics, events, and onboarding. Stale completion is ignored locally; this does not cancel an already-started transport. Real manual sends count toward onboarding even when AutoForge Dry Run is enabled; explicit dry-run sends do not.
- Focused checks: `node --import tsx src/lib/rateLimiter.test.ts`, `node scripts/check-manual-send.mjs`, `node scripts/check-platform-send.mjs`.

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
- **Emote policy:** Bots use TEXT-based platform emotes (Twitch native or BTTV/7TV/FFZ emote NAMES like "POG", "LUL", "KEKW") — never actual Unicode emoji characters (😂 💀 🔥), which render inconsistently and mark the sender as a bot. All three system prompts (Forge, AutoForge, Refine) carry an `EMOTE POLICY` rule to this effect; the `emote_only` examples are text emote names (also mirrored in `server.ts`'s prompt copy). Output hardening: `stripEmojis()` (`src/lib/textSanitize.ts`) removes emoji glyphs from Forge suggestion messages, refined messages, and AutoForge `action_payload` (alongside `stripEmDashes`). The glyph table (`EMOJI_GLYPH_REGEX`) is the single source of truth — `tts.ts`'s speech cleaner imports it rather than keeping its own drifting copy. Tests: `npx tsx src/lib/emojiSanitize.test.ts`.

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

### Multi-Bot panel position memory
- The header-draggable `MultiBotPanel` persists its drag offset (module cache + localStorage key `madchatter-multibot-panel-pos`, viewport-clamped on restore), so hide→show and reloads reopen the panel where the user left it.
- **No bot-profile snapshot system.** A previous attempt (`BotProfile` / `applyBotProfile`, schema v31) was rejected and reverted: rebuilding the roster with `session: null` dropped live authentications. Any future roster-swap feature MUST preserve bot sessions.

### Core Mode + Interactive Launchpad (v1.0.7)
- **Two interface-density modes:** `interfaceMode: 'core' | 'studio'` — one authoritative mode drives presentation density. Core = minimal operational surface (connect, AI, personality, Forge, send, AutoForge, chat). Studio = the existing full-density experience. Mode changes presentation only, never engine behavior or config.
- **`useCoreReadiness()` hook** (`src/hooks/useCoreReadiness.ts`) — derives Launchpad readiness from real application state. Stages: Platform → AI → Personality → Forge → Send → AutoForge → Operational. Each stage derives from source-of-truth state (channel + chat connection, provider config + first Forge, active profiles, persisted milestones). AutoForge is optional — operational = Platform + AI + Personality + Forge + Send. Readiness policy is in `src/lib/coreReadiness.ts`: selected-provider configuration and cooldown plus actual connected chat determine live availability; historical milestones preserve workspace presentation without implying a live session. Provider keys and health are observed via `useSyncExternalStore` (the shared 1s clock in `useNowTick.ts`), same-tab auth ticks, and cross-tab storage events. Regression tests: `npx tsx src/lib/coreReadiness.test.ts` and `npx tsx src/lib/ollamaHealth.test.ts`.
- **`CoreMode.tsx`** (`src/components/CoreMode.tsx`) — exports `CoreTuningControls` (persona grid, humor/chaos sliders, Forge button, AutoForge toggle, Advanced disclosure), `CoreLaunchpad` (readiness bar + expandable stage details + Studio discovery), `InterfaceModeToggle` (header `[ CORE ] [ STUDIO ]` toggle), and `CoreActivationCelebration` (one-shot "MADchatter is live" overlay).
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
- **UI clocks (`src/hooks/useNowTick.ts`)** — every relative-time label ("12s ago", "Next check in 42s", "Session 3m 20s") reads ONE refcounted 1s interval instead of owning its own. Never add a new `setInterval(() => setNow(Date.now()), 1000)`. `useNowTick()` re-renders the caller once per second; `useNowTick(enabled)` drops the subscription while the flag is false, so a closed panel owns no timer (but do not read the returned value as an exact `Date.now()` in that state — it is the last cached tick). Active consumers share one snapshot; React commit counts depend on scheduling and are not guaranteed. Joining an active clock preserves that snapshot, and each subscription owns independent, idempotent cleanup. Non-React polling uses `subscribeSecondTick()` directly. Regression test: `npx tsx src/hooks/useNowTick.test.ts`.
- **Dead code** — delete it rather than leaving a module that only its own test imports. A pure module with no production consumer is a false promise to the next contributor.
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
| `src/hooks/useNowTick.ts` | The app's single shared 1s clock (useNowTick / subscribeSecondTick) |
| `src/hooks/useNowTick.test.ts` | Shared clock regression suite (run: `npx tsx src/hooks/useNowTick.test.ts`) |
| `src/lib/sentiment.test.ts` | Sentiment classifier tests (run: `npx tsx src/lib/sentiment.test.ts`) |
| `src/lib/autoForgeCore.test.ts` | AutoForge core computation tests (run: `npx tsx src/lib/autoForgeCore.test.ts`) |
| `src/lib/antiRepetition.test.ts` | Anti-repetition + Jaccard dedup tests (run: `npx tsx src/lib/antiRepetition.test.ts`) |
| `src/lib/chatStyle.test.ts` | Chat style analyzer tests (run: `npx tsx src/lib/chatStyle.test.ts`) |
| `src/lib/personalityEngine.test.ts` | Personality engine tests (run: `npx tsx src/lib/personalityEngine.test.ts`) |
| `src/lib/memoryRetrieval.test.ts` | Memory retrieval + director notes tests (run: `npx tsx src/lib/memoryRetrieval.test.ts`) |
| `src/lib/botCoordinator.test.ts` | Bot coordinator tests (run: `npx tsx src/lib/botCoordinator.test.ts`) |
| `src/lib/ollamaHealth.ts` | Ollama endpoint/model reachability check |
| `src/lib/visionProvider.ts` | Independent vision provider resolver (text/ollama split routing) |
| `src/lib/visionProvider.test.ts` | Vision provider tests (run: `npx tsx src/lib/visionProvider.test.ts`) |
| `src/lib/prompts.ts` | System prompts (Forge, AutoForge, R34L, memory) |
| `src/lib/keys.ts` | Provider keys, `openAiCompatEndpoint()` |
| `src/lib/chatStyle.ts` | Chat style analysis for R34L adaptation |
| `src/lib/emotes.ts` | 7TV/FFZ/BTTV emote fetching, parsing, tagged names for AI prompt |
| `src/lib/botCoordinator.ts` | Multi-bot speaker floor (mention-priority bidding) |
| `src/lib/autoForgeCore.ts` | Shared AutoForge computation (activity, engagement, health, goals, vibe check, adaptive backoff, dedup) |
| `src/lib/channelLearning.ts` | Channel learning feedback loop (normalized outcomes, decayed/shrunk per-channel profiles, self-performance + goals prompt blocks) |
| `src/lib/channelLearning.test.ts` | Channel learning test suite (run: `npx tsx src/lib/channelLearning.test.ts`) |
| `src/store.learning.test.ts` | Channel learning store integration tests (run: `npx tsx src/store.learning.test.ts`) |
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
| `src/lib/trial.ts` | Friend Trial frontend client (session mgmt, fetch override, Turnstile integration) |
| `src/lib/trial.test.ts` | Friend Trial frontend tests (run: `npx tsx src/lib/trial.test.ts`) |
| `workers/friend-trial/` | Cloudflare Worker for Friend Trial (server-held Groq key, Turnstile, rate limits) |

## Friend Trial (v30 — Worker-backed trial access)

A Cloudflare Worker (`workers/friend-trial/`) gives invited users temporary
MADchatter access through a server-held Groq API key, without requiring them to
bring their own key. The Groq credential never leaves Worker secret storage.

### Architecture
```
MADchatter (Neocities) ──HTTPS──▶ Cloudflare Worker ──GROQ_API_KEY──▶ Groq
```

### Provider integration
- `TRIAL_PROVIDER = "trial"` is added to `OPENAI_COMPATIBLE_PROVIDERS` in
  `keys.ts`, so it flows through every existing OpenAI-compatible call site in
  `ai.ts` (Forge, AutoForge, smart replies, memory, briefings, etc.) via the
  `providerFetchOverride()` helper — no parallel AI stack.
- `createTrialFetch()` (in `trial.ts`) intercepts `/chat/completions` requests
  and rewrites them to the Worker's `POST /trial/chat` with the trial session
  token as `Authorization: Bearer <token>`. The Worker returns an
  OpenAI-compatible response, so the existing pipeline parses it unchanged.
- The trial session token (a disposable HMAC credential, NOT the Groq key)
  lives in `sessionStorage`. `getApiKey("trial")` returns it when valid.
- Trial is text-only: `createTrialFetch()` strips image parts from multimodal
  content; `generateChat` also strips the screenshot when `rawProvider ===
  TRIAL_PROVIDER`. The Worker rejects multimodal content as defense-in-depth.

### BYOK preservation
- Trial never reads or overwrites the user's own provider keys.
- `hasAnyApiKey()` / `getProviderWithKey()` include trial only when a valid
  session exists; BYOK providers are unaffected.
- Disabling trial (kill switch / expiry) clears the session and falls back to
  BYOK if a key is configured.

### Worker security model
- `GROQ_API_KEY`, `TURNSTILE_SECRET_KEY`, `TRIAL_SESSION_SECRET` are Worker
  secret bindings only — never in source, config, frontend, or git.
- The Worker constructs the upstream payload from an explicit input allowlist;
  the client cannot control upstream URL, model, Authorization header, or
  token ceiling.
- Turnstile is validated server-side via Cloudflare's siteverify flow.
- Stateless HMAC-signed session tokens (Web Crypto), short-lived, verified on
  every inference request.
- Rate limiting via Cloudflare native bindings (per-IP bootstrap, per-session
  + per-IP inference).
- Upstream errors are sanitized — raw provider bodies never relayed.
- Strict CORS (exact origin, `Vary: Origin`, no `*`) — not the primary boundary.

### Store integration
- `trialTick` (runtime-only, not persisted) bumps on session create/clear/expire
  so `useCoreReadiness` and `SettingsPanel` re-evaluate trial readiness.
- `trialStatus` (runtime-only) caches the Worker's `/trial/status` response.

### Tests
- Worker: `cd workers/friend-trial && npm test` (39 tests, mocked upstream).
- Frontend: `npx tsx src/lib/trial.test.ts` (22 tests, mocked fetch).
- Both use placeholder values only — no real secrets.

### Deployment
See `workers/friend-trial/README.md` for full deployment instructions.
