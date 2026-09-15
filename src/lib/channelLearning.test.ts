/**
 * Focused test harness for the Channel Learning feedback loop.
 * Run: npx tsx src/lib/channelLearning.test.ts
 *
 * Covers the full feedback-loop test matrix: cold start, minimum samples,
 * gradual learning (positive/negative), outlier resistance, recency decay,
 * busy-chat normalization, bot-attribution exclusion, silence first-class
 * evidence, bounded influence, pruning, and malformed-data safety.
 *
 * All functions under test are pure — no store, no timers, no AI calls.
 */

import type { ChatMessage, GoalEvaluationResult } from "../types";
import {
  SILENCE_ACTION,
  SILENCE_SAMPLE_WEIGHT,
  buildSelfPerformanceContext,
  buildSessionGoalsContext,
  collectBotUsernames,
  computeNormalizedOutcome,
  computeSilenceOutcome,
  describeConfidence,
  emptyLearningProfile,
  getLearnedActionStats,
  getLearningDiagnostics,
  learningProfileKey,
  pruneLearningProfiles,
  recordLearningOutcome,
  sanitizeLearningProfile,
  shouldRecordSilenceObservation,
  summarizeLearningStatus,
  MAX_LEARNING_PROFILES,
} from "./channelLearning";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000; // fixed "now" — no real clock anywhere
const MIN = 60_000;

function msg(user: string, text: string, at: number): ChatMessage {
  return { id: `${user}-${at}-${Math.random()}`, user, text, timestamp: at };
}

/** Pre-send window: [sentAt - 60s, sentAt], observation: (sentAt, sentAt+30s]. */
function buildChatLog(opts: {
  sentAt: number;
  baselineHuman?: ChatMessage[];
  afterHuman?: ChatMessage[];
  afterBot?: ChatMessage[];
}): ChatMessage[] {
  return [...(opts.baselineHuman ?? []), ...(opts.afterHuman ?? []), ...(opts.afterBot ?? [])];
}

const BOTS = ["madbot", "otherbot"];

// ─── 1. Cold start = existing behavior ──────────────────────────────────────

console.log("\n[1] Cold start");
{
  const profile = emptyLearningProfile();
  check("empty profile → no self-performance block", buildSelfPerformanceContext(profile, T0) === null);
  check("empty profile → no per-action stats", getLearnedActionStats(profile, "short_reaction", T0) === null);
  const status = summarizeLearningStatus(profile, T0);
  check("status: 0 observations, confidence none", status.observations === 0 && status.confidence === "none");
}

// ─── 2. Below minimum samples → informational only ───────────────────────────

console.log("\n[2] Below minimum samples");
{
  let profile = emptyLearningProfile();
  profile = recordLearningOutcome(profile, "emote_only", 1, T0);
  profile = recordLearningOutcome(profile, "emote_only", 1, T0 + MIN);
  const view = getLearnedActionStats(profile, "emote_only", T0 + 2 * MIN)!;
  check("2 positive samples recorded", view !== null && view.samples === 2);
  check("not actionable below min effective weight", view.actionable === false);
  check("one lucky outcome does not dominate — score shrunk", Math.abs(view.score) < 0.3, `score=${view.score}`);
  check("confidence low", describeConfidence(view.confidence) === "low");
  check("no prompt injection without actionable evidence", buildSelfPerformanceContext(profile, T0 + 2 * MIN) === null);
}

// ─── 3. Repeated positive human outcomes → score rises gradually ────────────

console.log("\n[3] Gradual positive learning");
{
  let profile = emptyLearningProfile();
  const scores: number[] = [];
  for (let i = 0; i < 12; i++) {
    profile = recordLearningOutcome(profile, "short_reaction", 0.6, T0 + i * MIN);
    scores.push(getLearnedActionStats(profile, "short_reaction", T0 + i * MIN)!.score);
  }
  const rising = scores.every((s, i) => i === 0 || s >= scores[i - 1] - 1e-9);
  check("score rises gradually with repeated positive outcomes", rising, scores.map((s) => s.toFixed(2)).join(","));
  const final = getLearnedActionStats(profile, "short_reaction", T0 + 12 * MIN)!;
  check("becomes actionable once weight ≥ 3", final.actionable === true);
  check("score bounded well inside [-1, +1]", final.score > 0 && final.score < 0.6, `score=${final.score}`);
  const block = buildSelfPerformanceContext(profile, T0 + 12 * MIN)!;
  check("prompt block emitted once actionable", block.includes("short reaction"));
  check("block includes sample count and effectiveness", block.includes("12 samples") && block.includes("effectiveness"));
  check("block states advisory nature", block.includes("NOT an objective"));
  check("block subordinates to mentions/questions", block.includes("ALWAYS take priority"));
}

// ─── 4. Repeated negative/ignored outcomes → score falls gradually ──────────

console.log("\n[4] Gradual negative learning");
{
  let profile = emptyLearningProfile();
  for (let i = 0; i < 12; i++) {
    profile = recordLearningOutcome(profile, "full forge", -0.5, T0 + i * MIN);
  }
  const view = getLearnedActionStats(profile, "full forge", T0 + 12 * MIN)!;
  check("score negative after repeated ignored outcomes", view.score < -0.3, `score=${view.score}`);
  const block = buildSelfPerformanceContext(profile, T0 + 12 * MIN)!;
  check("block flags underperformance cautiously", block.includes("underperformed"));
}

// ─── 5. One outlier success cannot dominate ─────────────────────────────────

console.log("\n[5] Outlier resistance");
{
  let profile = emptyLearningProfile();
  // 20 mediocre outcomes (+0.05) then one viral hit (+1.0)
  for (let i = 0; i < 20; i++) profile = recordLearningOutcome(profile, "short_reaction", 0.05, T0 + i * MIN);
  profile = recordLearningOutcome(profile, "short_reaction", 1, T0 + 20 * MIN);
  const view = getLearnedActionStats(profile, "short_reaction", T0 + 21 * MIN)!;
  check("single outlier barely moves the average", Math.abs(view.score - 0.09) < 0.03, `score=${view.score}`);
}

// ─── 6. Old success + recent failure → recent evidence matters ──────────────

console.log("\n[6] Recency decay");
{
  const OLD = 20 * 24 * 60 * MIN; // 20 days
  let profile = emptyLearningProfile();
  // Old era: strong positives
  for (let i = 0; i < 10; i++) profile = recordLearningOutcome(profile, "short_reaction", 0.8, T0 - OLD + i * MIN);
  const beforeRecent = getLearnedActionStats(profile, "short_reaction", T0 - OLD + 10 * MIN)!;
  // Recent era: consistent failures
  for (let i = 0; i < 5; i++) profile = recordLearningOutcome(profile, "short_reaction", -0.8, T0 - 5 * MIN + i * MIN);
  const view = getLearnedActionStats(profile, "short_reaction", T0)!;
  check("old positive evidence decayed", view.effectiveWeight < 11, `weight=${view.effectiveWeight}`);
  check("recent failures pull score negative", view.score < 0, `score=${view.score}`);
  check("trend detects decline", view.trend === "declining", `trend=${view.trend}`);
  check("old-only era was positive", beforeRecent.score > 0.4, `old score=${beforeRecent.score}`);
}
{
  // Pure decay math: one sample loses exactly half its weight per half-life.
  let profile = emptyLearningProfile();
  profile = recordLearningOutcome(profile, "emote_only", 1, T0);
  const halfLife = 14 * 24 * 60 * MIN;
  const view = getLearnedActionStats(profile, "emote_only", T0 + halfLife)!;
  check("14-day half-life halves effective weight", Math.abs(view.effectiveWeight - 0.5) < 1e-6, `w=${view.effectiveWeight}`);
}

// ─── 7. Busy chat baseline → raw volume does not inflate success ────────────

console.log("\n[7] Busy-chat normalization");
{
  const sentAt = T0;
  // 100 msgs/min room: 100 human lines in the pre-window, same rate after.
  const baseline = Array.from({ length: 100 }, (_, i) => msg(`viewer${i % 20}`, `just chatting number ${i}`, sentAt - 60_000 + i * 600));
  const after = Array.from({ length: 50 }, (_, i) => msg(`viewer${i % 20}`, `still chatting about the game ${i}`, sentAt + 1 + i * 600));
  const outcome = computeNormalizedOutcome({ chatLog: buildChatLog({ sentAt, baselineHuman: baseline, afterHuman: after }), sentAt, evaluatedAt: sentAt + 30_000, botUsernames: BOTS });
  check("high-velocity continuation at baseline rate scores ~neutral", Math.abs(outcome.score) < 0.1, `score=${outcome.score}`);
  check("expected lines scale with baseline", outcome.expectedLines > 40, `expected=${outcome.expectedLines}`);
}
{
  // Quiet room, same message: a couple of human mentions = real signal.
  const sentAt = T0;
  const after = [msg("alice", "@madbot LOL that was great", sentAt + 5_000), msg("bob", "madbot nailed it", sentAt + 10_000)];
  const outcome = computeNormalizedOutcome({ chatLog: buildChatLog({ sentAt, afterHuman: after }), sentAt, evaluatedAt: sentAt + 30_000, botUsernames: BOTS, subjectUsername: "madbot" });
  check("human mentions produce positive score", outcome.score > 0.3, `score=${outcome.score}`);
  check("mentions counted for the subject bot", outcome.humanMentionsAfter === 2);
}
{
  // Mention-response discount: mentions after answering a direct mention
  // are worth slightly less (an active exchange already implies them).
  const sentAt = T0;
  const after = [msg("alice", "@madbot thanks!", sentAt + 5_000)];
  const direct = computeNormalizedOutcome({ chatLog: buildChatLog({ sentAt, afterHuman: after }), sentAt, evaluatedAt: sentAt + 30_000, botUsernames: BOTS, subjectUsername: "madbot", wasMentionResponse: true });
  const cold = computeNormalizedOutcome({ chatLog: buildChatLog({ sentAt, afterHuman: after }), sentAt, evaluatedAt: sentAt + 30_000, botUsernames: BOTS, subjectUsername: "madbot", wasMentionResponse: false });
  check("mention-response sends are discounted", direct.score < cold.score, `direct=${direct.score} cold=${cold.score}`);
}

// ─── 8. Bot-only replies are not human success ──────────────────────────────

console.log("\n[8] Multi-bot false-reward prevention");
{
  const sentAt = T0;
  const baseline = Array.from({ length: 6 }, (_, i) => msg(`viewer${i}`, "talking before", sentAt - 50_000 + i * 5_000));
  // Bot A sends; Bot B and Bot C pile on; humans ignore all of it.
  const botReplies = [msg("otherbot", "@madbot great point!!", sentAt + 3_000), msg("madbot", "thanks otherbot", sentAt + 8_000), msg("botc", "@madbot so true", sentAt + 12_000)];
  const outcome = computeNormalizedOutcome({ chatLog: buildChatLog({ sentAt, baselineHuman: baseline, afterBot: botReplies }), sentAt, evaluatedAt: sentAt + 30_000, botUsernames: ["madbot", "otherbot", "botc"], subjectUsername: "madbot" });
  check("bot lines excluded from human counts", outcome.humanLinesAfter === 0 && outcome.botLinesAfter === 3);
  check("bot-only replies do NOT produce positive score", outcome.score <= 0, `score=${outcome.score}`);
  check("bot mentions of the subject are not human mentions", outcome.humanMentionsAfter === 0);
  check("ignored-in-active-room yields mild negative", outcome.score < 0, `score=${outcome.score}`);
}
{
  // Dead room before AND after → neutral, never punished.
  const sentAt = T0;
  const outcome = computeNormalizedOutcome({ chatLog: buildChatLog({ sentAt }), sentAt, evaluatedAt: sentAt + 30_000, botUsernames: BOTS });
  check("dead-room send scores ~neutral (not the message's fault)", Math.abs(outcome.score) < 0.1, `score=${outcome.score}`);
}
{
  // collectBotUsernames: every configured bot + the legacy session name,
  // regardless of active status (deactivated bots' earlier lines are still
  // synthetic).
  const names = collectBotUsernames(
    [
      { active: true, session: { username: "BotA" } },
      { active: false, session: { username: "BotB" } },
      { active: true, session: null },
    ],
    "LegacyBot",
  );
  check("collectBotUsernames includes active + inactive + legacy", names.includes("bota") && names.includes("botb") && names.includes("legacybot"));
}

// ─── 9. Silence is first-class (capped, sparse, positive-only) ───────────────

console.log("\n[9] Silence evidence");
{
  // Room stays healthy without the bot → eligible, small positive.
  const decidedAt = T0;
  const baseline = Array.from({ length: 6 }, (_, i) => msg(`viewer${i}`, "chatting", decidedAt - 50_000 + i * 5_000));
  const after = Array.from({ length: 4 }, (_, i) => msg(`viewer${i}`, "still going", decidedAt + 5_000 + i * 5_000));
  const outcome = computeSilenceOutcome({ chatLog: [...baseline, ...after], decidedAt, evaluatedAt: decidedAt + 30_000, botUsernames: BOTS });
  check("sustained healthy room → silence eligible", outcome.eligible === true);
  check("silence score capped low", outcome.score <= 0.2);
}
{
  // Dead room → silence proves nothing.
  const outcome = computeSilenceOutcome({ chatLog: [], decidedAt: T0, evaluatedAt: T0 + 30_000, botUsernames: BOTS });
  check("dead room → silence NOT eligible", outcome.eligible === false);
}
{
  // Room died after silence → still not eligible (counterfactual unknowable).
  const decidedAt = T0;
  const baseline = Array.from({ length: 6 }, (_, i) => msg(`viewer${i}`, "chatting", decidedAt - 50_000 + i * 5_000));
  const outcome = computeSilenceOutcome({ chatLog: baseline, decidedAt, evaluatedAt: decidedAt + 30_000, botUsernames: BOTS });
  check("room died after silence → not eligible (no fabricated negative)", outcome.eligible === false);
}
{
  // Cadence gate: at most one silence observation per 10 minutes.
  let profile = emptyLearningProfile();
  check("first silence may be observed", shouldRecordSilenceObservation(profile, T0) === true);
  profile = recordLearningOutcome(profile, SILENCE_ACTION, 0.2, T0, SILENCE_SAMPLE_WEIGHT);
  check("immediate repeat blocked by cadence gate", shouldRecordSilenceObservation(profile, T0 + MIN) === false);
  check("after 10 minutes another observation allowed", shouldRecordSilenceObservation(profile, T0 + 10 * MIN + 1) === true);
}
{
  // Even unbounded silence evidence can never dominate: capped score ×
  // low sample weight + shrinkage bounds the adjusted score below the cap.
  let profile = emptyLearningProfile();
  for (let i = 0; i < 50; i++) profile = recordLearningOutcome(profile, SILENCE_ACTION, 0.2, T0 + i * 10 * MIN, SILENCE_SAMPLE_WEIGHT);
  const view = getLearnedActionStats(profile, SILENCE_ACTION, T0 + 500 * MIN)!;
  check("silence score structurally capped below 0.2 even after 50 observations", view.score < 0.2, `score=${view.score}`);
  const block = buildSelfPerformanceContext(profile, T0 + 500 * MIN)!;
  check("silence rendered as restraint guidance, not an instruction", block.includes("restraint") && block.includes("silence remains"));
}

// ─── 10. Channel isolation + reset scoping (pure map semantics) ─────────────

console.log("\n[10] Channel scoping");
{
  check("channel keys normalize (#Foo → foo)", learningProfileKey("#Foo ") === "foo");
  let profiles: Record<string, ReturnType<typeof emptyLearningProfile>> = {};
  profiles["alpha"] = recordLearningOutcome(emptyLearningProfile(), "short_reaction", 0.5, T0);
  profiles["beta"] = recordLearningOutcome(emptyLearningProfile(), "emote_only", -0.5, T0);
  check("channel A and B keep independent profiles", profiles["alpha"].actions["short_reaction"]?.sampleCount === 1 && profiles["beta"].actions["emote_only"]?.sampleCount === 1);
  const reset = { ...profiles } as Record<string, unknown>;
  delete (reset as Record<string, never>)["alpha"];
  check("resetting A leaves B untouched", "beta" in reset && !("alpha" in reset));
}
{
  // Map pruning: oldest channels dropped beyond the cap.
  const profiles: Record<string, ReturnType<typeof emptyLearningProfile>> = {};
  for (let i = 0; i < MAX_LEARNING_PROFILES + 5; i++) {
    profiles[`ch${i}`] = recordLearningOutcome(emptyLearningProfile(), "emote_only", 0.1, T0 + i * MIN);
  }
  const pruned = pruneLearningProfiles(profiles);
  check("pruning caps the profile map at the limit", Object.keys(pruned).length === MAX_LEARNING_PROFILES);
  check("pruning keeps the newest channels", pruned[`ch${MAX_LEARNING_PROFILES + 4}`] !== undefined && pruned["ch0"] === undefined);
}

// ─── 11. Malformed persisted data → safe fallback ───────────────────────────

console.log("\n[11] Malformed data");
{
  check("null → fresh profile", sanitizeLearningProfile(null).overallSampleCount === 0);
  check("garbage → fresh profile", sanitizeLearningProfile("nonsense").actions !== undefined);
  const partial = sanitizeLearningProfile({
    version: 1,
    actions: {
      good: { sampleCount: 2, effectiveWeight: 1.5, weightedOutcome: 0.9, recentEffectiveWeight: 1.5, recentWeightedOutcome: 0.9, lastObservedAt: T0 },
      bad: { sampleCount: "many", effectiveWeight: NaN },
      empty: { sampleCount: 0, effectiveWeight: 0 },
    },
    overallSampleCount: -5,
    lastUpdatedAt: "yesterday",
  });
  check("valid entries survive sanitization", partial.actions["good"]?.sampleCount === 2);
  check("invalid entries dropped", partial.actions["bad"] === undefined && partial.actions["empty"] === undefined);
  check("negative overall count clamped", partial.overallSampleCount === 0);
  check("invalid timestamp dropped", partial.lastUpdatedAt === undefined);
}

// ─── 12. Session goals: bounded steering pressure ───────────────────────────

console.log("\n[12] Session goals pressure");
{
  const goal = (met: boolean, enabled = true): GoalEvaluationResult => ({
    goalId: "g1", goalType: met ? "maxSilenceRatio" : "mentionResponseRate", label: met ? "Silence ratio" : "Mention response",
    current: met ? 52 : 61, target: met ? 65 : 80, progress: 0.6, met, enabled,
  });
  check("no goals → no block", buildSessionGoalsContext([]) === null);
  check("all goals disabled → no block", buildSessionGoalsContext([goal(false, false)]) === null);
  check("all goals met → no pressure block", buildSessionGoalsContext([goal(true)]) === null);
  const block = buildSessionGoalsContext([goal(false), goal(true)])!;
  check("unmet goal produces bounded steering block", block.includes("behind"));
  check("block frames goals as gentle, never KPIs", block.includes("GENTLE STEERING PRESSURE") && block.includes("Never force activity"));
  check("met goals shown as healthy alongside", block.includes("healthy"));
}

// ─── 13. Diagnostics + status ───────────────────────────────────────────────

console.log("\n[13] Observability");
{
  let profile = emptyLearningProfile();
  for (let i = 0; i < 10; i++) profile = recordLearningOutcome(profile, "short_reaction", 0.5, T0 + i * MIN);
  for (let i = 0; i < 6; i++) profile = recordLearningOutcome(profile, "emote_only", -0.3, T0 + i * MIN);
  const diag = getLearningDiagnostics(profile, T0 + 10 * MIN);
  check("diagnostics include per-action samples/score/confidence", diag.actions["short_reaction"]?.samples === 10 && typeof diag.actions["emote_only"]?.score === "number");
  check("diagnostics scores rounded to 2 decimals", Number.isInteger(diag.actions["short_reaction"]!.score * 100));
  const status = summarizeLearningStatus(profile, T0 + 10 * MIN);
  check("status summarizes observations + confidence", status.observations === 16 && status.confidence !== "none");
  const view = getLearnedActionStats(profile, "short_reaction", T0 + 10 * MIN)!;
  check("readable confidence labels (no fake precision)", ["high", "medium", "low"].includes(describeConfidence(view.confidence)));
}

// ─── 14. Bounded influence under adversarial inputs ─────────────────────────

console.log("\n[14] Bounded influence");
{
  let profile = emptyLearningProfile();
  for (let i = 0; i < 100; i++) {
    profile = recordLearningOutcome(profile, "full forge", 10, T0 + i * MIN);    // over-range
    profile = recordLearningOutcome(profile, "emote only", -10, T0 + i * MIN);  // over-range + odd key
  }
  const over = getLearnedActionStats(profile, "full forge", T0 + 100 * MIN)!;
  const under = getLearnedActionStats(profile, "emote only", T0 + 100 * MIN)!;
  check("over-range scores clamped to +1 input", over.rawScore === 1, `raw=${over.rawScore}`);
  check("under-range scores clamped to -1 input", under.rawScore === -1);
  check("shrunk scores stay strictly inside (-1, +1)", over.score < 1 && under.score > -1);
  check("confidence never reaches 1.0", over.confidence < 1);
  // Action-type cap: stale/renamed taxonomies pruned to a bounded set.
  let many = emptyLearningProfile();
  for (let i = 0; i < 20; i++) many = recordLearningOutcome(many, `action_${i}`, 0.1, T0 + i * MIN);
  check("tracked action types capped", Object.keys(many.actions).length <= 12);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failed} checks passed${failed ? `; ${failed} FAILED` : ""}.`);
if (failed > 0) process.exit(1);
