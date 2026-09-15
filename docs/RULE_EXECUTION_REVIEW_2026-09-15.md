# Rule execution enhancement review — September 15, 2026

Follow-up: [Send cancellation review](SEND_CANCELLATION_REVIEW_2026-09-15.md)
records the subsequent implementation of cancellable rule delays, adapter queues,
transport preparation, and retry-batch handling. The original pass and its
then-current limitations are retained below as historical evidence.

## TL;DR

Delayed rules now stay bound to their originating session and bot. A channel
change during an action delay previously allowed that action to read the new
channel and send there. The repair stops stale action sequences and batches,
prevents their callers from recording stale activity, and reports incomplete
actions truthfully. No new product features or public API changes.

Baseline: clean `master` at `d0f5d82f1f946c4468645747fc437c1012fe1e37`, package
1.0.8, Node 22.14.0, npm 10.9.2, existing lockfile and installed dependencies.
Date uses America/New_York. This pass leaves local, uncommitted changes.

## Assessment and ranked selection

Reviewed the contributor guide, recent commits, prior enhancement/delivery
reviews, changelog, test runner, and source for rule execution, both AutoForge
loops, session guards, manual delivery, speaker coordination, and smart replies.

| Existing surface | Assessment and opportunity |
| --- | --- |
| Core/Studio and onboarding | Existing readiness, mode, mobile, and panel suites remain part of the full regression run. No layout redesign selected. |
| Provider routing, independent vision, scheduling | Recent committed functionality has dedicated regression suites. Routing/configuration changes are outside this repair. |
| Manual/platform delivery | Prior ordered-admission and stale-completion fixes are present. Transport cancellation remains a documented boundary. |
| Channel continuity and memory | Existing revision-based session guards, snapshot flow, and memory regressions provide the foundation for this repair. |
| Rules and autonomous loops | Both loops await the rule engine. Delays were unguarded; subsequent actions read current state, and callers recorded activity without an immediate guard check. Highest-impact selected defect. |
| Rule preview and feedback | Empty AND previews disagreed with execution. Failure counts were followed by a success summary. Both fixes fit the same module. |
| Verification | Rule-engine behavior lacked a dedicated suite. Existing bundled-harness conventions support real-store tests with local side effects. |

Ranked tasks: (1) repair delayed execution and caller boundaries; (2) align
previews and completion feedback; (3) add regression evidence and run all gates.
The work retains rule conditions, scoring, action order/delays, cooldown/fire-limit
policy, presets, provider settings, and the persistence schema.

## Complete patch notes

- Add a private rule guard using the existing session revision/platform/channel
  scope. Capture multi-bot mode and the selected bot's platform/username/user ID.
- Subscribe during execution so mode changes and bot deactivation remain
  cancelling events even when immediately reversed. A channel round trip is
  rejected through the existing session revision.
- Share one guard across a rule batch; stop before later rules can consume their
  fire count/cooldown or act on old context. Standalone `fireRule` owns its guard.
- Check before/after delays and after awaited actions. Dispose subscriptions on
  success, skipped rules, cancellation, and errors.
- Do not count a late transport completion toward the cancelled run or display
  its error/success toast in the new session. Actions that completed before
  invalidation retain their count in the returned result.
- Recheck both AutoForge callers immediately after rule evaluation, before
  activity/event updates and continuation. Extend per-bot cycle identity checks
  to platform, username, and user-ID replacement.
- Keep rule-level AutoForge toggles functional. The existing late-night preset
  can turn AutoForge off and then notify; the outer AutoForge cycle exits when
  the rule batch returns.
- Contain unexpected action exceptions, retain remaining valid actions, and
  report partial failure with a warning plus the actual completed-action count.
  Null transport rejections no longer cause a secondary property-access error.
- Make empty AND-condition previews return false, matching execution. Preview
  remains a conditions-only check; cooldowns and fire limits still belong to
  execution.
- Add 19 deterministic scenarios using the real store/session helpers, explicit
  delay release, and local transport/audio/toast fakes. Every scenario checks
  execution subscriptions return to zero.
- Register the bundled suite in the existing test runner. No dependencies,
  lockfile edits, saved fields, schema migration, or version bump.

## Validation

| Check | Result |
| --- | --- |
| New rule-engine harness | 19/19 scenarios passed; exit 0. |
| Original-source comparison | The same tests bundled against the starting `HEAD` rule engine produced 2 passes and 17 failures, exit 1. Working source was never replaced. |
| `npm test` | 28/28 isolated suites/harnesses passed; exit 0. |
| `npm run lint` | TypeScript check passed; exit 0. |
| `npm run build` | Passed; exit 0. Vite reported 19.18 seconds. |
| Rendered browser checks | 2/2 passed in headless Chrome at 1600×1000: empty-condition preview and incomplete-action toast. Zero page errors. |
| `git -c core.safecrlf=false diff --check` | Passed; exit 0. |

Original-source output is retained locally in
`audit-output/rule-engine-polish/baseline.log`; build output is in the adjacent
`build.log`. These generated audit files are ignored by Git. The temporary
baseline harness and bundled test directories were removed.

Browser checks mounted the existing Rule Builder in the running app with synthetic
store data, blocked external HTTP/WebSocket traffic, and exercised preview and
non-send failure feedback. Screenshots and `browser-results.json` are in the same
audit directory; the incomplete-action screenshot was visually inspected. This
does not establish full navigation, responsive, or live-platform behavior. The
temporary development server was stopped after verification.

The regression comparison demonstrates correctness changes. Build duration is
an observed run time, not a before/after performance benchmark. Existing documented
Node-module externalization, mixed-import and large-chunk warnings remain.

## BACKLOG/RFC — deferred, not implemented

1. **Transport cancellation across admission and delivery.** A send already
   waiting inside an adapter or started on the network can still complete.
   Cancellation must propagate through rate waits, connection joins, fetches,
   and fallback attempts before claiming recall or timeout-safe retry.
2. **Rule editing and master-toggle policy during delays.** This pass cancels
   session/identity changes. Disabling/removing a rule during its running sequence,
   or distinguishing a user's AutoForge toggle from the rule's own toggle,
   needs a separately defined behavior contract.
3. **Immediate cancellation of pending waits.** Existing action timers still wake
   at their configured deadline, then skip stale work. Transport waits still rely
   on adapter completion; no new deadlines or cancellation API were introduced.
4. **Unify rule-send history accounting.** Rule sends still use the existing
   platform adapter directly; universal sent-log/statistics/anti-repetition
   accounting requires a separate review of automated delivery semantics.
5. **Live-session smoke verification.** Local fakes establish state isolation,
   not OAuth behavior or actual message visibility in Twitch/Kick/Joystick.

No new-feature RFC was necessary. Broader UI redesign, bundle restructuring, and
new telemetry were not needed for this bounded repair.
