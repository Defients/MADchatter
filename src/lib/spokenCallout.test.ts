/**
 * Focused test harness for Spoken Callout Priority (v29).
 * Run: npx tsx src/lib/spokenCallout.test.ts
 */

import {
  detectSpokenCallout,
  simulateSpokenCallout,
  normalizeSpokenText,
  stripTranscriptDecorations,
  isDistinctiveName,
  buildSpokenIdentities,
  SpokenCalloutEngine,
  SPOKEN_CALLOUT_LIMITS,
} from "./spokenCallout";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const BOTS = [
  { id: "bot_gremlin", spokenNames: ["gremlin"], display: "Gremlin" },
  { id: "bot_analyst", spokenNames: ["analyst"], display: "Analyst" },
  { id: "bot_may", spokenNames: ["may"], display: "May" },
];

console.log("\n[1] Normalization & distinctiveness");
check("normalizes punctuation", normalizeSpokenText("Where's Gremlin's build?!") === "wheres gremlins build");
check("strips transcript decorators", stripTranscriptDecorations("[01:23] 'hello'") === "hello");
check("distinctive name recognition", isDistinctiveName("gremlin") === true);
check("common word non-distinctive", isDistinctiveName("may") === false);
check("short name non-distinctive", isDistinctiveName("ai") === false);

console.log("\n[2] Direct address vs third-person mention");
{
  const r = simulateSpokenCallout({ transcript: "Gremlin, what do you think?", bots: BOTS });
  check("direct question confirmed", r.classification === "confirmed");
  check("target is Gremlin", r.target?.type === "bot" && (r.target as any).botId === "bot_gremlin");
  check("kind is direct_question", r.kind === "direct_question");
  check("confidence meets threshold", r.confidence >= SPOKEN_CALLOUT_LIMITS.confirmThreshold);
}
{
  const r = simulateSpokenCallout({ transcript: "Analyst, explain that wipe.", bots: BOTS });
  check("command request confirmed", r.classification === "confirmed" && r.kind === "command_request");
}
{
  const r = simulateSpokenCallout({ transcript: "Hey Gremlin!", bots: BOTS });
  check("greeting confirmed", r.classification === "confirmed" && r.kind === "greeting");
}
{
  const r = simulateSpokenCallout({ transcript: "I think Gremlin said that earlier.", bots: BOTS });
  check("third-person speech rejected", r.classification !== "confirmed");
}
{
  const r = simulateSpokenCallout({ transcript: "Chat saw what Gremlin did.", bots: BOTS });
  check("third-person observation rejected", r.classification !== "confirmed");
}

console.log("\n[3] Common-word name strictness");
{
  const r = simulateSpokenCallout({ transcript: "May I see that real quick?", bots: BOTS });
  check("ordinary usage rejected", r.classification !== "confirmed");
}
{
  const r = simulateSpokenCallout({ transcript: "May, what do you think?", bots: BOTS });
  check("vocative address to common-word passes", r.classification === "confirmed");
}

console.log("\n[4] Negative instructions (quiet / shut up)");
{
  const r = simulateSpokenCallout({ transcript: "Gremlin, don't answer that.", bots: BOTS });
  check("don't answer detected", r.classification === "confirmed" && r.kind === "negative_instruction");
}
{
  const r = simulateSpokenCallout({ transcript: "Gremlin be quiet.", bots: BOTS });
  check("be quiet detected", r.classification === "confirmed" && r.kind === "negative_instruction");
}

console.log("\n[5] Echo suppression");
{
  const now = 1_000_000;
  const r = simulateSpokenCallout({
    transcript: "Gremlin says the boss enrages at thirty percent",
    bots: BOTS,
    now,
    recentAgentSpeech: [{ text: "The boss enrages at thirty percent", at: now - 3_000 }],
  });
  check("paraphrase of recent speech = echo", r.classification === "agent_echo");
}
{
  const now = 1_000_000;
  const r = simulateSpokenCallout({
    transcript: "Gremlin, what do you think?",
    bots: BOTS,
    now,
    recentAgentSpeech: [{ text: "The boss enrages at thirty percent", at: now - 30_000 }],
  });
  check("aged speech does not echo", r.classification === "confirmed");
}

console.log("\n[6] Ensemble address");
{
  const r = simulateSpokenCallout({ transcript: "MADchatter, what is happening?", bots: BOTS });
  check("system name addresses ensemble", r.classification === "confirmed" && r.target?.type === "ensemble");
}
{
  const r = simulateSpokenCallout({ transcript: "Bots, what do you think?", bots: BOTS });
  check("vocative bots addresses ensemble", r.classification === "confirmed" && r.target?.type === "ensemble");
}
{
  const r = simulateSpokenCallout({ transcript: "I have so many bots in here.", bots: BOTS });
  check("non-vocative bots rejected", r.classification !== "confirmed");
}

console.log("\n[7] Multi-bot & ambiguity");
{
  const r = simulateSpokenCallout({ transcript: "Gremlin and Analyst, what do you think?", bots: BOTS });
  check("conjoined multi-bot address detected", r.classification === "confirmed" && r.target?.type === "multi_bot");
}
{
  const colliding = [{ id: "b1", spokenNames: ["helper"] }, { id: "b2", spokenNames: ["helper"] }];
  const r = simulateSpokenCallout({ transcript: "Helper, what should I do?", bots: colliding });
  check("colliding aliases yield ambiguous", r.target?.type === "ambiguous");
}

console.log("\n[8] SpokenCalloutEngine lifecycle");
{
  const engine = new SpokenCalloutEngine();
  engine.reset("testchannel");
  const identities = buildSpokenIdentities([
    { id: "bot_1", session: { username: "gremlin" }, label: "Gremlin", active: true },
  ]);
  const now = 100_000;

  const routing1 = engine.noteTranscriptLine({
    text: "Gremlin, roast that build.",
    isFinal: true,
    channel: "testchannel",
    identities,
    now,
  });
  check("first confirmed utterance routes", routing1 !== null && routing1.isNew === true);
  check("active callout is present", engine.getActiveCallout(now) !== null);

  engine.markClaimed(routing1!.callout.id, now + 500);
  check("marked claimed", engine.getActiveCallout(now + 500)?.state === "claimed");

  const routing2 = engine.noteTranscriptLine({
    text: "Gremlin, answer me!",
    isFinal: true,
    channel: "testchannel",
    identities,
    now: now + 3_000,
  });
  check("repeat merges (isNew === false)", routing2 !== null && routing2.isNew === false);
  check("repeat count incremented", engine.getActiveCallout(now + 3_000)?.repeatCount === 2);

  const consumed = engine.consumeForBot("bot_1", now + 4_000);
  check("consumed for responding bot", consumed !== null && consumed.state === "consumed");
  check("latency recorded", typeof consumed?.responseLatencyMs === "number" && consumed.responseLatencyMs > 0);

  const secondConsume = engine.consumeForBot("bot_1", now + 5_000);
  check("consumed cannot be consumed again", secondConsume === null);

  engine.noteTranscriptLine({
    text: "Gremlin, hello?",
    isFinal: true,
    channel: "testchannel",
    identities,
    now: now + 10_000,
  });
  check("callout active before switch", engine.getActiveCallout(now + 10_000) !== null);
  engine.reset("otherchannel");
  check("channel switch wipes active callout", engine.getActiveCallout(now + 10_000) === null);
}

console.log("\n[9] TTL Expiry");
{
  const engine = new SpokenCalloutEngine();
  engine.reset("expchannel");
  const identities = buildSpokenIdentities([
    { id: "bot_1", session: { username: "gremlin" }, label: "Gremlin", active: true },
  ]);
  const now = 200_000;
  engine.noteTranscriptLine({
    text: "Gremlin, what is that?",
    isFinal: true,
    channel: "expchannel",
    identities,
    now,
  });
  const ttl = SPOKEN_CALLOUT_LIMITS.ttlMs.direct_question;
  check("active within TTL", engine.getActiveCallout(now + ttl - 100) !== null);
  check("expired past TTL", engine.getActiveCallout(now + ttl + 100) === null);
}

console.log(`\n============================================================`);
console.log(`Spoken Callout tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
