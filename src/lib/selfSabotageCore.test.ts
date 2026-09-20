import assert from "node:assert/strict";
import {
  SELF_SABOTAGE_PAYLOAD,
  SelfSabotageController,
  assignSelfSabotageRoles,
  calculateBotSuspicionScore,
  canTransitionSelfSabotage,
  chooseSelfSabotageInstigator,
  type SelfSabotageAnalyticsRecord,
  type SelfSabotageParticipant,
  type SelfSabotageRuntime,
  type SelfSabotageStartOptions,
} from "./selfSabotageCore";

function participants(count: number): SelfSabotageParticipant[] {
  return assignSelfSabotageRoles(Array.from({ length: count }, (_, index) => ({
    id: `bot${index + 1}`,
    botId: `bot${index + 1}`,
    username: `bot${index + 1}`,
    label: `Bot ${index + 1}`,
    role: "DEADPAN" as const,
    suspicionScore: 60 - index,
    confessed: false,
  })), "bot1");
}

function harness(count: number, dialogue: Record<string, Record<string, string>> = {}) {
  let current = participants(count);
  const sends: Array<{ id: string; message: string }> = [];
  const analytics: SelfSabotageAnalyticsRecord[] = [];
  const memories: unknown[] = [];
  let invalidator: ((reason: string) => void) | null = null;
  let floor = false;
  let now = 1_000;
  const runtime: SelfSabotageRuntime = {
    now: () => ++now,
    random: () => 0.99,
    prepareStart(options: SelfSabotageStartOptions) {
      return { participants: current, instigatorId: options.preferredInstigatorId ?? current[0].id, mobile: false };
    },
    refreshParticipants(ids) {
      return ids.flatMap((id) => current.find((participant) => participant.id === id) ?? []);
    },
    async prepareDialogue() { return dialogue; },
    async send(participant, message) {
      sends.push({ id: participant.id, message });
      return true;
    },
    acquireFloor() { if (floor) return false; floor = true; return true; },
    releaseFloor() { floor = false; },
    observeInvalidation(callback) { invalidator = callback; return () => { invalidator = null; }; },
    recordAftershock(record) { memories.push(record); },
    recordAnalytics(record) { analytics.push(record); },
  };
  const controller = new SelfSabotageController(runtime, 0);
  return {
    controller, sends, analytics, memories,
    remove(id: string) { current = current.filter((participant) => participant.id !== id); },
    invalidate(reason: string) { invalidator?.(reason); },
    floorOwned: () => floor,
  };
}

async function waitForState(controller: SelfSabotageController, state: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (controller.getSnapshot().state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${state}; got ${controller.getSnapshot().state}`);
}

assert.equal(canTransitionSelfSabotage("DORMANT", "ELIGIBLE"), true);
assert.equal(canTransitionSelfSabotage("ANNOUNCEMENT", "OVERDRIVE"), false, "invalid phase skips are rejected");

const accused = calculateBotSuspicionScore({
  id: "a", username: "gremlin", label: "Gremlin",
  recentChat: [{ user: "viewer", text: "gremlin are you a bot? you type like AI" }],
  recentSentMessages: [],
});
const quiet = calculateBotSuspicionScore({
  id: "b", username: "quiet", label: "Quiet",
  recentChat: [], recentSentMessages: [],
});
assert.ok(accused > quiet + 30, "direct AI accusation should dominate suspicion");
const tie = participants(2).map((participant) => ({ ...participant, suspicionScore: 50 }));
assert.equal(chooseSelfSabotageInstigator(tie, () => 0.99)?.id, "bot2", "ties should use the injected random selector");

const unsafeGenerated = harness(1, {
  bot1: { announcement: "I am definitely a bot", confession: "I enjoy toast" },
});
await unsafeGenerated.controller.start({ source: "developer", force: true });
await unsafeGenerated.controller.whenSettled();
assert.doesNotMatch(unsafeGenerated.sends[0].message, /\bbot\b/i, "generated dialogue cannot reveal before the confession phase");
assert.ok(unsafeGenerated.sends.some((send) => /\bbot\b/i.test(send.message)), "a non-confession generated line should fall back to a real confession");

for (const count of [1, 2, 3, 5]) {
  const test = harness(count);
  const started = await test.controller.start({ source: "developer", force: true });
  assert.equal(started.started, true, `${count}-bot event should start`);
  await test.controller.whenSettled();
  assert.equal(test.controller.getSnapshot().state, "DORMANT", `${count}-bot lifecycle should return dormant`);
  assert.equal(test.analytics.length, 1, `${count}-bot lifecycle should record one analytics receipt`);
  assert.equal(test.analytics[0].aborted, false);
  assert.equal(test.memories.length, 1, `${count}-bot lifecycle should record aftershock memory`);
  assert.ok(test.sends.length <= 38, `${count}-bot event must honor total budget`);
  const perBot = new Map<string, number>();
  test.sends.forEach((send) => perBot.set(send.id, (perBot.get(send.id) ?? 0) + 1));
  assert.ok([...perBot.values()].every((value) => value <= 10), `${count}-bot event must honor per-bot budget`);
}

const payload = harness(3);
await payload.controller.start({ source: "desktop_easter_egg", force: true });
await waitForState(payload.controller, "PAYLOAD_READY");
assert.equal(payload.controller.requestPayloadFire(), true, "first payload click should arm firing");
assert.equal(payload.controller.requestPayloadFire(), false, "double click must not duplicate payload");
await payload.controller.whenSettled();
const payloadSends = payload.sends.filter((send) => send.message === SELF_SABOTAGE_PAYLOAD);
assert.equal(payloadSends.length, 3, "payload should send once per participant");
assert.equal(new Set(payloadSends.map((send) => send.id)).size, 3);
assert.equal(payload.analytics[0].payloadFired, true);

const reentry = harness(2);
await reentry.controller.start({ source: "manual", force: true });
const second = await reentry.controller.start({ source: "desktop_easter_egg", force: true });
assert.deepEqual(second, { started: false, reason: "already_active" }, "forced trigger must not bypass active lock");
reentry.controller.abort("test_abort");
await reentry.controller.whenSettled();
assert.equal(reentry.floorOwned(), false, "abort must release floor");
assert.equal(reentry.analytics[0].aborted, true);

const invalidated = harness(2);
await invalidated.controller.start({ source: "developer", force: true });
invalidated.invalidate("app_backgrounded");
await invalidated.controller.whenSettled();
assert.equal(invalidated.analytics[0].abortReason, "app_backgrounded", "backgrounding should abort without queued sends dumping later");
assert.equal(invalidated.floorOwned(), false, "invalidation abort should release floor");

const removal = harness(3);
await removal.controller.start({ source: "developer", force: true });
removal.remove("bot3");
await removal.controller.whenSettled();
assert.equal(removal.analytics[0].participantCount, 2, "removed bot should leave participant set");

const cooldown = harness(1);
await cooldown.controller.start({ source: "manual", force: true });
await cooldown.controller.whenSettled();
const blocked = await cooldown.controller.start({ source: "manual", force: false });
assert.equal(blocked.started, false, "natural/manual non-force start should respect cooldown");
const forced = await cooldown.controller.start({ source: "developer", force: true });
assert.equal(forced.started, true, "forced start should bypass cooldown");
cooldown.controller.abort("done");
await cooldown.controller.whenSettled();

console.log("SELF-SAB-BOT-AGE controller tests passed");
