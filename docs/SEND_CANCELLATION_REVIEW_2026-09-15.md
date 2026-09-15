# Send cancellation review — September 15, 2026

## TL;DR

Cancellation now follows existing sends through queue admission, rate-limit
waits, Twitch connection/self-join, Kick lookup/refresh/fallback requests, and
Joystick's queued WebSocket write. AutoForge and rules propagate their execution
signals. A session or identity change cancels ordinary/manual sends too.

The implementation distinguishes withdrawing a caller from confirming that a
message was never delivered. A non-abortable IRC write retains its place in the
ordered queue until it settles. Confirmed success still enters duplicate history
even when its caller has already cancelled.

Baseline: `master` at `d0f5d82f1f946c4468645747fc437c1012fe1e37`, version 1.0.8,
Node 22.14.0 and npm 10.9.2. The preceding rule-engine pass's nine changed/new
files were already present and were preserved. This continuation is local and
uncommitted. Dates use America/New_York.

## Scope and implementation decisions

Reviewed the existing rate limiter, platform factory, Twitch/Kick/Joystick
managers, session setters, rule and AutoForge callers, manual accounting, retry
processor, and local integration harnesses before editing.

Ranked work: (1) stop withdrawn admission and rate waits; (2) cancel transport
preparation without fallthrough retries; (3) connect caller/session invalidation;
(4) verify cleanup and delivery ordering. No new product controls or features.

Public call sites remain compatible: abort signals are optional trailing
parameters. Provider configuration, saved state, account selection, action
scoring, rate limits, and duplicate windows are unchanged. The Twitch preparation
deadline now covers connection plus self-join, rather than starting only after
connection succeeds; its duration is eight seconds.

## Complete patch notes

### Shared cancellation and ordered admission

- Add `SendCancelledError`, a preparation-promise wrapper that observes late
  settlement, and a delay helper that removes abort listeners and clears timers.
- Add optional signals to limiter admission. Check before admission, after rate
  waits, and before reserving attempt capacity. A cancelled queued request never
  calls its delivery callback and consumes no attempt capacity.
- Let a caller reject promptly on cancellation, while retaining the actual
  delivery promise in the account's ordered tail. This preserves ordering for
  non-abortable writes and retains duplicate history on late confirmed success.
- Keep failed admitted attempts counted, and preserve normal failure recovery,
  duplicate rejection, and independent per-account limiters.

### Session and caller wiring

- Bind each platform-send invocation to the current session revision/platform,
  multi-bot mode, and selected sending identity. Identity loss or replacement
  cancels it even if immediately restored.
- Observe store changes, native cross-tab storage events, and same-tab events
  from the three session setters. Compare identity fields, so ordinary token
  renewal for the same account does not cancel its send.
- Expose the existing AutoForge execution guard's abort signal. Pass it to
  immediate sends in both loops and recheck validity before completion updates.
  Cancellation does not create new failure events or reschedule stale work.
- Keep deferred followups on their captured scope plus platform-send binding;
  suppress stale followup completion/error updates.
- Pass rule guards into delivery and cancel their pending delay timers. Preserve
  sequences that intentionally toggle AutoForge before another action.
- Abort retry processing on clear. Discard a cancelled ready snapshot instead of
  retrying it or starting its remaining stale entries; preserve entries added
  after that snapshot. Existing real-error retry policy remains.

### Twitch

- Make connection/self-join preparation cancellable and bounded to eight seconds.
  A connected socket alone is insufficient to admit a message.
- Track the active client and authenticated identity; retire the old connection
  synchronously before waiting for its disconnect. Old callbacks cannot change
  a newer connection's state.
- Remove join listeners, deadline timers and caller abort listeners on all
  preparation exits. Recover after synchronous connection failure or timeout.
- Check cancellation before raw/plain writes and before reply fallback. Do not
  race a started `raw`/`say` write to advance ordered admission prematurely.

### Kick and Joystick

- Forward Kick signals through all lookup alternatives, initial session refresh,
  direct/proxy chat requests, and authentication-refresh retry.
- Stop on abort instead of treating it as a network error eligible for fallback.
  Check before applying refreshed credentials or clearing a superseded session.
- Retain duplicate protection when an already-cancelled chat request nevertheless
  returns a successful response. Preserve ordinary proxy and refresh retry flows.
- Joystick accepts the optional signal and skips cancelled queued admission;
  there is no asynchronous recall after its synchronous WebSocket write.

## Verification

| Check | Evidence |
| --- | --- |
| Full regression run | 29/29 isolated suites and harnesses passed, exit 0. |
| Transport cancellation harness | 22/22 scenarios passed with real store/managers/manual-send path and local I/O fakes. |
| Limiter regressions | 12/12 passed, including four new cancellation scenarios. |
| Prior rule-engine harness | 19/19 passed with signal propagation and cancellable delays. |
| TypeScript | `npm run lint` passed, exit 0. |
| Production build | `npm run build` passed, exit 0; Vite reported 13.36 seconds. |
| Diff check | `git -c core.safecrlf=false diff --check` passed, exit 0. |

The integration harness asserts store subscriptions and storage/identity-event
listeners return to zero after every scenario. It covers cancellation during
Twitch connection and join, late retired events, raw-reply fallback suppression,
connection failure/timeout recovery, channel/mode/identity changes, AutoForge
off/on, five Kick preparation/delivery stages, ordinary Kick refresh fallback,
late confirmed success, Joystick rate waits, retry-batch clearing, and manual
history/pending-lock recovery.

An isolated before/after limiter comparison used the original `HEAD` source
without replacing working files. A pre-cancelled request originally delivered
once and consumed one capacity slot. The repaired implementation delivered zero
times, consumed zero slots, and rejected with `SendCancelledError`.

Logs and the comparison JSON are under `audit-output/send-cancellation/` (ignored
by Git). Tests use local transports; no live platform messages, credentials,
OAuth flows or model calls were exercised. No UI layout changes or new rendered
browser claims are included. Documented build warnings remain.

## Remaining boundaries and BACKLOG/RFC

1. **Remote outcome is not recall.** Aborting HTTP cannot prove a server did not
   process a chat or token-refresh request. Cancellation never initiates an
   automatic fallback/retry. Confirmed local success keeps duplicate protection;
   an unconfirmed remote outcome remains unknown.
2. **Never-settling non-abortable writes.** A cancelled caller exits promptly, but
   its account's ordered tail remains blocked if a started IRC write never
   settles. Releasing it on an arbitrary timeout could allow overlap or duplicate
   delivery. Other account managers remain independent. Cancelled queue closures
   behind that tail also remain retained until it settles.
3. **Rule editing/master-toggle policy.** The earlier deferred policy remains:
   disabling/removing a running rule and distinguishing user toggles from
   rule-authored toggles require an explicit behavior contract.
4. **Unified automated history.** Rule sends still use the platform adapter;
   consolidating rule-send history/statistics remains a separate follow-up.
5. **Live-session verification.** Actual server acknowledgements, OAuth and chat
   visibility need a separately authorized test session. Local tests prove the
   cancellation and accounting boundaries, not external delivery.

No new feature RFC was needed. Dependencies, lockfile, saved schema and release
version remain unchanged.
