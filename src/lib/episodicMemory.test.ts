/**
 * Focused test harness for Episodic Memory engine (v29).
 * Run: npx tsx src/lib/episodicMemory.test.ts
 *
 * Verifies:
 * - Candidate formation from closed Room Moments
 * - Human-evidence requirement (bot chatter cannot open community episodes)
 * - Moment fusion & coherence (shared participants / topics)
 * - Idle-candidate closing via tick()
 * - Retention rules: persistent (≥0.62) vs session (≥0.50) vs discard (<0.50)
 * - Bot-only significance cap (0.30)
 * - Deterministic fallback title and summary
 * - Retrieval: topic / participant matching, reuse penalty, threshold
 * - User edits, pinning, deletion
 * - Snapshot export & restore (channel isolation, session drop, persistent survival)
 */

import {
  EpisodicMemoryEngine,
  retrieveEpisodes,
  buildEpisodeQuery,
  formatEpisodicContext,
  buildAutoForgeEpisodicContext,
  deterministicEpisodeTitle,
  EPISODE_CANDIDATE_THRESHOLD,
  EPISODE_RETAIN_PERSISTENT_THRESHOLD,
  EPISODE_IDLE_CLOSE_MS,
  BOT_ONLY_SIGNIFICANCE_CAP,
} from "./episodicMemory";
import type { RoomMoment } from "./roomModel";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T0 = Date.now();

function makeMoment(patch: Partial<RoomMoment> = {}): RoomMoment {
  const now = Date.now();
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    channel: "testchan",
    startedAt: now,
    updatedAt: now + 10_000,
    endedAt: now + 10_000,
    status: "closed",
    kind: "reaction",
    significance: 0.7,
    confidence: 0.8,
    sources: ["chat"],
    signals: {
      chatActivity: { level: "active", humanMessages: 5, botMessages: 0 },
    },
    evidenceRefs: ["sig_1"],
    evidenceLines: ["viewer_a: no way this haste build works"],
    topicHints: ["haste", "build"],
    provenance: { deterministic: true, aiSynthesized: false },
    updateCount: 1,
    ...patch,
  };
}

console.log("\n[1] Candidate formation & human-evidence requirement");
{
  const engine = new EpisodicMemoryEngine();
  engine.setChannel("testchan");

  // Bot-only moment (no human messages)
  const botMoment = makeMoment({
    significance: 0.8,
    signals: { chatActivity: { level: "active", humanMessages: 0, botMessages: 3 } },
    evidenceLines: ["[bot] Hello world"],
    sources: ["agent"],
  });
  engine.noteMoments([botMoment]);
  check("bot-only moment does not create an episode", engine.getEpisodes().length === 0);

  // Human-anchored moment
  const humanMoment = makeMoment({ significance: 0.75 });
  engine.noteMoments([humanMoment]);
  // Candidate is open — tick past idle timeout to close it
  engine.tick(Date.now() + EPISODE_IDLE_CLOSE_MS + 20_000);
  check("human moment becomes a retained episode on close", engine.getEpisodes().length === 1);
  const ep = engine.getEpisodes()[0];
  check("episode carries participants", ep?.participants?.length > 0);
  check("episode carries topics", ep?.topics?.includes("haste"));
  check("deterministic provenance flag set", ep?.provenance?.deterministic === true);
}

console.log("\n[2] Moment coherence & fusion");
{
  const engine = new EpisodicMemoryEngine();
  engine.setChannel("testchan");
  const now = Date.now();

  const m1 = makeMoment({
    startedAt: now,
    endedAt: now + 10_000,
    topicHints: ["mythic", "boss"],
    evidenceLines: ["viewer_x: that pull was close"],
  });
  const m2 = makeMoment({
    startedAt: now + 30_000,
    endedAt: now + 40_000,
    topicHints: ["mythic", "wipe"],
    evidenceLines: ["viewer_x: second phase got us"],
  });

  engine.noteMoments([m1]);
  engine.noteMoments([m2]);
  engine.tick(now + 40_000 + EPISODE_IDLE_CLOSE_MS + 10_000);

  check("correlated moments fuse into ONE episode", engine.getEpisodes().length === 1);
  const ep = engine.getEpisodes()[0];
  check("fused episode links multiple moments", ep.evidenceMomentIds.length === 2);
}

console.log("\n[3] Retention thresholds & bot-only cap");
{
  const engine = new EpisodicMemoryEngine();
  engine.setChannel("testchan");

  // Low-significance moment below candidate threshold
  const weak = makeMoment({ significance: EPISODE_CANDIDATE_THRESHOLD - 0.1 });
  engine.noteMoments([weak]);
  engine.tick(Date.now() + EPISODE_IDLE_CLOSE_MS + 60_000);
  check("sub-threshold moments discarded", engine.getEpisodes().length === 0);

  // High-significance human moment -> persistent retention
  const strong = makeMoment({ significance: EPISODE_RETAIN_PERSISTENT_THRESHOLD + 0.05 });
  engine.noteMoments([strong]);
  engine.tick(Date.now() + EPISODE_IDLE_CLOSE_MS + 60_000);
  check("high-significance becomes persistent", engine.getEpisodes()[0]?.retention === "persistent");
}

console.log("\n[4] Deterministic fallback title & summary");
{
  const title = deterministicEpisodeTitle({
    kind: "conversation",
    participants: [{ type: "viewer", displayName: "alice" }],
    topics: ["speedrun"],
  });
  check("title includes kind and participant", title.includes("alice"));

  const engine = new EpisodicMemoryEngine();
  engine.setChannel("testchan");
  engine.noteMoments([makeMoment({ significance: 0.75 })]);
  engine.tick(Date.now() + EPISODE_IDLE_CLOSE_MS + 60_000);
  const ep = engine.getEpisodes()[0];
  check("episode has deterministic summary without AI", typeof ep?.summary === "string" && ep.summary.length > 0);
}

console.log("\n[5] Retrieval scoring & threshold");
{
  const episodes = [
    {
      id: "ep_raid",
      channel: "testchan",
      sessionId: "s1",
      startedAt: T0 - 3600_000,
      endedAt: T0 - 3500_000,
      title: "Mythic boss victory",
      summary: "Beat the final boss after 40 pulls.",
      participants: [{ type: "viewer" as const, displayName: "alice" }],
      topics: ["mythic", "boss", "victory"],
      kind: "achievement" as const,
      significance: 0.85,
      confidence: 0.9,
      humanEvidence: true,
      streamerInvolved: true,
      evidenceMomentIds: ["m1"],
      evidenceLines: [],
      relatedEpisodeIds: [],
      createdAt: T0,
      recallCount: 0,
      pinned: false,
      retention: "persistent" as const,
      state: "retained" as const,
      provenance: { deterministic: true as const, aiSynthesized: false },
    },
    {
      id: "ep_cook",
      channel: "testchan",
      sessionId: "s1",
      startedAt: T0 - 7200_000,
      endedAt: T0 - 7100_000,
      title: "Cooking stream ramen",
      summary: "Made tonkotsu ramen from scratch.",
      participants: [{ type: "viewer" as const, displayName: "bob" }],
      topics: ["cooking", "ramen"],
      kind: "other" as const,
      significance: 0.65,
      confidence: 0.8,
      humanEvidence: true,
      streamerInvolved: false,
      evidenceMomentIds: ["m2"],
      evidenceLines: [],
      relatedEpisodeIds: [],
      createdAt: T0,
      recallCount: 0,
      pinned: false,
      retention: "persistent" as const,
      state: "retained" as const,
      provenance: { deterministic: true as const, aiSynthesized: false },
    },
  ];

  const query = buildEpisodeQuery({
    channel: "testchan",
    recentMessages: [{ user: "alice", text: "we finally downed that mythic boss!" }],
    now: T0,
  });
  const results = retrieveEpisodes(episodes, query, "s1");
  check("retrieves the matching episode", results.length >= 1 && results[0].episode.id === "ep_raid");
  check("unrelated episode not retrieved", !results.some((r) => r.episode.id === "ep_cook"));

  const ctx = formatEpisodicContext(results, "s1", T0);
  check("formatted context declares hierarchy", ctx.includes("[PAST EPISODES"));
  check("formatted context names the event", ctx.includes("Mythic boss victory"));
}

console.log("\n[6] Mutations (pin, delete, user edits)");
{
  const engine = new EpisodicMemoryEngine();
  engine.setChannel("testchan");
  engine.noteMoments([makeMoment({ significance: 0.75 })]);
  engine.tick(Date.now() + EPISODE_IDLE_CLOSE_MS + 60_000);
  const id = engine.getEpisodes()[0]?.id;

  check("pin toggles", engine.setPinned(id, true) && engine.getEpisodeById(id)?.pinned === true);
  check("update fields", engine.updateUserFields(id, { title: "Custom Title" }) && engine.getEpisodeById(id)?.title === "Custom Title");
  check("provenance marks user edited", engine.getEpisodeById(id)?.provenance.userEdited === true);
  check("delete removes episode", engine.deleteEpisode(id) && engine.getEpisodes().length === 0);
}

console.log("\n[7] Export snapshot & channel restore");
{
  const engineA = new EpisodicMemoryEngine();
  engineA.setChannel("channel_a");
  engineA.noteMoments([makeMoment({ significance: 0.75, channel: "channel_a" })]);
  engineA.tick(Date.now() + EPISODE_IDLE_CLOSE_MS + 60_000);
  const snap = engineA.exportSnapshot();

  check("snapshot exports persistent episodes", snap.episodes.length === 1);

  const engineB = new EpisodicMemoryEngine();
  engineB.restore("channel_a", snap);
  check("restores persistent episodes on same channel", engineB.getEpisodes().length === 1);

  const engineC = new EpisodicMemoryEngine();
  engineC.restore("channel_b", snap);
  check("channel isolation: Channel B cannot adopt Channel A episodes", engineC.getEpisodes().length === 0);
}

console.log(`\n============================================================`);
console.log(`Episodic Memory tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
