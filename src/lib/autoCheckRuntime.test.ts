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
  console.log("12/12 AutoCheck runtime deadline scenarios passed");
} finally {
  Date.now = realNow;
}
