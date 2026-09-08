# MADchatter — AutoForge

An AI-powered Twitch chat co-pilot that generates context-aware chat messages from live stream signals (audio transcription, screen capture, chat activity, and stream metadata).

## Features

- **Forge Engine** — Generates multiple variant chat messages using configurable AI providers (Gemini, OpenAI, Claude, OpenRouter)
- **AutoForge** — Autonomous mode that decides when and what to send based on chat velocity, mentions, activity spikes, and audio/visual context
- **Dry Run Mode** — Log AutoForge decisions without sending messages. Perfect for tuning confidence thresholds and observing AI behavior safely
- **Confidence Threshold** — Configurable minimum confidence floor for autonomous actions. Decisions below the threshold are downgraded to silence
- **Engagement Score** — Composite real-time metric (0-100) combining chat velocity, sentiment, chatter diversity, and recency into a single health indicator
- **Stream Status Detection** — Automatically detects likely offline streams (0 viewers + no chat for 5+ min) and pauses AutoForge to avoid wasted API calls
- **Message Deduplication Guard** — Prevents AutoForge from sending the exact same message twice within a recent window
- **Session Goal Evaluation** — Real-time progress tracking for configured session goals (mention response rate, actions/hour, sentiment ratio, etc.) evaluated after each AutoForge cycle
- **Sentiment Analysis** — Real-time chat sentiment tracking (positive, negative, hype, wholesome, toxic, neutral) with rolling history, trend detection, and AI context injection
- **Anti-Repetition System** — Tracks recently sent messages, identifies overused phrases and opening patterns, and feeds context to AI to force variety
- **Provider Fallback** — Automatic failover across configured AI providers with health tracking, cooldown periods, and fallback counting
- **Action Rate Limiting** — Configurable per-hour and per-10-minute action caps with minimum cooldowns to prevent spammy behavior
- **Analytics Dashboard** — Real-time metrics panel (press `D`) with sentiment trends, chat velocity, action distribution, provider health, and action history
- **Settings Export/Import** — Export and import all app settings as JSON via the Command Palette
- **Tuning Deck** — Adjustable humor, chaos, emote density, message length, persona masks, and computational effort
- **Audio Transcription** — Real-time transcription via Deepgram WebSocket or local Whisper (transformers.js)
- **Visual Capture** — Screen capture snapshots fed as visual context to the AI
- **Pinned Memories** — User-curated long-term context anchors with a "Golden Memory" priority system
- **Auto-Memory System** — AI-powered memory extraction, user profiling, inside joke tracking, and personality evolution across sessions
- **R34L Mode** — Transforms AI output to type like a real human (lowercase, loose spelling, punctuation as emotion)
- **Command Palette** — Ctrl/Cmd+K for quick actions
- **Resizable Panels** — Drag-to-resize layout with persisted state

## Tech Stack

- React 19 + TypeScript + Vite
- Zustand (state management with persistence)
- Tailwind CSS + shadcn/ui components
- tmi.js (Twitch chat client)
- @google/genai, openai, @anthropic-ai/sdk (AI providers)
- @huggingface/transformers (local Whisper fallback)
- Deepgram (real-time WebSocket transcription)

## Run Locally

**Prerequisites:** Node.js 18+

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in `.env.local` to your Gemini API key
3. Run the app:
   `npm run dev`

## Configuration

API keys for AI providers and Deepgram are configured in the Settings panel within the app. The Twitch Client ID can be set via `VITE_TWITCH_CLIENT_ID` in `.env` or directly in Settings.

## Project Structure

```
src/
  components/    UI components (TheForge, TuningDeck, AutoForgeHUD, AnalyticsPanel, etc.)
  hooks/         useAutoForge, useTwitchAuth, useDeepgramTranscription, useAutoMemory
  lib/           AI integration, sentiment, antiRepetition, providerFallback, actionRateLimiter, prompts, keys, memory
  store.ts       Zustand global store with persistence (v3)
  types.ts       TypeScript domain types
  App.tsx        Main app entry, Twitch chat, metadata polling, shortcuts
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl/Cmd+K` | Open Command Palette |
| `F` | Forge new batch |
| `S` | Send top variant to chat |
| `C` | Capture browser stream |
| `A` | Toggle AutoForge on/off |
| `H` | Toggle AutoForge HUD |
| `D` | Toggle Analytics Dashboard |
| `T` | Toggle CosmoTech theme |
| `Shift+R` | Toggle R34L typing mode |
| `Ctrl+B` | Collapse/Expand Context Rail |
| `?` | Show keyboard shortcuts |

## AutoForge HUD

The AutoForge HUD (press `H`) provides real-time visibility into the autonomous decision engine:

- **Status Grid** — Active/disabled state, chat energy level, time since last action, next check countdown
- **Engagement Score** — Composite metric with sub-scores: velocity (VEL), sentiment (SENT), diversity (DIV), recency (REC)
- **Rate Limit Indicator** — Per-hour and per-10-minute action caps with cooldown timer
- **Dry Run Toggle** — Enable/disable dry run mode without opening settings
- **Confidence Threshold Slider** — Adjust the minimum confidence floor for autonomous actions
- **Context Token Budget** — Control how many tokens AutoFeed uses for context per decision
- **Live Modifiers** — AI-directed humor and chaos levels vs. base configuration
- **Previous Cycle Decision** — Last decision type, confidence, reason, and action payload
