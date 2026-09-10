# MADchatter Component Index

**Commit:** 7327dd3 | **Date:** 2026-09-08 | **Auditor:** GLM-5.2 High

---

## UI Components (MC-UI)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-UI-001 | ForgeLayout | UI | Presentation | Main dashboard layout; mounts TheForge, TuningDeck, stream embed, capture, memory widgets | `src/components/ForgeLayout.tsx` | Integrated | 70% |
| MC-UI-002 | TheForge | UI | Presentation | Core forge/suggestion display area with send/refine | `src/components/TheForge.tsx` | Integrated | 65% |
| MC-UI-003 | TuningDeck | UI | Presentation | Control deck: profile sliders, AI provider, persona, capture toggles, forge trigger | `src/components/TuningDeck.tsx` | Integrated | 65% |
| MC-UI-004 | VariantCard | UI | Presentation | Renders one generated suggestion with refine/send/copy | `src/components/VariantCard.tsx` | Integrated | 70% |
| MC-UI-005 | MemoryPanel | UI | Presentation | Long-term memory/profile/joke management UI | `src/components/MemoryPanel.tsx` | Integrated | 55% |
| MC-UI-006 | AutoForgeHUD | UI | Presentation | Draggable AutoForge decision HUD with live metrics | `src/components/AutoForgeHUD.tsx` | Integrated | 60% |
| MC-UI-007 | AutoForgeReport | UI | Presentation | AutoForge event/decision report panel | `src/components/AutoForgeReport.tsx` | Integrated | 55% |
| MC-UI-008 | AnalyticsPanel | UI | Presentation | Session analytics display with charts | `src/components/AnalyticsPanel.tsx` | Integrated | 55% |
| MC-UI-009 | ActionTimeline | UI | Presentation | Timeline of AutoForge actions | `src/components/ActionTimeline.tsx` | Integrated | 50% |
| MC-UI-010 | StatusBar | UI | Presentation | Connection/sentiment/stats bar | `src/components/StatusBar.tsx` | Integrated | 65% |
| MC-UI-011 | StreamEmbed | UI | Presentation | Embedded Twitch stream iframe | `src/components/StreamEmbed.tsx` | Integrated | 50% |
| MC-UI-012 | StreamOverlay | UI | Presentation | Overlay over stream embed | `src/components/StreamOverlay.tsx` | Integrated | 45% |
| MC-UI-013 | EmoteText | UI | Presentation | Render emote images inline in chat text | `src/components/EmoteText.tsx` | Integrated | 60% |
| MC-UI-014 | SettingsPanel | UI | Presentation | Full settings modal (API keys, TTS, sound, auth) | `src/components/SettingsPanel.tsx` | Integrated | 60% |
| MC-UI-015 | CommandPalette | UI | Presentation | Ctrl+K command palette (inline in App.tsx) | `src/App.tsx` | Integrated | 65% |
| MC-UI-016 | WelcomeOverlay | UI | Presentation | First-load welcome screen | `src/components/WelcomeOverlay.tsx` | Integrated | 50% |
| MC-UI-017 | TutorialWalkthrough | UI | Presentation | Guided onboarding steps | `src/components/TutorialWalkthrough.tsx` | Integrated | 55% |
| MC-UI-018 | ShortcutHelp | UI | Presentation | Keyboard shortcut help panel | `src/components/ShortcutHelp.tsx` | Integrated | 50% |
| MC-UI-019 | AnimatedBackground | UI | Presentation | Default animated background | `src/components/AnimatedBackground.tsx` | Integrated | 50% |
| MC-UI-020 | CosmoTechBackground | UI | Presentation | CosmoTech theme background | `src/components/CosmoTechBackground.tsx` | Integrated | 50% |
| MC-UI-021 | EasterEggs | UI | Presentation | Easter-egg triggers (konami, rage) | `src/components/EasterEggs.tsx` | Integrated | 50% |
| MC-UI-022 | RageCursor | UI | Presentation | Rage-themed cursor effect | `src/components/RageCursor.tsx` | Integrated | 45% |
| MC-UI-023 | FidgetSpinner | UI | Presentation | Fidget spinner widget/easter egg | `src/components/FidgetSpinner.tsx` | Integrated | 45% |
| MC-UI-024 | ErrorBoundary | UI | Presentation | React error boundary | `src/components/ErrorBoundary.tsx` | Integrated | 50% |
| MC-UI-025 | shadcn Primitives | UI | Presentation | Badge, Button, Card, Command, Dialog, Input, etc. | `src/components/ui/*.tsx` (14 files) | Integrated | 80% |

## AI / Forge Components (MC-AI)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-AI-001 | Forge Engine (Client) | Domain Logic | Domain | Generate chat variants via Gemini/OpenAI/Claude/OpenRouter | `src/lib/ai.ts` (`generateChat`) | Integrated | 55% |
| MC-AI-002 | Forge Engine (Server) | Server | Server | Server-side mirror of Forge generation | `server.ts` (`/api/generate-chat`) | Partial | 45% |
| MC-AI-003 | Variant Refinement (Client) | Domain Logic | Domain | Refine a single suggestion by type/instruction | `src/lib/ai.ts` (`refineSuggestion`) | Integrated | 50% |
| MC-AI-004 | Variant Refinement (Server) | Server | Server | Server-side mirror of refinement | `server.ts` (`/api/refine-suggestion`) | Partial | 45% |
| MC-AI-005 | AutoForge Decision Engine | Domain Logic | Domain | AI decides action type, confidence, payload | `src/lib/ai.ts` (`autoforgeDecide`) | Integrated | 55% |
| MC-AI-006 | AutoForge Decision (Server) | Server | Server | Server-side mirror of AutoForge decision | `server.ts` (`/api/autoforge-decide`) | Partial | 45% |
| MC-AI-007 | Vision Context Generator | Domain Logic | Domain | Describe screenshots via AI vision | `src/lib/ai.ts` (`generateVisionContext`, `visionRequest`) | Integrated | 50% |
| MC-AI-008 | Vision Context (Server) | Server | Server | Server-side mirror of vision | `server.ts` (`/api/vision`) | Partial | 45% |
| MC-AI-009 | AutoForge Briefing | Domain Logic | Domain | Generate after-action narrative from event log | `src/lib/ai.ts` (`generateAutoForgeBriefing`) | Partial | 35% |
| MC-AI-010 | Prompt Constants | Domain Logic | Domain | System prompts for Forge, AutoForge, Refine, Memory, R34L | `src/lib/prompts.ts` | Integrated | 60% |
| MC-AI-011 | Prompt Constants (Server) | Server | Server | Duplicated prompt constants in server | `server.ts` (inline) | Partial | 55% |
| MC-AI-012 | Provider Fallback | Domain Logic | Domain | Health tracking, cooldown, fallback chain | `src/lib/providerFallback.ts` | Integrated | 55% |
| MC-AI-013 | Smart Replies | Domain Logic | Domain | AI-generated reply suggestions for mentions | `src/lib/smartReplies.ts` | Partial | 40% |
| MC-AI-014 | Memory Extraction | Domain Logic | Domain | AI-driven memory/profile/joke extraction from chat | `src/lib/memoryEngine.ts` (`extractMemories`) | Partial | 45% |
| MC-AI-015 | Memory Retrieval | Domain Logic | Domain | Score/rank memories by relevance, format context | `src/lib/memoryRetrieval.ts` | Integrated | 55% |
| MC-AI-016 | Personality Engine | Domain Logic | Domain | Mood/comfort/trait evolution across sessions | `src/lib/personalityEngine.ts` | Partial | 40% |
| MC-AI-017 | Joke Engine | Domain Logic | Domain | Inside-joke lifecycle (usage, boost, retire) | `src/lib/jokeEngine.ts` | Partial | 40% |

## Auth Components (MC-AUTH)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-AUTH-001 | Twitch Auth (Client) | Platform Adapter | Adapter | Implicit OAuth flow, token validation, session storage | `src/hooks/useTwitchAuth.ts`, `src/lib/twitch.ts` | Integrated | 45% |
| MC-AUTH-002 | Twitch Auth (Server) | Server | Server | Authorization-code flow with cookie session | `server.ts` (`/auth/callback`, `/api/auth/twitch/url`) | Partial | 40% |
| MC-AUTH-003 | Kick Auth | Platform Adapter | Adapter | OAuth 2.1 + PKCE via Cloudflare proxy | `src/hooks/useKickAuth.ts`, `src/lib/kick.ts` | Integrated | 55% |
| MC-AUTH-004 | Joystick Auth | Platform Adapter | Adapter | OAuth code flow via proxy, JWT decode | `src/hooks/useJoystickAuth.ts`, `src/lib/joystick.ts` | Integrated | 50% |
| MC-AUTH-005 | API Key Management | Platform Adapter | Adapter | localStorage-based API key storage/retrieval | `src/lib/keys.ts` | Integrated | 40% |
| MC-AUTH-006 | Server Session Store | Server | Server | In-memory session map with cookie auth | `server.ts` (`twitchSessions`, `getSessionId`) | Partial | 30% |

## Chat Platform Components (MC-CHAT)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-CHAT-001 | Twitch Chat Read | Platform Adapter | Adapter | tmi.js read client, message ingestion | `src/App.tsx`, `src/lib/twitch.ts` | Integrated | 60% |
| MC-CHAT-002 | Twitch Chat Send | Platform Adapter | Adapter | Persistent TMI send manager with rate limit + dedup | `src/lib/twitch.ts` (`TmiSendManager`, `SendGuard`) | Integrated | 60% |
| MC-CHAT-003 | Kick Chat Read | Platform Adapter | Adapter | Pusher WebSocket chat client with reconnect | `src/lib/kick.ts` (`KickChatClient`) | Integrated | 55% |
| MC-CHAT-004 | Kick Chat Send | Platform Adapter | Adapter | REST API send with token refresh + proxy fallback | `src/lib/kick.ts` (`KickSendManager`) | Integrated | 55% |
| MC-CHAT-005 | Joystick Chat Read | Platform Adapter | Adapter | ActionCable WebSocket chat client | `src/lib/joystick.ts` (`JoystickChatClient`) | Integrated | 50% |
| MC-CHAT-006 | Joystick Chat Send | Platform Adapter | Adapter | WebSocket-based send via chat client | `src/lib/joystick.ts` (`JoystickSendManager`) | Integrated | 45% |
| MC-CHAT-007 | Platform Send Dispatch | Platform Adapter | Adapter | Route send to correct platform | `src/lib/platformSend.ts` | Integrated | 55% |
| MC-CHAT-008 | Message Queue | Domain Logic | Domain | Retrying outbound message queue | `src/lib/messageQueue.ts` | Stubbed | 15% |
| MC-CHAT-009 | Send Rate Limiter | Platform Adapter | Adapter | Sliding-window + dedup base class | `src/lib/rateLimiter.ts` | Integrated | 60% |
| MC-CHAT-010 | Action Rate Limiter | Domain Logic | Domain | AutoForge per-hour/10-min/cooldown limits | `src/lib/actionRateLimiter.ts` | Integrated | 55% |
| MC-CHAT-011 | Chat Ingestion Pipeline | Hook | Hook | Message → sentiment → activity → chatter stats → triggers | `src/App.tsx` (`processIncomingMessage`) | Integrated | 55% |
| MC-CHAT-012 | Emote System | Domain Logic | Domain | 7TV/FFZ emote fetching and text parsing | `src/lib/emotes.ts` | Integrated | 55% |
| MC-CHAT-013 | Sentiment Analysis | Domain Logic | Domain | Rule-based chat sentiment classification | `src/lib/sentiment.ts` | Integrated | 55% |
| MC-CHAT-014 | Anti-Repetition | Domain Logic | Domain | Track sent messages, detect overused patterns | `src/lib/antiRepetition.ts` | Integrated | 50% |

## Memory Components (MC-MEM)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-MEM-001 | Memory Store | Persistence | Persistence | IndexedDB CRUD for memories, profiles, jokes, personality | `src/lib/memoryStore.ts` | Integrated | 55% |
| MC-MEM-002 | Auto-Memory Hook | Hook | Hook | Periodic extraction/decay loop, IndexedDB hydration | `src/hooks/useAutoMemory.ts` | Integrated | 45% |
| MC-MEM-003 | Memory Decay | Domain Logic | Domain | Strength decay, pruning, profile cleanup | `src/lib/memoryEngine.ts` (`runDecayCycle`) | Partial | 40% |
| MC-MEM-004 | Pinned/Golden Memory | State | State | User-curated long-term context anchors | `src/store.ts` | Integrated | 55% |

## Audio / Voice Components (MC-AUDIO)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-AUDIO-001 | Deepgram Transcription | Hook | Hook | Real-time WebSocket transcription | `src/hooks/useDeepgramTranscription.ts` | Integrated | 50% |
| MC-AUDIO-002 | Whisper Fallback | Domain Logic | Domain | Local Whisper ASR via transformers.js | `src/lib/whisper.ts` | Partial | 40% |
| MC-AUDIO-003 | Push-to-Talk | Hook | Hook | Mic capture + Whisper transcription | `src/hooks/usePushToTalk.ts` | Integrated | 45% |
| MC-AUDIO-004 | Voice Commands | Hook | Hook | VAD-based voice command capture + dispatch | `src/hooks/useVoiceCommands.ts` | Integrated | 45% |
| MC-AUDIO-005 | Voice Command Parser | Domain Logic | Domain | Pattern matching for voice commands | `src/lib/voiceCommands.ts` | Integrated | 45% |
| MC-AUDIO-006 | TTS Engine | Domain Logic | Domain | Web Speech + ElevenLabs TTS | `src/lib/tts.ts` | Integrated | 50% |
| MC-AUDIO-007 | Sound Effects | Domain Logic | Domain | Synthesized UI SFX | `src/lib/sfx.ts` | Integrated | 55% |
| MC-AUDIO-008 | Message Sound | Domain Logic | Domain | MP3 message notification sound | `src/lib/sound.ts` | Integrated | 55% |
| MC-AUDIO-009 | Frame Diff | Domain Logic | Domain | Canvas-based visual change detection | `src/lib/frameDiff.ts` | Integrated | 55% |

## Infrastructure Components (MC-INFRA)

| ID | Name | Category | Layer | Purpose | Primary Files | Status | Completion |
|---|---|---|---|---|---|---|---|
| MC-INFRA-001 | Zustand Store | State | State | Global state with localStorage persistence | `src/store.ts` | Integrated | 65% |
| MC-INFRA-002 | Express Server | Server | Server | API server, OAuth, AI proxy, static hosting | `server.ts` | Partial | 45% |
| MC-INFRA-003 | Cloudflare Kick Proxy | Server | Edge | Kick CORS proxy (token, refresh, chat, channel) | `cloudflare-worker/kick-token-proxy.js` | Integrated | 50% |
| MC-INFRA-004 | Cloudflare Joystick Proxy | Server | Edge | Joystick CORS proxy (token, refresh, channel, bot) | `cloudflare-worker/joystick-token-proxy.js` | Integrated | 50% |
| MC-INFRA-005 | Deno Kick Proxy | Server | Edge | Alternative Kick proxy (Deno Deploy) | `deno/kick-proxy.js`, `deno/kick-proxy.ts` | Partial | 40% |
| MC-INFRA-006 | Vite Build | Config | Config | Client build configuration | `vite.config.ts` | Integrated | 55% |
| MC-INFRA-007 | Notifications | Domain Logic | Domain | Browser Notification wrappers | `src/lib/notifications.ts` | Integrated | 50% |
| MC-INFRA-008 | TypeScript Config | Config | Config | TS compile options, path aliases | `tsconfig.json` | Integrated | 70% |
| MC-INFRA-009 | Tailwind/shadcn Config | Config | Config | Styling system configuration | `components.json`, `src/index.css` | Integrated | 70% |
| MC-INFRA-010 | OAuth Callback Pages | Config | Config | Static HTML callback pages for auth flows | `public/auth-callback.html`, `public/kick-auth-callback.html`, `public/joystick-auth-callback.html` | Integrated | 45% |
| MC-INFRA-011 | Legal Pages | Config | Config | Privacy policy and terms of service | `public/privacy.html`, `public/terms.html` | Integrated | 50% |

## Summary

| Category | Count | Integrated | Partial | Stubbed |
|---|---|---|---|---|
| UI | 25 | 25 | 0 | 0 |
| AI/Forge | 17 | 7 | 10 | 0 |
| Auth | 6 | 4 | 2 | 0 |
| Chat | 14 | 12 | 1 | 1 |
| Memory | 4 | 3 | 1 | 0 |
| Audio/Voice | 9 | 8 | 1 | 0 |
| Infrastructure | 11 | 9 | 2 | 0 |
| **Total** | **86** | **68** | **17** | **1** |
