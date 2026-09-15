# Delivery integrity — 2026-09-15

## TL;DR

Concurrent chat sends now share ordered rate-limit admission across Twitch, Kick,
and Joystick. Failed delivery no longer poisons Twitch's duplicate cache. Manual
send completion respects session boundaries, and `npm test` runs the repository's
regression suites through one command.

Baseline: clean `master` at `9616965c3c54b65a28cfe5994a476dfe9573da54`, version
1.0.7, Node 22.14.0, npm 10.9.2. Date uses America/New_York. Changes are local and
uncommitted; this is a focused engineering continuation, not release certification.

## Project assessment and selection

Reviewed the contributor guide, package configuration, recent commits, changelog,
prior enhancement review, test inventory, and the implementation of platform
delivery, manual accounting, channel switching, session guards, retry queue, and
relevant AutoForge/rule-engine call sites.

| Existing work | Evidence and remaining opportunity |
| --- | --- |
| Core/Studio and onboarding | Implemented with readiness and persistence regression suites. The send milestone still incorrectly depended on AutoForge's Dry Run preference. |
| AI scheduling and multi-bot automation | Existing scheduler, speaker coordinator, and guarded generation loops. Their decisions eventually meet shared platform send managers, making admission correctness valuable across callers. |
| Session continuity and channel snapshots | Revision-based guards and archive/reset/restore already exist. Manual completion still applied accounting after awaiting transport without rechecking session identity. |
| Memory and conversation context | Continuity, decay, retrieval, and bot-thread regressions already exist. Full-suite execution preserves their checks in this pass. |
| Platform delivery | All three managers inherited a common limiter but duplicated the check/wait/send sequence. Concurrent callers could pass together; Twitch recorded duplicates before success. |
| Retry queue | Processor and status indicator exist, but the source search found no production enqueue caller. Its clear-during-processing behavior remains an investigation item; it was not selected over reachable sends. |
| Verification | Many standalone test files and two integration harnesses existed without a package-level runner. Some suites exit their process, so each needs isolation. |

The selected change repairs the shared delivery boundary while retaining existing
provider routing, personas, layout, saved configuration, and automation policies.
No UI change or browser-layout claim is included.

## Complete patch notes

### Shared send admission

- Added an ordered promise queue to each `SendRateLimiter` instance. One account's
  transport completes before its next queued send is admitted; different bot
  managers continue independently.
- Moved all three platform adapters onto `sendWithRateLimit`; removed their
  duplicated admission/wait logic and success recording.
- Recheck the rolling-window allowance after every wait. Early timer wakeups do
  not bypass capacity, and simultaneous callers cannot consume the same slot.
- Reserve a logical attempt before asynchronous delivery. Failures retain that
  reservation, limiting repeated failure bursts, while leaving duplicate history
  untouched. Kick's internal fallback/refresh requests share the logical attempt.
- Record duplicate history only when the transport resolves successfully. Retrying
  a rejected Twitch send is possible immediately when capacity remains available.
- Check queued duplicates after preceding delivery settles. An overlapping copy
  is rejected if the first succeeds; it can proceed if the first fails.
- Recover the queue after rejection so one error does not poison later work.
- Fix duplicate recognition at timestamp zero and prune entries at the exact
  expiry boundary. Keep existing trimming/case-insensitive matching and 60-second
  policy. Duplicate matching remains per manager, including across destinations.
- Preserve platform size validation and existing Twitch mention-reply lookup,
  Kick authentication/fallback, and Joystick WebSocket delivery behavior. Twitch
  reply lookup occurs when its queued message is admitted.

### Manual-send session accounting

- Capture the existing session scope before delivery and recheck revision,
  platform, and normalized channel before writing completion state.
- Suppress completion accounting after a multi-bot mode change or when the selected
  bot is removed, inactive, on another platform, or has a different username/user ID.
- Stale completion adds no sent history, counters, event, manual-send timestamp,
  or onboarding milestone to the current session. It resolves without requesting a
  retry because the transport may already have sent the message.
- Normalize channel spelling in the pending-send lock and scope the lock to the
  session revision. Keep lock cleanup in `finally`, including on stale completion.
- Use the explicit send's `dryRun` value for the onboarding milestone. AutoForge's
  Dry Run preference no longer prevents a real manual send from counting.
- Preserve local history for explicit dry-run sends, without live delivery,
  live-send counters, or onboarding completion.

### Verification and documentation

- Added eight deterministic rate-limiter tests with a simulated clock: burst
  admission, queued duplicates, failure/retry, failure pacing, completion-based
  expiry, timestamp zero, independent accounts, and early timer wakeup.
- Added nine adapter integration scenarios: each platform's size rejection,
  concurrent duplicate handling, and failed-send retry. Network and Twitch
  connection creation are replaced by local fakes.
- Extended the manual harness from nine to nineteen scenarios. Added session
  changes, A-to-B-to-A revision changes, bot lifecycle, Dry Run, normalized pending
  locks, and the onboarding fixture method missing from the original harness.
- Added `npm test` with recursive test discovery, one child process per suite,
  a two-minute deadline per child, continued execution after failure, and a failing
  final exit code if any suite fails. Existing channel tests use their bundled
  harness; both send harnesses are included explicitly.
- Give bundled send fixtures readable stack-trace source names rather than long
  embedded data URLs. Update `AGENTS.md`, `CONTRIBUTING.md`, and `CHANGELOG.md`.
- Package stays at 1.0.7. No dependency, lockfile, persistence-schema, or visual
  change was needed.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 25/25 suites passed, exit 0. Includes all discovered TypeScript suites and three bundled integration harnesses. |
| Rate-limiter regressions | 8/8 deterministic scenarios passed. |
| Manual-send harness | 19/19 scenarios passed with local delivery fakes. |
| Platform-send harness | 9/9 scenarios passed across Twitch, Kick, and Joystick with local transports. |
| `npm run lint` | Exit 0. TypeScript checking. |
| `npm run build` | Exit 0. Vite 6.4.3 transformed 2,876 modules; reported build time 19.18 seconds. |
| `git -c core.safecrlf=false diff --check` | Exit 0. |
| Original-source regression proof | Rebundled the new harnesses against the original `HEAD` source without replacing working files. Manual-send failed with five stale accounting calls where zero were expected. Platform-send failed when retrying the rejected Twitch message because it was falsely marked duplicate. Temporary harnesses were removed. |

The build retained the documented Anthropic Node-module externalization, mixed
dynamic/static import, and large-chunk warnings. Tests include existing synthetic
Core/mobile state checks; these are not rendered-browser verification. No live
platform delivery or external publication was performed.

## Remaining boundaries and ranked follow-ups

1. **Transport cancellation and deadlines.** Completion protection does not cancel
   a transport already started or a send waiting inside a platform manager. A
   never-settling transport can hold that account's ordered queue. A follow-up
   should propagate cancellation through rate waits, connection joins, fetches,
   and fallback attempts before adding a timeout that might permit duplicate
   delivery. Other account managers continue independently.
2. **External delivery acknowledgement.** Adapter promise resolution is the
   current success contract. Twitch notices may arrive later; these tests do not
   establish that a message appeared in live chat. No authenticated messages,
   OAuth flows, or paid model calls were made.
3. **Late-send attribution.** Stale completions are omitted from current-session
   accounting; this pass does not append them to an already archived session.
   Autonomous loops also maintain their own accounting paths and need a separate
   review before claiming universal post-send protection.
4. **Retry and delayed-rule lifecycle.** The retry processor retains a ready-list
   snapshot during clearing, and delayed rule actions warrant session invalidation
   review. These paths were inspected but not modified here.

The validation is local regression evidence. Browser layout, live transport
behavior, deployment, and full application security remain outside this pass.
