# Enhancement review — September 15, 2026

## Outcome and scope

Completed a bounded reliability and performance pass on existing conversation
threading. No new features, public signatures, dependencies, saved fields, schema
changes, or release-version changes. Changes are local and uncommitted.

Baseline: clean `master` at `62b789793ab63799b850138bccf74ffa676e1db4`, package
version 1.0.7, Node 22.14.0, npm 10.9.2, existing `package-lock.json` and installed
dependencies. This is a focused review, not a complete repository or release audit.

## Context and inventory

Reviewed the contributor guide, existing changelog and readiness review, available
regression harnesses, conversation-thread implementation, chat-handler wiring,
AutoForge consumers, speaker coordinator, and reply-ID cache.

| Existing surface | Assessment and boundary |
| --- | --- |
| Core/Studio, onboarding, AI-provider readiness | Existing capabilities and prior fixes documented in the guide and readiness review; no new UI verification in this pass. |
| Manual and autonomous generation, multi-bot coordination | Both AutoForge hooks consume `formatThreadContext`; ownership errors therefore reach existing decision prompts. Coordinator regression harness passed. |
| Session continuity, memory, channel snapshots | Existing revision guards and channel-scoped persistence documented; session-scope regression harness passed. No persistence changes. |
| Twitch reply tracking | Chat handler marks own-message IDs before recording them; this ordering is preserved. Incoming and outgoing cache paths now enforce capacity. |
| Reply-ID mention cache | Separate cache inspected; left unchanged to keep this repair focused. |
| Documentation and testing | Guide incorrectly described type-checking as the only automated gate despite existing test harnesses and required builds; corrected. |

## Ranked work and complete patch notes

1. **Reliability: isolate bot-specific context.** Previously, marked roots bypassed
   the requested username, so AlphaBot's context could label BetaBot's message as
   "You." The identity filter now applies before either root-selection branch.
   Matching normalizes casing. Omitting the username still returns all marked bots.
2. **Performance and reliability: enforce existing capacity.** `MAX_ENTRIES = 200`
   was declared but unused. Incoming and outgoing insertion now evict the earliest
   inserted entries above the limit and remove their bot markers. Standalone bot
   markers are also capped, preserving the chat handler's mark-before-record order.
   Existing ten-minute expiry remains intact.
3. **Regression protection.** Added eight deterministic scenarios using the existing
   TypeScript runtime and Node's built-in test API. Tests cover ownership, casing,
   nested replies, incoming/outgoing bursts, orphan markers, expiry, channel changes,
   and broken/cyclic chains. No new test dependency.
4. **Contributor clarity.** Updated `AGENTS.md` with the capacity/identity invariants
   and test command; corrected its obsolete test-gate statement. Added changelog
   notes and this review.

## Verification

| Check | Result |
| --- | --- |
| New suite against original implementation | 3 passed, 5 failed: reproduced identity, casing, capacity, and marker failures. |
| `npx tsx --test src/lib/conversationThread.test.ts` after repair | 8 passed, 0 failed. |
| `npx tsx src/lib/botCoordinator.test.ts` | 14 assertions passed, 0 failed. |
| `npx tsx src/lib/sessionScope.test.ts` | 22 assertions passed, 0 failed. |
| `npm run lint` | Exit 0; TypeScript check. |
| `npm run build` | Exit 0; Vite reported 12.45 seconds, 2,876 transformed modules. |

**Measured capacity improvement:** a 500-bot-message burst previously retained 500
messages; the repaired implementation retains 200 (60% fewer entries in this
fixture). The incoming-burst regression checks the 200-entry bound after each of
1,000 insertions. This bounds the input to repeated thread scans; no runtime latency
or heap-byte improvement is claimed from these counts.

Expected build warnings remain: Anthropic Node-module externalization, mixed
dynamic/static imports, and large chunks. Session tests report unavailable browser
storage under Node; they complete successfully. Live Twitch, OAuth, real provider
inference, browser layouts, and full-suite execution were outside this pass.

## Residual tradeoffs and BACKLOG/RFC — not implemented

- Enforcing the documented limit means very busy channels lose older thread roots
  before ten minutes. Replies whose roots were evicted are intentionally omitted;
  regression coverage verifies this fallback.
- **Follow-up: mention parsing fixtures.** The reply-ID cache's comment describes
  punctuation boundaries, while its expression accepts start/whitespace boundaries.
  Confirm desired matching behavior before a separate compatibility-focused repair.
- **Follow-up: thread recency policy.** `getActiveThreads` reports a recent-activity
  flag, but context formatting currently retains older threads until cache expiry.
  Decide whether five-minute inactivity should hide context before changing it.
- **Follow-up: real-session smoke check.** With an explicitly authorized test
  channel, verify two bots receive only their respective thread context through the
  full chat-to-generation flow. Local synthetic tests do not prove external delivery.
- **New-feature RFCs:** none required for this repair.
