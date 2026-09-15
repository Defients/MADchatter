# MADchatter: readiness and configuration integrity

Reviewed and improved on September 13, 2026 (America/New_York).

## Scope and starting state

The inspected checkout is `H:/myProjects/MADchatter`, based on commit `0882c7a`, with package version 1.0.7 and a substantial existing dirty working tree. CoreWorkspace, CoreMode, CoreGreeting, ModeWelcomeOverlay, useCoreReadiness, onboarding tests, and related store/layout changes were already present when this continuation began. Those additions are not claimed as newly authored here. Existing edits were preserved; this work was neither committed nor published.

This is an architecture-oriented inspection followed by a focused reliability implementation. It is not an exhaustive security audit or live-service certification.

## What is already implemented

| Area | Source evidence and current extent |
| --- | --- |
| Application shell | `main.tsx` mounts React, the error boundary, tooltips, and reduced-motion support; `App.tsx` owns platform chat clients and feeds the common read-connection state. `ForgeLayout.tsx` hosts shared surfaces and selects the Core workspace. |
| Core experience | Existing CoreWorkspace has onboarding, compact readiness, provider configuration, inline chat/stream/context surfaces, and utility controls. Core/Studio and onboarding milestones persist in store schema 24. VersionBadge reads the Vite-injected package version. |
| Generation and providers | `ai.ts` implements generation, refinement, autonomous decisions, and context operations; `keys.ts` supplies credentials and compatible endpoints. `providerFallback.ts` intentionally restricts generation to the selected provider and tracks cooldowns. |
| Scheduling and coordination | Existing scheduler prioritizes requests, handles timeouts/cancellation, and serializes Ollama work. Multi-bot coordination selects a speaker; focused scheduler and coordinator suites pass locally. |
| Delivery | `manualSend.ts` selects an identity, deduplicates in-flight sends, awaits platform delivery, then records history, statistics, and events. `platformSend.ts` dispatches Twitch/Kick per-bot delivery and Joystick singleton delivery. |
| Session and memory continuity | `sessionScope.ts` uses revisions to invalidate work across channel/platform changes, including round trips. Memory-continuity tests exercise message-ID cursors and incremental decay. Local regression suites pass. |
| Documentation and operations | README and setup guide document manual versus autonomous use, supported platforms, provider setup, and the distinction between local startup and externally hosted OAuth dependencies. |

## Why this continuation matters

Readiness is an operator decision aid. Previously, a historic Forge success permanently overrode current AI configuration, and any saved provider key could satisfy readiness for a different selected provider. Disconnected returning sessions also counted as ready to avoid reopening setup. The interface could therefore imply availability while the actual execution path would refuse work.

A second mismatch existed below the UI: Ollama's one global cached result and one global in-flight promise were shared across every endpoint/model pair. Invalidation cleared only the completed result, allowing a stale request to put old evidence back. The screenshot review exposed a third mismatch: Chat Pulse labeled any named channel Live.

The implemented policy separates remembered progress from current availability. Returning operators keep their workspace while disconnected, but availability indicators and operational readiness remain false. This preserves continuity without misreporting the session.

## Complete patch notes for this continuation

### Core readiness and presentation

1. Added `src/lib/coreReadiness.ts` as the production readiness policy; the React adapter and regression tests use the same implementation.
2. Require credentials/configuration for the selected provider, with no unrelated-key fallback and no historical-Forge override.
3. Respect current provider cooldown, including expiry when no settings or store state changes.
4. Require a connected chat transport and a meaningful channel before reporting platform readiness.
5. Preserve the returning-user workspace through errors, reconnects, and missing provider configuration; keep milestone history separate from current readiness.
6. Preserve optional automation: manual-only users can become operational. Automation readiness requires available chat/AI and enabled, non-dry-run AutoForge. This remains a readiness indicator, not proof of authentication or guaranteed delivery.
7. Share one provider polling subscription, respond to cross-tab storage events and same-tab auth ticks, and clean up the timer/listener when the last consumer unmounts.
8. Read current provider snapshots on mount and recompute CoreWorkspace's provider summary even if both old and new providers have the same readiness boolean.
9. Replace Chat Pulse's unconditional Live badge with connection-derived Connected, Connecting, Connection error, and Not connected states. Add an accessible live status region.

### Ollama health and model discovery

1. Scope completed cache entries and pending-request deduplication to normalized endpoint/model pairs.
2. Invalidate pending and completed evidence together. Abort pending requests and use a revision check to reject late cache writes even if a transport ignores cancellation.
3. Ensure an older completion cannot remove a newer pending check for the same pair.
4. Expire cached evidence on direct reads after 30 seconds and cap stored configurations at 20.
5. Keep the five-second timeout active until the response body finishes parsing; clear the timer on every exit path.
6. Validate model-list entry types before matching names; malformed entries cannot crash the check.
7. Match untagged model names to their `latest` alias, without accepting arbitrary tagged variants. This follows the [official Ollama model-name convention](https://github.com/ollama/ollama/blob/main/docs/api.md).
8. Update both Core discovery surfaces to request evidence for their own endpoint/model.
9. Guard the Core model editor against settings changing while its request is in flight, and use the shared health verdict rather than duplicating fuzzy matching.

### Tests and documentation

1. Add 18 readiness scenarios, including production credential dispatch with the actual storage key, first-run transitions, missing selected-provider credentials, cooldown, disconnect/reconnect, dry run, and optional automation.
2. Add 14 network-mocked health scenarios covering cache isolation, same-pair deduplication, late invalidation, replacement requests, force refresh, expiry, tag matching, malformed lists/JSON, HTTP and transport errors, and stalled response bodies.
3. Add these complete patch notes to CHANGELOG and update the contributor guide's readiness/cache descriptions.
4. Preserve package version 1.0.7 and store schema 24: no persisted state was added.

## Verification

- `npm run lint`: exit 0.
- `npm run build`: exit 0, with the documented non-fatal bundling warnings.
- New readiness tests: 18 scenarios passed.
- New Ollama health tests: 14 scenarios passed; all requests mocked, including the five-second stalled-body case.
- Existing Core onboarding, session scope, memory continuity, AI scheduler, bot coordinator, and multi-bot store suites: all exited 0. Some existing Node store tests emit storage-unavailable warnings; they are not proof of real browser persistence.
- Headless installed Chrome: 11 browser scenarios/layout checks passed, with zero uncaught page errors. Covered selected-provider changes, key saves, cooldown entry/expiry, cross-tab updates, retained disconnected workspace, Chat Pulse disconnect labeling, fresh-user setup, and page overflow at 1600px and 1024px.
- Browser settings were synthetic, AutoForge was disabled, and non-local HTTP/WebSocket traffic was blocked. No live chat messages or provider inference calls were made.
- Local evidence is under ignored `audit-output/readiness-qa/`: build/lint logs, browser-results.json, and Core screenshots at both widths. These files are local artifacts, not committed fixtures.

## Remaining work, ranked

1. **Delivery completion across session changes.** The current manual-send helper awaits delivery, then applies accounting through captured store actions without a session-scope check. A focused follow-up should define where a successful old-session delivery belongs when a channel switch occurs during the await; silently writing it into the current session is undesirable. This requires an explicit accounting policy and targeted delayed-delivery tests.
2. **Real milestone semantics for manual sends during Dry Run.** README correctly says manual sends remain live, while the current manual-send milestone is suppressed whenever the AutoForge dry-run toggle is on. Define and test the distinction between a real manual send and a simulated automatic action before extending onboarding claims.
3. **Sending identity and readiness.** Current platform readiness is chat-read connectivity. Neither configured AI nor historical send completion establishes that the current sending account is authenticated. A future refinement should expose read/write readiness separately for singleton and per-bot identities.
4. **Consolidate provider presentation.** CoreMode and CoreWorkspace still have duplicated provider summaries with some hard-coded model labels. They should eventually read shared execution metadata rather than duplicate model names.
5. **Broader integration verification.** Live OAuth, real provider inference, authenticated delivery, persistence across real reloads, mobile interaction, and all theme/overlay combinations were outside this bounded pass. Local green checks do not certify those services.
