# Stream Companion

[Back to setup](SETUP.md) · [Back to README](../README.md)

Stream Companion lets AutoForge start relevant conversations from fresh speech or meaningful visuals while human chat is quiet. Standard remains the default. One mode applies to the entire ensemble, while each bot keeps its own persona and existing provider configuration.

## Operator walkthrough

1. Connect the intended channel/account and configure a working text provider as usual.
2. Enable audio transcription, semantic visual capture, or both. A capture preview alone is insufficient. Independent vision still sends only its textual observation to the text provider.
3. Open desktop Core's **AutoForge** controls, mobile Core's **Tuning** workspace, or expand the **Studio AutoForge HUD**. Turn **Stream Companion** on. You can choose the mode while AutoForge is off.
4. Rehearse with **Dry Run**, then separately enable **AutoForge** and resume **Auto-Check**. Choosing the mode does not change either control, your cadence, rate limits, persona, providers, R34L state, or interface density.
5. Read the mode's status and decision log. Expect a grounded reaction, observation, question, callback or occasional support when there is useful material. Silence remains a valid decision.

## Shared conversation pace

These are deterministic policy bounds, not a promise of message frequency or empirically optimized quotas.

| Rule | Bound |
| --- | --- |
| Spacing between optional conversation openers | At least 90 seconds |
| Follow-ups to one opportunity | At most two after the opener |
| Spacing between optional contributions | At least 15 seconds, or the existing stricter cooldown |
| Entire ensemble's optional contributions | At most 30/hour and 8/10 minutes |
| Speech evidence lifetime | At most 90 seconds |
| Visual/platform/human evidence lifetime | At most 120 seconds |

Existing operator/platform rate limits, confidence thresholds, manual activity protection, provider latency, and Smart/Interval evaluation cadence can slow participation further. A long Interval may miss an opportunity before its evidence expires; it is not shortened automatically. More bots do not multiply these budgets. Direct human mentions and operator Force use their established priority paths and still obey applicable controls and platform guards.

One external moment grants one opener. Speech and visual changes close together can fuse before the exchange starts. Additional bots must bring a distinct angle through the existing semantic coordinator, whose fairness, duplication checks and event ownership remain active. After two follow-ups, new external evidence is required. Bots cannot turn their own output into fresh material.

## Evidence and truthful status

Final transcript arrivals, semantic visual changes, human chat and platform events enter a bounded session ledger. Unchanged text/scenes, tiny visual changes, raw-preview placeholders, known background audio and detected bot TTS echoes cannot refresh an opportunity. Historical memories and restored channel history do not become present events.

The dedicated operator microphone path labels speech as streamer speech; this is a source designation, not speaker identification. Mixed stream audio and bridge transcripts retain uncertain attribution because they may include game dialogue or background media. Prompts explicitly prohibit treating that uncertainty as direct address or approval. No diarization capability is implied.

Fresh audio can work when vision is unavailable, and fresh vision can work when transcription is unavailable. Existing lane/stage error or staleness blocks the affected source. With both unusable, the mode waits. Explicit disconnected/error connection evidence remains a veto; zero or missing viewer count alone does not prove that the stream is offline.

The control renders the canonical policy receipt: following usable speech, reacting to a visual change, waiting for fresh activity, leaving room for humans, reaching a shared limit, or being paused by controls. It includes the number of bots and shared usage, and warns when your configured limits constrain the pace. Room Read continues to attribute activity to humans; bot-only chat remains human-quiet.

## Restraint, delivery and feedback

Healthy recent human conversation suppresses optional interjections without changing the saved mode. Fresh bounded external evidence can soften inferred empty-chat/bot-streak restraint. **STOP**, manual quiet/direct-only, spoken negative instructions and active event-floor leases remain authoritative. Manual operator sends retain their existing path. Supercharge remains a separate explicit mode with its existing teardown.

Both legacy and per-bot AutoForge paths carry the same policy ticket into canonical delivery. Atomic reservations prevent duplicate opener consumption and overbooking. Queued work rechecks session, identity, profile revision, evidence, controls and event ownership; evidence has a cancellation deadline even if transport stalls. Only confirmed adapter delivery consumes a live budget. Failure/cancellation releases the reservation and permits bounded retries while evidence remains fresh, without inventing activity.

Turning Companion off cancels pending work and restores Standard pacing without a catch-up burst. Switching ownership invalidates pending permission while retaining real-send usage for the session. Channel/context reset clears the volatile ledger. Returning to an archived channel does not restore old opportunities or follow-up permission. Schema v36 persists only the profile through normal settings/hydration/export/import paths; older or malformed profile values normalize to Standard.

Dry Run can still call the AI, but does not send or consume live Companion budgets, train engagement, or mark successful-send onboarding. Preview duplicate protections remain active. After a real Companion contribution, a confirmed topical spoken response within 30 seconds may provide bounded feedback with provenance. Unrelated/uncertain speech and absence of chat response are not inferred approval or rejection; bots cannot reward one another.

## Local verification and limits

Run `npm run lint`, `npm test`, `npm run build`, and `git diff --check`. The runner includes pure policy/store tests and a fixture harness executing both real AutoForge hooks against local AI/delivery fakes. `node scripts/check-stream-companion-ui.mjs` checks Core, mobile Core and Studio in local Chromium with external requests blocked, including keyboard interaction, 44px touch targets, status changes and saved preferences. It writes screenshots and results to `audit-output/stream-companion/`; `QA_CHROMIUM` can specify the browser executable.

Local fake delivery verifies wiring and invariants. It does not establish live platform/provider success, transcription accuracy, speaker attribution, or conversational quality. A real-stream trial is still needed to judge relevance, timing and persona distinctness under actual capture/provider conditions. Tune the existing controls from that evidence; no production-certification claim follows from local checks.
