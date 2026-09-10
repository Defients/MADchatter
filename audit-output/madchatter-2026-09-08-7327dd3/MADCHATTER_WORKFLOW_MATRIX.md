# MADchatter Workflow Trace Matrix

**Commit:** 7327dd3 | **Date:** 2026-09-08 | **Auditor:** GLM-5.2 High

---

## WF-001: Cold Start / Hydration

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | Browser | `index.html` | Loads SPA shell | - | VERIFIED |
| 2. Mount | main.tsx | `src/main.tsx:9-18` | Renders App in StrictMode + ErrorBoundary + TooltipProvider + Toaster | - | VERIFIED |
| 3. Store hydration | Zustand persist | `src/store.ts:276-989` | Loads `madchatter-storage` from localStorage; migration v7 | Restored config/memories/settings | VERIFIED |
| 4. Memory hydration | useAutoMemory | `src/hooks/useAutoMemory.ts:39-85` | Loads IndexedDB memories/profiles/jokes/personality independently | Dual hydration path | VERIFIED |
| 5. Timer reset | useAutoMemory | `src/hooks/useAutoMemory.ts:32-33` | `lastExtractionRef`/`lastDecayRef` reset to Date.now() on mount | Timers restart regardless of persisted state | VERIFIED |
| 6. Joystick global | App.tsx | `src/App.tsx:62-64` | `window.__joystickChatClient` assigned in no-deps effect | Runs every render; can be null | VERIFIED |
| 7. SFX init | App.tsx | `src/App.tsx:114-122` | Audio context on first click/keydown; listeners removed after | - | VERIFIED |

**Gaps:** Dual hydration (Zustand + IndexedDB) with no coordination; timer reset ignores persisted state.

---

## WF-002: Twitch Chat Connection

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | App.tsx effect | `src/App.tsx:188-330` | Depends on `channelName` + `platform` | - | VERIFIED |
| 2. Client creation | tmi.Client | `src/App.tsx:280-318` | `reconnect: true`, joins `[channel]` | - | VERIFIED |
| 3. Deferred connect | setTimeout 100ms | `src/App.tsx:307-308` | Avoids StrictMode double-mount | - | VERIFIED |
| 4. Ref assignment | tmiClientRef | `src/App.tsx:311` | Set inside timer callback | Ref is null before timer fires | VERIFIED |
| 5. Message handler | onMessage | `src/App.tsx:288-293` | Appends to chatLog, increments messagesReceived, calls processIncomingMessage | - | VERIFIED |
| 6. Connection events | connected/disconnected | `src/App.tsx:302-304` | Updates tmiReadState, plays SFX | - | VERIFIED |
| 7. Ban/timeout | ban/timeout events | `src/App.tsx:296-301` | Calls markUserBanned | - | VERIFIED |
| 8. Cleanup | effect cleanup | `src/App.tsx:320-327` | Disconnects client if ref is set | Misses client if timer hasn't fired | VERIFIED |

**Gaps:** Ref not set before timer → cleanup can miss half-connected client; `connect().catch()` only sets error state, doesn't tear down.

---

## WF-003: Chat Ingestion → Sentiment → Memory → Display

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | onMessage callback | `src/App.tsx:142-185` | processIncomingMessage called (not awaited) | - | VERIFIED |
| 2. Sentiment | classifySentiment | `src/lib/sentiment.ts:89-136` | Returns label + score | - | VERIFIED |
| 3. Sentiment store | addSentimentReading | `src/App.tsx:146` | Pushes to sentimentHistory (capped 100) | - | VERIFIED |
| 4. Activity | recordChatActivity | `src/App.tsx:148` | Updates heatmap | - | VERIFIED |
| 5. Chatter stats | updateChatterStats | `src/App.tsx:150-152` | Per-user leaderboard, mention flag | - | VERIFIED |
| 6. Bot username | window globals | `src/App.tsx:150` | Reads `window.__kickSession`/`__joystickSession`/`__twitchSession` | Globals may not exist → isMention always false | VERIFIED |
| 7. Keyword triggers | keywordTriggerRules | `src/App.tsx:154-183` | Toast/notify/sound/force AutoForge | Invalid regex silently caught | VERIFIED |
| 8. Force AutoForge | autoforge-force-check | `src/App.tsx:183` | Dispatches event even if AutoForge disabled | useAutoForge guard silently no-ops | VERIFIED |

**Gaps:** Bot username from window globals (may not exist); regex errors silently caught; force-check dispatched even when disabled.

---

## WF-004: Manual Forge

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | F key / palette / button | `TuningDeck.tsx:271-278`, `TheForge.tsx:89-166` | forge-trigger event | - | VERIFIED |
| 2. Guard | isForging | Both files | Checks store guard | - | VERIFIED |
| 3. Context build | memory/sentiment/anti-rep | `TheForge.tsx:89-166` | Builds context for prompt | - | VERIFIED |
| 4. AI call | generateChat | `src/lib/ai.ts` | Calls active provider with fallback | - | VERIFIED |
| 5. Parse | JSON.parse | `src/lib/ai.ts:300` | No schema validation | - | VERIFIED |
| 6. Variants | setVariants | `TheForge.tsx` | Replaces variants array | - | VERIFIED |
| 7. Auto-send (TuningDeck) | setTimeout 1500ms | `TuningDeck.tsx:348-367` | Dispatches autoforge-send-message | Timer not cleared on unmount | VERIFIED |
| 8. Pre-record (TuningDeck) | incrementForgeCount + addSentMessage | `TuningDeck.tsx:344-367` | Records analytics BEFORE send resolves | Inflated stats | VERIFIED |

**Gaps:** Two divergent handleForge implementations; TuningDeck pre-records analytics; setTimeout not cleared on unmount.

---

## WF-005: AutoForge Decision Loop

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | 15s interval | `useAutoForge.ts:633-639` | checkAutoForge() | - | VERIFIED |
| 2. Guard | autoForgeEnabled/isForging | `useAutoForge.ts:94` | Skip if disabled or forging | - | VERIFIED |
| 3. Schedule check | autoForgeNextActionMs | `useAutoForge.ts:97` | Skip if before next action time | - | VERIFIED |
| 4. API key check | getApiKey/hasAnyApiKey | `useAutoForge.ts:100-114` | Skip if no key (silent) | Missing-key errors suppressed | VERIFIED |
| 5. Activity calc | chatVelocity/activityLevel | `useAutoForge.ts:116-134` | From message counter delta | - | VERIFIED |
| 6. Mention detect | chatLog + audioTranscript | `useAutoForge.ts:136-173` | Pattern match on bot username | - | VERIFIED |
| 7. Engagement score | composite metric | `useAutoForge.ts:179-198` | velocity/sentiment/diversity/recency | - | VERIFIED |
| 8. Offline detect | viewerCount + no chat | `useAutoForge.ts:200-209` | Skip if likely offline | - | VERIFIED |
| 9. Memory context | retrieveRelevantMemories | `useAutoForge.ts:268-288` | If auto-memory enabled | - | VERIFIED |
| 10. Rate limit | actionRateLimiter.canAct() | `useAutoForge.ts:300-305` | Skip if rate limited | - | VERIFIED |
| 11. AI decision | autoforgeDecide | `useAutoForge.ts:309-333` | Calls AI with full context | - | VERIFIED |
| 12. Force override | deliberate_silence → full_forge | `useAutoForge.ts:370-374` | If force=true | - | VERIFIED |
| 13. Confidence gate | threshold check | `useAutoForge.ts:377-389` | Downgrade to silence if below | confidence not validated as number | VERIFIED |
| 14. Dry run | log only | `useAutoForge.ts:392-407` | No send; but full_forge still dispatches forge-trigger | Dry-run can still trigger send via TuningDeck | VERIFIED |
| 15. Dedup guard | sentMessages.slice(-15) | `useAutoForge.ts:410-423` | Downgrade to silence if duplicate | - | VERIFIED |
| 16a. full_forge | forge-trigger event | `useAutoForge.ts:425-448` | Dispatches event; records action immediately | - | VERIFIED |
| 16b. short_reaction/emote/joke | sendFn (not awaited) | `useAutoForge.ts:449-505` | Sends + records success before resolution | Inflated stats on failure | VERIFIED |
| 16c. quick_followup | setTimeout | `useAutoForge.ts:506-551` | Delayed send + records success before resolution | Same inflation | VERIFIED |
| 16d. silence/observation | log only | `useAutoForge.ts:552-561` | No action | - | VERIFIED |
| 17. Goal eval | sessionGoals | `useAutoForge.ts:564-601` | Evaluate progress | - | VERIFIED |
| 18. Schedule next | estimated_next_action_minutes | `useAutoForge.ts:604-609` | Set next action time | - | VERIFIED |
| 19. Error | catch block | `useAutoForge.ts:611-630` | Suppress missing-key errors; backoff 60s | - | VERIFIED |

**Gaps:** Send not awaited → bookkeeping before side effects; dry-run full_forge still triggers send; confidence not type-validated; missing-key errors suppressed.

---

## WF-006: Provider Selection → Fallback

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Active provider | getActiveProvider | `src/lib/keys.ts:80-82` | localStorage `active_api_provider` | - | VERIFIED |
| 2. Key lookup | getApiKey | `src/lib/keys.ts:55-64` | Normalizes gemini-pro→gemini, anthropic→claude | - | VERIFIED |
| 3. Fallback chain | getHealthyFallbackChain | `src/lib/providerFallback.ts:82-85` | Filters by health + key availability | Can return empty array | VERIFIED |
| 4. Provider call | ai.ts | `src/lib/ai.ts:653-713` | Iterate chain; on failure, record + try next | - | VERIFIED |
| 5. Health tracking | recordProviderFailure/Success | `src/lib/providerFallback.ts:55-70` | 3 failures → 5min cooldown | In-memory only | VERIFIED |
| 6. JSON parse | cleanJsonStr + JSON.parse | `src/lib/ai.ts:300,480,702` | No schema validation | - | VERIFIED |

**Gaps:** Empty fallback chain → misleading "No API key" error; health resets on reload; no schema validation.

---

## WF-007: Kick Auth → Connect → Send

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. OAuth start | useKickAuth | `useKickAuth.ts:87-130` | PKCE + state, proxy exchange | - | VERIFIED |
| 2. Token exchange | Cloudflare proxy | `cloudflare-worker/kick-token-proxy.js:147-179` | Exchanges code for token | CORS * | VERIFIED |
| 3. Session store | setKickSession | `src/lib/kick.ts:524-557` | localStorage `kick_session` | - | VERIFIED |
| 4. Connect | KickChatClient | `src/App.tsx:242-276` | Pusher WebSocket; 100ms deferred | - | VERIFIED |
| 5. Send | kickSendManager | `src/lib/kick.ts:390-517` | Validate session → resolve broadcaster ID → POST → proxy fallback | - | VERIFIED |
| 6. 401/403 retry | refreshKickToken | `src/lib/kick.ts:467-486` | Refresh + retry once | - | VERIFIED |
| 7. Dedup | 60s window | `src/lib/kick.ts` | Blocks exact duplicates | - | VERIFIED |

**Gaps:** Hardcoded client secret in bundle; broadcaster ID cached 5min; logout is local-only.

---

## WF-008: Joystick Auth → Connect → Send

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. OAuth start | useJoystickAuth | `useJoystickAuth.ts:74-137` | Code flow (no PKCE), JWT decode | - | VERIFIED |
| 2. Token exchange | Cloudflare proxy | `cloudflare-worker/joystick-token-proxy.js:76-109` | Basic auth exchange | CORS *; hardcoded secret | VERIFIED |
| 3. Session store | setJoystickSession | `src/lib/joystick.ts:307-365` | localStorage `joystick_session` | - | VERIFIED |
| 4. Connect | JoystickChatClient | `src/App.tsx:194-239` | ActionCable WebSocket; 100ms deferred | - | VERIFIED |
| 5. Global assign | window.__joystickChatClient | `src/App.tsx:63` | Assigned in no-deps effect | Can be null during send | VERIFIED |
| 6. Send | joystickSendManager | `src/lib/joystick.ts:272-300` | WebSocket send; returns false if not open | No queue; message lost | VERIFIED |
| 7. Channel ID inject | from session | `src/lib/joystick.ts:562-571` | Inject if client lacks channelId | - | VERIFIED |

**Gaps:** Hardcoded secret; no PKCE; global mutable state; no heartbeat; message lost if WS drops between check and send.

---

## WF-009: Screen Capture → Vision

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | capture-trigger event | `src/components/ForgeLayout.tsx:1000-1261` | handleVoiceCapture/handleCaptureWindow | - | VERIFIED |
| 2. Display media | getDisplayMedia | `ForgeLayout.tsx:1022-1026` | video + audio | - | VERIFIED |
| 3. Audio clone | to startEmbedWhisper | `ForgeLayout.tsx:1045-1053` | Cloned for transcription | - | VERIFIED |
| 4. Frame capture | canvas drawImage | `ForgeLayout.tsx:1216` | Draw video to canvas | - | VERIFIED |
| 5. Frame diff | computeFrameDelta | `src/lib/frameDiff.ts:1-49` | Compare to previous; skip if delta < threshold | First frame always delta=1 | VERIFIED |
| 6. Vision call | visionRequest | `ForgeLayout.tsx:1244-1257` | AI vision API call | - | VERIFIED |
| 7. State update | visualSnapshotUrl + visualContextTags | `ForgeLayout.tsx:1257` | Update store | - | VERIFIED |

**Gaps:** Stream not stopped on unmount; crop rect not updated on resize; first frame always calls vision API.

---

## WF-010: Memory Extraction → Retrieval → Injection

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | 30s interval | `useAutoMemory.ts:101-165` | When extractionIntervalMinutes elapsed | - | VERIFIED |
| 2. Extraction | extractMemories | `src/lib/memoryEngine.ts:48-138` | AI call; filter by minConfidence | - | VERIFIED |
| 3. Apply | applyExtractionResults | `src/lib/memoryEngine.ts:142-251` | Write to IndexedDB; update counters | - | VERIFIED |
| 4. Reload | from IndexedDB | `useAutoMemory.ts:132-139` | Full reload (not from return value) | Double read; race risk | VERIFIED |
| 5. Retrieval | retrieveRelevantMemories | `src/lib/memoryRetrieval.ts:47-161` | Score by strength/relevance/recency/mood | - | VERIFIED |
| 6. Format | formatMemoryContext | `src/lib/memoryRetrieval.ts:163-232` | Format for prompt injection | - | VERIFIED |
| 7. Injection | into autoforgeDecide prompt | `useAutoForge.ts:268-288` | memoryContext passed to AI | - | VERIFIED |
| 8. Decay | runDecayCycle | `src/lib/memoryEngine.ts:336-364` | Decay strength; prune to max | - | VERIFIED |
| 9. Boost | boostMemory/boostJoke | `src/lib/memoryEngine.ts:304-332` | Load-all, mutate-one, write-all | Race condition | VERIFIED |

**Gaps:** Double reload after extraction; read-modify-write races in boost operations.

---

## WF-011: Manual Send to Chat

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Trigger | Send button / S key / palette | `TheForge.tsx:168-198`, `App.tsx:495-526` | - | - | VERIFIED |
| 2. Platform fn | getPlatformSendFn | `src/lib/platformSend.ts:9-13` | Route to platform send | Joystick captures global at call time | VERIFIED |
| 3. Send | await sendFn | `TheForge.tsx:172-197`, `App.tsx:508-525` | Await platform send | - | VERIFIED |
| 4. Record | addSentMessage + incrementMessagesSent | Both files | After send resolves | - | VERIFIED |
| 5. TTS | speakMessage | Both files | Not awaited | - | VERIFIED |
| 6. Error | toast + SFX | Both files | No queue; user must retry | - | VERIFIED |

**Gaps:** Joystick global may be null; no queue on failure; TTS not awaited.

---

## WF-012: Token Refresh / Reconnect

| Step | Component | File:Line | Behavior | State | Verification |
|---|---|---|---|---|---|
| 1. Kick refresh | ensureValidKickSession | `src/lib/kick.ts:616-636` | 60s buffer; refresh via proxy | - | VERIFIED |
| 2. Kick retry | on 401/403 | `src/lib/kick.ts:467-486` | Refresh + retry once | - | VERIFIED |
| 3. Joystick refresh | ensureValidJoystickSession | `src/lib/joystick.ts:417-434` | 60s buffer; refresh via API | - | VERIFIED |
| 4. Joystick retry | none | `src/lib/joystick.ts` | No refresh on send failure | - | VERIFIED |
| 5. Twitch refresh | none (client) | `src/lib/twitch.ts` | No proactive refresh | Sends fail until re-auth | VERIFIED |
| 6. Twitch server | cleanExpiredSessions | `server.ts:57-69` | Removes sessions without refresh token | - | VERIFIED |
| 7. Logout | local-only (client) | All auth hooks | Clears localStorage; doesn't call /api/logout | Server cookie not cleared | VERIFIED |

**Gaps:** Twitch no client-side refresh; Joystick no retry on send failure; logout doesn't clear server cookie.
