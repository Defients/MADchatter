/**
 * SemanticCoordination — deterministic test harness.
 *
 * Run with: npx tsx src/lib/semanticCoordination.test.ts
 *
 * Covers the semantic multi-bot coordination contract: persona-fit
 * differentiation, direct-mention obligation, cross-bot redundancy,
 * complementarity, dogpile/saturation/loop restraint, collective silence,
 * greeting cohort spacing, Supercharge bounds, tiebreak determinism, and
 * channel/async safety. Everything runs through the pure functions, the
 * engine, or the simulation harness with explicit timestamps — no timers,
 * no UI, no providers.
 */

import {
  SEMANTIC_COORDINATION_LIMITS,
  SEMANTIC_COORDINATION_WEIGHTS,
  SemanticCoordinationEngine,
  classifyOpportunity,
  computeSemanticFit,
  deriveCoordinationProfile,
  extractKeywords,
  previewSemanticFit,
  runCoordinationSimulation,
  semanticCoordination,
  type ConversationOpportunity,
  type CoordinationSimulationInput,
  type CoordinationSimulationResult,
  type ResponseFunction,
  type SemanticBidRequest,
} from "./semanticCoordination";
import type { ForgeConfig } from "../types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; failures.push(msg); console.error(`  FAIL: ${msg}`); }
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▸ ${name}`);
  try { await fn(); } catch (e: any) {
    failed++; failures.push(`${name}: threw ${e?.message ?? e}`); console.error(`  FAIL: threw ${e?.message ?? e}`);
  }
}

const NOW = 1_000_000;

// Personas (flat affinity maps — the simulation merges them onto neutral
// defaults so every unspecified affinity stays at baseline).
const ANALYST = { analysis: 0.9, humor: 0.3 };
const GREMLIN = { humor: 0.9, analysis: 0.2, conciseReaction: 0.65 };
const SUPPORT = { empathy: 0.9 };

function sim(input: CoordinationSimulationInput): CoordinationSimulationResult {
  return runCoordinationSimulation({ now: NOW, ...input });
}

function makeConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    provider: "openai",
    humorLevel: 50,
    chaosLevel: 50,
    customDirectives: "",
    activeProfiles: [],
    primaryProfile: "",
    emoteDensity: "moderate",
    toxicityFilter: "standard",
    lengthPreference: "medium",
    voiceContextEnabled: false,
    additionalInstructions: "",
    generationMode: "single_profile",
    ...overrides,
  };
}

function bidOf(result: CoordinationSimulationResult, botId: string) {
  return result.bids.find((b) => b.botId === botId);
}

function questionOpp(overrides: Partial<ConversationOpportunity> = {}): ConversationOpportunity {
  return {
    id: "opp_test",
    timestamp: NOW,
    source: "topic",
    targetBotIds: [],
    topicHints: ["haste", "better"],
    responseFunctions: ["answer", "analyze", "clarify"],
    urgency: 0.6,
    confidence: 0.6,
    humanOriginated: true,
    humanThreadActive: false,
    evidenceRefs: [],
    ...overrides,
  };
}

// ─── Persona projection ───────────────────────────────────────────────────────

await runTest("deriveCoordinationProfile maps analyst/gremlin/hype/support profiles", () => {
  const analyst = deriveCoordinationProfile(makeConfig({ activeProfiles: ["analyst"] }), "b1");
  const gremlin = deriveCoordinationProfile(makeConfig({ activeProfiles: ["gremlin"] }), "b2");
  assert(analyst.affinities.analysis === 0.9, `analyst analysis should be 0.9, got ${analyst.affinities.analysis}`);
  assert(gremlin.affinities.humor === 0.9, `gremlin humor should be 0.9, got ${gremlin.affinities.humor}`);
  const hype = deriveCoordinationProfile(makeConfig({ activeProfiles: ["hype"] }), "b3");
  assert(hype.affinities.hype === 0.9, "hype profile should carry hype 0.9");
  const support = deriveCoordinationProfile(makeConfig({ activeProfiles: ["support"] }), "b4");
  assert(support.affinities.empathy === 0.9, "support profile should carry empathy 0.9");
});

await runTest("humorLevel slider contributes without masquerading as semantics", () => {
  const funny = deriveCoordinationProfile(makeConfig({ humorLevel: 100 }), "b1");
  assert(funny.affinities.humor >= 0.85, `humorLevel 100 should raise humor affinity, got ${funny.affinities.humor}`);
  const gremlin = deriveCoordinationProfile(makeConfig({ activeProfiles: ["gremlin"], humorLevel: 10 }), "b2");
  assert(gremlin.affinities.humor === 0.9, "persona identity dominates a low humor slider (gremlin stays 0.9)");
});

await runTest("directive keywords become persona topic hints", () => {
  const p = deriveCoordinationProfile(
    makeConfig({ customDirectives: "Always discuss speedrunning, frame data, and routing optimization." }),
    "b1",
  );
  assert(p.topicHints.includes("speedrunning"), `expected speedrunning hint, got ${JSON.stringify(p.topicHints)}`);
  assert(p.topicHints.includes("routing"), "expected routing hint");
});

await runTest("extractKeywords is deterministic and stopword-filtered", () => {
  const a = extractKeywords("the build is cooked, the build is cooked", 5);
  const b = extractKeywords("the build is cooked, the build is cooked", 5);
  assert(JSON.stringify(a) === JSON.stringify(b), "extraction must be deterministic");
  assert(!a.includes("the"), "stopwords must be filtered");
  assert(a[0] === "build" || a[0] === "cooked", `frequency-first ordering expected, got ${JSON.stringify(a)}`);
});

// ─── Semantic persona fit ─────────────────────────────────────────────────────

await runTest("analytical question: analyst persona is favored", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["answer", "analyze", "clarify"] },
    bots: [
      { botId: "analyst", confidence: 0.7, persona: ANALYST },
      { botId: "gremlin", confidence: 0.7, persona: GREMLIN },
    ],
  });
  assert(result.winner === "analyst", `analyst should win the question, got ${result.winner}`);
  assert(bidOf(result, "analyst")!.semanticFit > bidOf(result, "gremlin")!.semanticFit,
    "analyst fit should exceed gremlin fit on a question");
});

await runTest("comedic opening: gremlin persona is favored", () => {
  const result = sim({
    opportunity: { source: "room_event", responseFunctions: ["react", "hype", "joke"] },
    bots: [
      { botId: "analyst", confidence: 0.7, persona: ANALYST },
      { botId: "gremlin", confidence: 0.7, persona: GREMLIN },
    ],
  });
  assert(result.winner === "gremlin", `gremlin should win the comedic opening, got ${result.winner}`);
});

await runTest("computeSemanticFit: different personas win different opportunities", () => {
  const analyst = deriveCoordinationProfile(makeConfig({ activeProfiles: ["analyst"] }), "a");
  const gremlin = deriveCoordinationProfile(makeConfig({ activeProfiles: ["gremlin"] }), "g");
  const question = questionOpp();
  const joke = questionOpp({ source: "room_event", responseFunctions: ["react", "hype", "joke"] });
  const candidate = { decision: "full_forge", confidence: 0.7, personaFit: 0.5 };
  assert(
    computeSemanticFit(question, analyst, candidate) > computeSemanticFit(question, gremlin, candidate),
    "analyst fits a question better than gremlin",
  );
  assert(
    computeSemanticFit(joke, gremlin, candidate) > computeSemanticFit(joke, analyst, candidate),
    "gremlin fits a comedic moment better than analyst",
  );
});

await runTest("previewSemanticFit bumps for mentions and stays bounded", () => {
  const p = deriveCoordinationProfile(makeConfig({ activeProfiles: ["analyst"] }), "a");
  const base = previewSemanticFit(p, { questionPending: true });
  const mentioned = previewSemanticFit(p, { questionPending: true, isMentioned: true });
  assert(mentioned > base, "mention should bump the preview fit");
  assert(base >= 0 && base <= 1 && mentioned <= 1, "preview fit must stay in [0,1]");
});

// ─── Direct mentions ──────────────────────────────────────────────────────────

await runTest("direct @BotB: BotB wins despite BotA's higher confidence", () => {
  const result = sim({
    bots: [
      { botId: "botA", confidence: 0.9, persona: GREMLIN },
      { botId: "botB", confidence: 0.5, persona: SUPPORT, candidate: { isMentioned: true, targetUsername: "someuser" } },
    ],
  });
  assert(result.winner === "botB", `directly addressed botB should win, got ${result.winner}`);
  const a = bidOf(result, "botA")!;
  assert(a.disposition === "defer", `botA should defer, got ${a.disposition}`);
  assert(a.targetStealPenalty === 1, "non-target should carry the steal penalty");
});

await runTest("target bot unavailable: open competition with clear outcome", () => {
  const result = sim({
    bots: [
      { botId: "botA", confidence: 0.9, persona: GREMLIN },
      { botId: "botB", confidence: 0.05, persona: SUPPORT, candidate: { isMentioned: true } },
    ],
  });
  assert(result.winner === "botA", `strong non-mentioned bot should win, got ${result.winner}`);
  assert(result.outcome === "direct_target_unavailable", `expected direct_target_unavailable, got ${result.outcome}`);
});

await runTest("streamer callout (audio mention) gives the target priority", () => {
  const result = sim({
    bots: [
      { botId: "botA", confidence: 0.9, persona: GREMLIN },
      { botId: "botB", confidence: 0.5, persona: SUPPORT, candidate: { isMentioned: true, mentionSource: "audio", targetUsername: "streamer" } },
    ],
  });
  assert(result.winner === "botB", `streamer-called-out botB should win, got ${result.winner}`);
});

await runTest("generic 'bots?' — multiple mentioned targets compete on fit", () => {
  const result = sim({
    bots: [
      { botId: "botA", confidence: 0.5, persona: GREMLIN, candidate: { isMentioned: true } },
      { botId: "botB", confidence: 0.5, persona: ANALYST, candidate: { isMentioned: true } },
    ],
    opportunity: { source: "direct_mention", responseFunctions: ["answer", "analyze", "clarify"] },
  });
  assert(result.winner === "botB", `both mentioned → semantic fit decides (analyst), got ${result.winner}`);
  const a = bidOf(result, "botA")!;
  assert(a.targetStealPenalty === 0, "co-targets must not steal-penalize each other");
});

// ─── Cross-bot redundancy / complementarity ──────────────────────────────────

await runTest("same topic + same function: duplicate suppressed into silence", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["answer", "analyze", "clarify"], topicHints: ["haste", "better"] },
    recentLedger: [
      { speakerType: "human", speakerId: "viewer", message: "does haste or crit sim better here?", timestamp: NOW - 8000 },
      { speakerType: "bot", speakerId: "botB", message: "haste pulls ahead because cooldown windows line up", responseFunction: "analyze", timestamp: NOW - 2000 },
    ],
    bots: [
      { botId: "botC", confidence: 0.7, persona: ANALYST, candidate: { payload: "yeah haste is better because it aligns with cooldowns" } },
    ],
  });
  const c = bidOf(result, "botC")!;
  assert(c.redundancyPenalty >= 0.5, `functional duplicate should carry redundancy, got ${c.redundancyPenalty}`);
  assert(result.winner === null, `duplicate should be suppressed (silence), got winner ${result.winner}`);
});

await runTest("same topic + different function: complementary angle allowed", () => {
  // Example E framing: BotB already answered the question; BotA's punchline
  // is a REACTION to the answered moment (room_event: react/hype/joke), not
  // another answer to the question. Different function → allowed.
  const result = sim({
    opportunity: { source: "room_event", responseFunctions: ["react", "hype", "joke"], topicHints: ["haste", "better"] },
    recentLedger: [
      { speakerType: "human", speakerId: "viewer", message: "does haste or crit sim better here?", timestamp: NOW - 8000 },
      { speakerType: "bot", speakerId: "botB", message: "haste pulls ahead because cooldown windows line up", responseFunction: "analyze", timestamp: NOW - 2000 },
    ],
    bots: [
      { botId: "botA", confidence: 0.7, persona: GREMLIN, candidate: { payload: "crit build found dead in a ditch lmao" } },
    ],
  });
  const a = bidOf(result, "botA")!;
  assert(a.redundancyPenalty <= 0.3, `different-function angle should stay light, got ${a.redundancyPenalty}`);
  assert(result.winner === "botA", `complementary angle should be allowed, got ${result.winner}`);
});

await runTest("isCrossBotDuplicate catches exact and paraphrased duplicates", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("dupchan");
  engine.noteBotSend({ channel: "dupchan", botId: "botA", message: "that build is cooked", timestamp: NOW - 1000 });
  assert(engine.isCrossBotDuplicate("botB", "that build is cooked", NOW), "exact duplicate should be caught");
  assert(engine.isCrossBotDuplicate("botB", "the build is cooked", NOW), "paraphrase duplicate should be caught");
  assert(!engine.isCrossBotDuplicate("botB", "witness protection program entered", NOW), "different angle should pass");
  assert(!engine.isCrossBotDuplicate("botA", "that build is cooked", NOW), "own sends must not count as cross-bot");
});

// ─── Speaker balance ──────────────────────────────────────────────────────────

await runTest("bot spoke recently: modest penalty applies", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["answer", "analyze", "clarify"] },
    recentLedger: [
      { speakerType: "human", speakerId: "viewer", message: "which spec sims better for m+ dungeons tonight", timestamp: NOW - 8000 },
      { speakerType: "bot", speakerId: "botA", message: "lol yeah", timestamp: NOW - 10000 },
    ],
    bots: [
      { botId: "botA", confidence: 0.7, persona: ANALYST },
      { botId: "botB", confidence: 0.7, persona: ANALYST },
    ],
  });
  const a = bidOf(result, "botA")!;
  const b = bidOf(result, "botB")!;
  assert(a.recentSpeakerPenalty > 0, "recent speaker should carry a penalty");
  assert(b.recentSpeakerPenalty === 0, "quiet bot should carry no penalty");
  assert(result.winner === "botB", `equal bids — quiet bot should win, got ${result.winner}`);
});

await runTest("quiet bot with poor fit does not win from fairness alone", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["answer", "analyze", "clarify"] },
    bots: [
      { botId: "analyst", confidence: 0.7, persona: ANALYST },
      { botId: "gremlin", confidence: 0.6, persona: GREMLIN, candidate: { firstMessagePending: true } },
    ],
  });
  assert(result.winner === "analyst", `semantic fit must beat fairness pressure, got ${result.winner}`);
});

await runTest("repeated winner with genuinely best fit may keep winning", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["answer", "analyze", "clarify"] },
    recentLedger: [
      { speakerType: "human", speakerId: "viewer", message: "which trinket sims better for single target", timestamp: NOW - 30000 },
      { speakerType: "bot", speakerId: "analyst", message: "the on-use trinket pulls ahead on single target", timestamp: NOW - 60000 },
    ],
    bots: [
      { botId: "analyst", confidence: 0.7, persona: ANALYST },
      { botId: "gremlin", confidence: 0.7, persona: GREMLIN },
    ],
  });
  assert(result.winner === "analyst", `best-fit bot should survive the speaker penalty, got ${result.winner}`);
});

// ─── Human priority & restraint ──────────────────────────────────────────────

await runTest("healthy human thread: bots collectively defer", () => {
  const result = sim({
    bots: [
      { botId: "botA", confidence: 0.5, persona: ANALYST },
      { botId: "botB", confidence: 0.5, persona: GREMLIN },
    ],
    recentLedger: [
      { speakerType: "human", speakerId: "alice", message: "that boss fight was insane", timestamp: NOW - 10000 },
      { speakerType: "human", speakerId: "bob", message: "right?? clutch save at the end", timestamp: NOW - 20000 },
    ],
  });
  assert(result.winner === null, `healthy human thread should defer to silence, got ${result.winner}`);
  const a = bidOf(result, "botA")!;
  assert(a.interruptionPenalty > 0, "healthy thread should raise interruption penalty");
});

await runTest("high bot saturation suppresses nonessential bids", () => {
  const ledger: CoordinationSimulationInput["recentLedger"] = [];
  // 16 bot + 4 human messages, trailing 3 bot entries (below loop threshold).
  for (let i = 0; i < 4; i++) {
    ledger.push({ speakerType: "human", speakerId: `viewer${i}`, message: `nice play number ${i}`, timestamp: NOW - 40000 - i * 1000 });
  }
  for (let i = 0; i < 13; i++) {
    ledger.push({ speakerType: "bot", speakerId: "botA", message: `bot chatter line ${i}`, timestamp: NOW - 35000 + i * 100 });
  }
  ledger.push({ speakerType: "bot", speakerId: "botA", message: "more bot chatter", timestamp: NOW - 3000 });
  ledger.push({ speakerType: "bot", speakerId: "botA", message: "even more bot chatter", timestamp: NOW - 2000 });
  ledger.push({ speakerType: "bot", speakerId: "botA", message: "bot chatter again", timestamp: NOW - 1000 });
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["react", "analyze"] },
    recentLedger: ledger,
    bots: [
      { botId: "botB", confidence: 0.5, persona: ANALYST },
      { botId: "botC", confidence: 0.5, persona: GREMLIN },
    ],
  });
  assert(bidOf(result, "botB")!.saturationPenalty >= 0.4, `saturation should bite, got ${bidOf(result, "botB")!.saturationPenalty}`);
  assert(result.winner === null, `saturated ensemble should stay silent, got ${result.winner}`);
});

await runTest("bot-only streak triggers loop suppression", () => {
  const ledger: CoordinationSimulationInput["recentLedger"] = [];
  for (let i = 0; i < 5; i++) {
    ledger.push({ speakerType: "bot", speakerId: `bot${i}`, message: `bot to bot exchange ${i}`, timestamp: NOW - 5000 + i * 500 });
  }
  const result = sim({
    recentLedger: ledger,
    bots: [
      { botId: "botA", confidence: 0.9, persona: GREMLIN },
      { botId: "botB", confidence: 0.9, persona: GREMLIN },
    ],
  });
  assert(result.outcome === "all_suppressed", `bot-only loop should suppress, got ${result.outcome}`);
  assert(result.winner === null, "loop suppression must yield no winner");
});

await runTest("bot sends never count as human momentum", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("loopchan");
  for (let i = 0; i < 6; i++) {
    engine.noteBotSend({ channel: "loopchan", botId: "botA", message: `bots talking to themselves ${i}`, timestamp: NOW - 6000 + i * 1000 });
  }
  const requests: SemanticBidRequest[] = [
    { botId: "botA", enqueuedAt: NOW, candidate: { decision: "full_forge", confidence: 0.7, personaFit: 0.5 } },
    { botId: "botB", enqueuedAt: NOW + 1, candidate: { decision: "full_forge", confidence: 0.7, personaFit: 0.5 } },
  ];
  const opp = classifyOpportunity({ requests, ledger: engine.getLedgerSnapshot(), now: NOW });
  assert(opp.humanThreadActive === false, "bot-only chatter must not look like a human thread");
  assert(opp.humanOriginated === false, "bot-only chatter must not count as human-originated");
  assert(opp.source === "bot_followup", `bot-only tail should classify as bot_followup, got ${opp.source}`);
});

await runTest("weak bids resolve to collective silence", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["react", "analyze"] },
    bots: [
      { botId: "botA", confidence: 0.1 },
      { botId: "botB", confidence: 0.1 },
    ],
  });
  assert(result.winner === null, `weak bids should stay silent, got ${result.winner}`);
  assert(result.outcome === "collective_silence", `expected collective_silence, got ${result.outcome}`);
});

// ─── Dogpile / greetings ──────────────────────────────────────────────────────

await runTest("one human greeting: first bot welcomes, others suppressed", () => {
  const first = sim({
    recentLedger: [
      { speakerType: "human", speakerId: "newviewer", message: "first time here hi everyone", timestamp: NOW - 5000 },
    ],
    bots: [{ botId: "botA", confidence: 0.7, persona: SUPPORT, candidate: { socialOpening: true, firstMessagePending: true } }],
  });
  assert(first.winner === "botA", "the first greeting should go through");

  const pile = sim({
    recentLedger: [
      { speakerType: "human", speakerId: "newviewer", message: "first time here hi everyone", timestamp: NOW - 5000 },
      { speakerType: "bot", speakerId: "botA", message: "welcome in newviewer!", isGreeting: true, timestamp: NOW - 3000 },
    ],
    bots: [{ botId: "botB", confidence: 0.7, persona: SUPPORT, candidate: { socialOpening: true, firstMessagePending: true } }],
  });
  const b = bidOf(pile, "botB")!;
  assert(b.dogpilePenalty >= 1 || b.redundancyPenalty >= 0.5, `greeting pile-on should be penalized (dog=${b.dogpilePenalty} red=${b.redundancyPenalty})`);
  assert(pile.winner === null, `second welcome should be suppressed, got ${pile.winner}`);
});

await runTest("greeting spacing: next greeting allowed after the window + human chat", () => {
  const result = sim({
    recentLedger: [
      { speakerType: "bot", speakerId: "botA", message: "welcome in newviewer!", isGreeting: true, timestamp: NOW - 50000 },
      { speakerType: "human", speakerId: "chatter", message: "yeah this channel is great", timestamp: NOW - 10000 },
    ],
    bots: [{ botId: "botB", confidence: 0.7, persona: SUPPORT, candidate: { firstMessagePending: true } }],
  });
  const b = bidOf(result, "botB")!;
  assert(b.redundancyPenalty === 0, `expired greeting window should carry no redundancy, got ${b.redundancyPenalty}`);
  assert(result.winner === "botB", `next cohort greeting should be allowed, got ${result.winner}`);
});

// ─── Supercharge ──────────────────────────────────────────────────────────────

await runTest("supercharge off: bot-to-bot chains are suppressed quickly", () => {
  const ledger: CoordinationSimulationInput["recentLedger"] = [];
  for (let i = 0; i < 4; i++) {
    ledger.push({ speakerType: "bot", speakerId: i % 2 ? "botA" : "botB", message: `bot to bot banter ${i}`, timestamp: NOW - 4000 + i * 800 });
  }
  const result = sim({
    recentLedger: ledger,
    bots: [{ botId: "botA", confidence: 0.9, persona: GREMLIN }],
  });
  assert(result.outcome === "all_suppressed", `normal mode should cap chains at ${SEMANTIC_COORDINATION_LIMITS.maxBotOnlyStreak}, got ${result.outcome}`);
});

await runTest("supercharge on: bounded bot-to-bot exchange, still capped", () => {
  const shortChain: CoordinationSimulationInput["recentLedger"] = [];
  for (let i = 0; i < 4; i++) {
    shortChain.push({ speakerType: "bot", speakerId: i % 2 ? "botA" : "botB", message: `bot to bot banter ${i}`, timestamp: NOW - 4000 + i * 800 });
  }
  const allowed = sim({
    room: { supercharge: true },
    recentLedger: shortChain,
    bots: [{ botId: "botA", confidence: 0.9, persona: GREMLIN }],
  });
  assert(allowed.winner === "botA", `supercharge should allow a short exchange, got ${JSON.stringify(allowed)}`);

  const longChain: CoordinationSimulationInput["recentLedger"] = [];
  for (let i = 0; i < 8; i++) {
    longChain.push({ speakerType: "bot", speakerId: i % 2 ? "botA" : "botB", message: `bot to bot banter ${i}`, timestamp: NOW - 8000 + i * 800 });
  }
  const capped = sim({
    room: { supercharge: true },
    recentLedger: longChain,
    bots: [{ botId: "botA", confidence: 0.9, persona: GREMLIN }],
  });
  assert(capped.outcome === "all_suppressed", `supercharge chains must stay bounded (cap ${SEMANTIC_COORDINATION_LIMITS.maxSuperchargeBotOnlyStreak}), got ${capped.outcome}`);
});

// ─── Determinism & invariants ─────────────────────────────────────────────────

await runTest("semantic score ties break deterministically (enqueue order, then id)", () => {
  const result = sim({
    opportunity: { source: "topic", responseFunctions: ["react", "analyze"] },
    bots: [
      { botId: "zz_bot", confidence: 0.7, persona: ANALYST },
      { botId: "aa_bot", confidence: 0.7, persona: ANALYST },
    ],
  });
  assert(result.winner === "zz_bot", `identical bids — earliest enqueued wins, got ${result.winner}`);
});

await runTest("one opportunity resolves at most one floor owner", () => {
  const scenarios = [
    sim({ opportunity: { source: "topic", responseFunctions: ["react", "analyze"] }, bots: [
      { botId: "a", confidence: 0.7, persona: ANALYST },
      { botId: "b", confidence: 0.7, persona: GREMLIN },
      { botId: "c", confidence: 0.7, persona: SUPPORT },
    ] }),
    sim({ bots: [
      { botId: "a", confidence: 0.5, persona: ANALYST, candidate: { isMentioned: true } },
      { botId: "b", confidence: 0.9, persona: GREMLIN },
    ] }),
    sim({ bots: [{ botId: "a", confidence: 0.2, persona: GREMLIN }] }),
  ];
  for (const s of scenarios) {
    const speakers = s.bids.filter((b) => b.disposition === "speak").length;
    assert(speakers <= 1, `at most one speaker per window, got ${speakers} (${s.outcome})`);
    if (s.winner !== null) assert(speakers === 1, "a winner implies exactly one speak disposition");
  }
});

await runTest("all bid components stay normalized within [0,1]", () => {
  const results = [
    sim({ opportunity: { source: "topic", responseFunctions: ["answer", "analyze"] }, bots: [
      { botId: "a", confidence: 0.9, persona: ANALYST },
      { botId: "b", confidence: 0.9, persona: GREMLIN, candidate: { isMentioned: true } },
    ] }),
    sim({ bots: [{ botId: "a", confidence: 1, persona: SUPPORT, candidate: { firstMessagePending: true } }] }),
  ];
  for (const r of results) {
    for (const b of r.bids) {
      const components = [
        b.baseConfidence, b.semanticFit, b.directMentionScore, b.continuityScore,
        b.underParticipationBonus, b.redundancyPenalty, b.recentSpeakerPenalty,
        b.dogpilePenalty, b.saturationPenalty, b.interruptionPenalty, b.targetStealPenalty,
      ];
      for (const c of components) {
        assert(c >= 0 && c <= 1, `component out of [0,1]: ${c} for ${b.botId}`);
      }
      assert(b.finalScore >= -1.6 && b.finalScore <= 1.05, `finalScore out of bounds: ${b.finalScore}`);
    }
  }
});

// ─── Channel / async safety ───────────────────────────────────────────────────

await runTest("channel switch wipes the ledger (no cross-channel leakage)", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("channelA");
  engine.noteHumanChat({ channel: "channelA", username: "viewer", text: "hello from channel A", timestamp: NOW });
  assert(engine.getLedgerSnapshot().length === 1, "entry recorded on channel A");
  engine.reset("channelB");
  assert(engine.getLedgerSnapshot().length === 0, "ledger must be wiped on channel switch");
});

await runTest("notes for a foreign channel are ignored", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("channelA");
  engine.noteHumanChat({ channel: "channelB", username: "viewer", text: "hello from channel B", timestamp: NOW });
  assert(engine.getLedgerSnapshot().length === 0, "foreign-channel notes must be dropped");
});

await runTest("stale channel bids are discarded, never speak", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("channelA");
  const requests: SemanticBidRequest[] = [
    { botId: "botA", enqueuedAt: NOW, candidate: { decision: "full_forge", confidence: 0.95, personaFit: 0.9, isMentioned: true } },
  ];
  const result = engine.resolveWindow(requests, { now: NOW, channel: "channelB", supercharge: false });
  assert(result.outcome === "stale_channel", `expected stale_channel, got ${result.outcome}`);
  assert(result.winnerBotId === null, "stale bids must never win the floor");
});

await runTest("channel-scoped notes after engine bind are attributed correctly", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("chan");
  engine.noteHumanChat({ channel: "chan", username: "Viewer", text: "what build is that @botB?", timestamp: NOW - 1000 });
  const entry = engine.getLedgerSnapshot()[0];
  assert(entry.speakerType === "human", "human chat attributed as human");
  assert(entry.targetId === "botb", `@mention target parsed, got ${entry.targetId}`);
  assert(entry.responseFunction === "answer", "question should map to answer");
});

// ─── Engine bounds & diagnostics ─────────────────────────────────────────────

await runTest("ledger and receipts stay bounded", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("boundchan");
  for (let i = 0; i < SEMANTIC_COORDINATION_LIMITS.maxLedgerEntries + 10; i++) {
    engine.noteHumanChat({ channel: "boundchan", username: `v${i}`, text: `message number ${i}`, timestamp: NOW + i });
  }
  assert(engine.getLedgerSnapshot().length <= SEMANTIC_COORDINATION_LIMITS.maxLedgerEntries, "ledger must be capped");
  const req: SemanticBidRequest[] = [{ botId: "a", enqueuedAt: NOW, candidate: { decision: "full_forge", confidence: 0.7, personaFit: 0.5 } }];
  for (let i = 0; i < SEMANTIC_COORDINATION_LIMITS.maxReceipts + 10; i++) {
    engine.resolveWindow(req, { now: NOW + i * 10, channel: "boundchan" });
  }
  assert(engine.getReceipts().length <= SEMANTIC_COORDINATION_LIMITS.maxReceipts, "receipts must be capped");
});

await runTest("receipts and dispositions are inspectable", () => {
  const engine = new SemanticCoordinationEngine();
  engine.reset("diagchan");
  engine.noteHumanChat({ channel: "diagchan", username: "viewer", text: "which build is better for m+", timestamp: NOW - 1000 });
  const result = engine.resolveWindow(
    [
      { botId: "botA", enqueuedAt: NOW, candidate: { decision: "full_forge", confidence: 0.7, personaFit: 0.5 } },
      { botId: "botB", enqueuedAt: NOW + 1, candidate: { decision: "full_forge", confidence: 0.5, personaFit: 0.5, isMentioned: true } },
    ],
    { now: NOW, channel: "diagchan" },
  );
  const receipt = engine.getLastReceipt();
  assert(receipt !== null, "a receipt should be recorded");
  assert(receipt!.candidates.length === 2, "receipt should list all candidates");
  assert(typeof receipt!.reason === "string" && receipt!.reason.length > 0, "receipt should carry a reason");
  const loser = engine.getBotDisposition(result.winnerBotId === "botA" ? "botB" : "botA", NOW);
  assert(loser !== null && (loser.disposition === "defer" || loser.disposition === "silence"), "loser disposition should be inspectable");
  assert(typeof loser!.reason === "string" && loser!.reason.length > 0, "disposition should carry a reason");
});

await runTest("simulation harness round-trip", () => {
  const result = sim({
    room: { supercharge: false },
    opportunity: { source: "topic", responseFunctions: ["answer", "analyze"] },
    bots: [{ botId: "solo", confidence: 0.8, persona: ANALYST }],
  });
  assert(result.winner === "solo", `solo strong bid should win, got ${JSON.stringify(result)}`);
  assert(result.bids.length === 1, "one bid expected");
  assert(["speaker_selected", "collective_silence"].includes(result.outcome), `valid outcome expected, got ${result.outcome}`);
});

// ─── Weights sanity ───────────────────────────────────────────────────────────

await runTest("coordination weights are bounded and inspectable", () => {
  const W = SEMANTIC_COORDINATION_WEIGHTS;
  const positive = W.confidence + W.semanticFit + W.directMention + W.continuity + W.underParticipation;
  assert(positive <= 1.1, `positive weights should stay ~1, got ${positive}`);
  for (const key of ["redundancy", "recentSpeaker", "dogpile", "saturation", "interruption", "targetSteal"] as const) {
    assert(W[key] > 0 && W[key] <= 1, `penalty weight ${key} must be bounded`);
  }
  assert(W.targetSteal > W.recentSpeaker, "target steal must outweigh balance pressure");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Semantic Coordination tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
