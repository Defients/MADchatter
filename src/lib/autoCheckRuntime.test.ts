import assert from "node:assert/strict";

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
};
const { useAppStore } = await import("../store");

const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
try {
  useAppStore.setState({
    autoForgeAutoCheckMode: "smart",
    autoForgeAutoCheckIntervalMs: 60_000,
    autoForgeNextActionMs: now + 9_999,
    autoForgeLastCheckMs: 0,
    bots: [],
  });

  useAppStore.getState().setAutoForgeAutoCheckCadence("interval", 30_000);
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 30_000, "30S selection establishes an exact deadline");
  useAppStore.getState().setAutoForgeNextActionMs(now + 1_000);
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 30_000, "model pacing cannot shift Interval earlier");
  useAppStore.getState().setAutoForgeNextActionMs(now + 999_000);
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 30_000, "model pacing cannot overrun Interval later");

  now += 30_000;
  useAppStore.getState().recordAutoForgeCheckAttempt(now);
  assert.equal(useAppStore.getState().autoForgeLastCheckMs, now, "deadline records an AutoCheck attempt before local gates");
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 30_000, "completed attempt re-anchors absolutely from attempt time");
  useAppStore.getState().recordAutoForgeCheckAttempt(now);
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 30_000, "one attempt cannot create a catch-up burst");

  useAppStore.getState().setAutoForgeAutoCheckCadence("interval", 5 * 60_000);
  assert.equal(useAppStore.getState().autoForgeAutoCheckIntervalMs, 5 * 60_000, "legacy 5M persists as the custom interval value");
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 5 * 60_000, "CUSTOM 5 re-anchors from commit time");
  useAppStore.getState().setAutoForgeAutoCheckCadence("interval", 15 * 60_000);
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 15 * 60_000, "CUSTOM 15 re-anchors from commit time");
  useAppStore.getState().setAutoForgeAutoCheckCadence("interval", 99 * 60_000);
  assert.equal(useAppStore.getState().autoForgeAutoCheckIntervalMs, 99 * 60_000, "CUSTOM 99 survives store normalization");
  assert.equal(useAppStore.getState().autoForgeNextActionMs, now + 99 * 60_000, "CUSTOM 99 owns the displayed and executed deadline");

  useAppStore.getState().clearAllContext();
  assert.equal(useAppStore.getState().autoForgeNextActionMs, 0, "session invalidation clears an overdue deadline");

  // ── Multi-bot Interval independence (P0 admission contract) ───────────────
  // In manual Interval mode each active bot owns its own absolute deadline.
  // recordBotAutoForgeCheckAttempt(bot A) updates the SHARED autoForgeLastCheckMs
  // telemetry, but must never move, block or invalidate bot B's independent
  // deadline — and the admitted attempt must not run back through the legacy
  // cadence floor, which would see A's fresh lastCheckAt and suppress B.
  const mkBot = (id: string, deadline: number): any => ({
    id,
    active: true,
    session: { username: `bot${id}`, userId: `u-${id}` },
    platform: "twitch",
    runtime: {
      autoForgeNextActionMs: deadline,
      autoForgeLastActionMs: null,
      enhancedStats: {},
      autoForgeDecisionHistory: [],
      sentimentHistory: [],
    },
  });
  const collisionStart = now + 60_000;
  useAppStore.setState({
    autoForgeAutoCheckMode: "interval",
    autoForgeAutoCheckIntervalMs: 120_000,
    multiBotEnabled: true,
    bots: [mkBot("a", collisionStart), mkBot("b", collisionStart)],
  });

  // Exact simultaneous deadline: A admits first; B's deadline is untouched.
  useAppStore.getState().recordBotAutoForgeCheckAttempt("a", collisionStart);
  assert.equal(
    (useAppStore.getState().bots.find((b) => b.id === "a")!.runtime).autoForgeNextActionMs,
    collisionStart + 120_000,
    "bot A's completed attempt re-anchors only bot A",
  );
  assert.equal(
    (useAppStore.getState().bots.find((b) => b.id === "b")!.runtime).autoForgeNextActionMs,
    collisionStart,
    "bot A's attempt cannot suppress bot B's identical deadline",
  );

  // Near-simultaneous deadline (A runs, B runs 10–100ms later): B still runs.
  now += 50;
  useAppStore.getState().recordBotAutoForgeCheckAttempt("b", now);
  const bAfter = (useAppStore.getState().bots.find((b) => b.id === "b")!.runtime).autoForgeNextActionMs;
  assert.equal(bAfter, now + 120_000, "bot B's near-simultaneous attempt is admitted and re-anchored from its own attempt time");

  // Different intervals/deadlines: A due now, B due in 30s — B is not moved.
  useAppStore.setState({
    bots: [mkBot("a", now), mkBot("b", now + 30_000)],
  });
  useAppStore.getState().recordBotAutoForgeCheckAttempt("a", now);
  assert.equal(
    (useAppStore.getState().bots.find((b) => b.id === "b")!.runtime).autoForgeNextActionMs,
    now + 30_000,
    "bot A's earlier attempt leaves bot B's later deadline exactly in place",
  );

  // Post-admission gate shaping: an admitted attempt that a deeper local gate
  // (provider/rate/vibe) then shapes must not mutate bot B's current deadline.
  // The loops' post-admission writes go through setBotAutoForgeNextActionMs,
  // which refuses to move a live Interval deadline.
  useAppStore.getState().setBotAutoForgeNextActionMs("b", now + 20_000);
  assert.equal(
    (useAppStore.getState().bots.find((b) => b.id === "b")!.runtime).autoForgeNextActionMs,
    now + 30_000,
    "post-admission model pacing cannot mutate bot B's Interval deadline",
  );

  // Urgent contract: a Force / direct-mention early check runs without
  // recording an attempt — setBotAutoForgeNextActionMs (the only writer the
  // urgent path touches) must leave the ordinary deadline untouched.
  useAppStore.getState().setBotAutoForgeNextActionMs("a", now + 1);
  assert.equal(
    (useAppStore.getState().bots.find((b) => b.id === "a")!.runtime).autoForgeNextActionMs,
    now + 120_000,
    "urgent/force checks do not re-anchor the ordinary Interval deadline",
  );

  // Smart mode pacing must still work (no accidental gate bypass).
  useAppStore.setState({
    autoForgeAutoCheckMode: "smart",
    multiBotEnabled: true,
    bots: [mkBot("a", 0)],
  });
  useAppStore.getState().setBotAutoForgeNextActionMs("a", now + 45_000);
  assert.equal(
    (useAppStore.getState().bots.find((b) => b.id === "a")!.runtime).autoForgeNextActionMs,
    now + 45_000,
    "Smart mode model pacing still writes the pacing gate",
  );

  useAppStore.setState({ multiBotEnabled: false, bots: [] });
  console.log("24/24 AutoCheck runtime deadline scenarios passed");
} finally {
  Date.now = realNow;
}
