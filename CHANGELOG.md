# Changelog

All notable changes to MADchatter are documented here. Dates are in YYYY-MM-DD format.

## [Unreleased] — 2026-09-10

### Fixed
- **Smart Reply send tracking** — Smart replies (keyboard 1/2/3 and click) now record in the sent log, session stats, and event log. Previously they were sent but untracked, breaking anti-repetition and analytics.
- **R34L trailing cringe** — Removed `lol`, `tbh`, `ngl`, `lmao`, `fr`, `lowkey`, `highkey`, `istg`, `frfr` from the chat-style slang lexicon and `trailing "lol"`/`trailing "lmao"`/`xd` from punctuation signals. These were re-encouraging the forced closers the R34L prompt explicitly bans. Added anti-cringe caveat to the formatChatStyleProfile mirror instruction.

### Changed
- **R34L prompt de-cringe** — Removed `tbh`, `ngl`, `lowkey`, `for real` from softener examples. Added explicit "NO TRAILING CRINGE" rule (6b) forbidding `lol`/`tbh`/`ngl`/`lmao`/`fr`/`frfr`/`istg`/`lowkey`/`highkey`/`imo`/`idk tho` as message closers. Removed `owo` and `xÐ` signature closer from emoticon guidance. Removed try-hard phrases ("confidence-to-substrate ratio is cooked", "make it make sense", "this feels fake-smart") from common phrase patterns. Expanded AVOID list with trailing closers and signature emoticons.
- **DRY: OpenAI-compat dispatch** — Extracted `openAiCompatEndpoint(provider, keys)` helper in `keys.ts`. Replaced 6 duplicated baseUrl/model ternaries across `ai.ts` (5 blocks) and `memoryEngine.ts` (1 block) with single-line calls. Server-side mirror added in `server.ts` (4 blocks). One source of truth for OpenRouter and Ollama defaults.
- **Dead code cleanup** — Removed `whisperChunksRef` from `useDeepgramTranscription.ts` (declared and reset 3× but never populated; `whisperQueueRef` is the working queue). Removed `pttToggleMode`/`setPttToggleMode` from `usePushToTalk.ts` (declared and returned but never set or read by any consumer).
- **README overhaul** — Complete rewrite reflecting current state: added Multi-Bot Mode, Ollama/Local provider, Kick/Joystick platforms, Smart Replies, Rule Engine, Session Goals, Chat Pulse, updated keyboard shortcuts (1–9), removed stale "Live Modifiers" HUD reference, added build/verification commands table, added Ollama setup guide, added Multi-Bot Mode section.

### Removed
- **Public release cleanup** — Removed `audit-output/` (internal audit reports), `docs/SCREENSHOTS.md` (screenshot guide with no images), and `chunce.txt` (raw Twitch chat log; the Tour uses an embedded copy in `tutorialData.tsx`). Added `audit-output/` to `.gitignore`. Fixed stale "no license declared" reference in CONTRIBUTING.md (now MIT).

### Added
- **Ollama / Local provider** — First-class provider button in Settings (emerald-themed, always-green status dot since no key required). Selecting it pre-fills `http://localhost:11434/v1` and `llama3.1:8b` as defaults. `getApiKey("ollama")` returns a dummy `"ollama-local"` so key guards pass. Added to provider fallback chain. Added to TuningDeck model dropdown. Server-side `getApiKey` and dispatch blocks updated. Info banner in Settings explains setup. Welcome overlay includes step-by-step Ollama instructions with Windows cmd/PowerShell commands and `OLLAMA_ORIGINS=*` guidance.
- **Auto-fill Ollama URL button** — "Ollama URL" button (Wand2 icon) next to Custom API Base URL in Settings; fills `http://localhost:11434/v1` in one click.
- **Welcome overlay restructure** — Moved "API key required" and "Prefer a free local LLM" panels below the "Take the Tour" button. Ollama panel expanded with full setup steps (install, pull, quit tray, terminal commands, configure MADchatter) and a tip about `ollama run` vs terminal.
- **Shortcut reminder** — Added "While you wait: Ctrl+K command palette · ? all shortcuts" hint below the "How It Works" panel in TheForge setup checklist (shown only while setup checks are in progress).
- **AGENTS.md** — Contributor guide with build commands, architecture overview, conventions, and key file map.
- **CHANGELOG.md** — This file.

### Docs
- **AGENTS.md** — Build/verify commands, architecture overview (state, AI pipeline, AutoForge loops, coordinator, send path, memory, R34L, keys, fallback), conventions (no new features without request, multi-bot additive, provider dispatch DRY, smart reply tracking, R34L cringe exclusion, persistence versioning, build warnings), key file map.
