/**
 * AutoForge Auto-Check cadence tests.
 *
 * Run with: npx tsx src/lib/coreAutoCheck.test.ts
 *
 * Covers: mode/interval normalization, clamp + label formatting, context
 * fingerprint change detection, cadence decisions for Smart vs Interval
 * (including mentions/urgent bypass), and the countdown/status helpers the
 * CORE indicator renders.
 */

const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};

const {
  AUTO_CHECK_INTERVAL_OPTIONS,
  AUTO_CHECK_SMART_FLOOR_MS,
  AUTO_CHECK_MIN_INTERVAL_MS,
  AUTO_CHECK_MAX_INTERVAL_MS,
  DEFAULT_AUTO_CHECK_INTERVAL_MS,
  DEFAULT_AUTO_CHECK_MODE,
  captureAutoCheckSignal,
  clampAutoCheckIntervalMs,
  computeAutoCheckWindow,
  describeAutoCheckStatus,
  evaluateAutoCheckCadence,
  formatAutoCheckInterval,
  hasMeaningfulContextChange,
  normalizeAutoCheckMode,
  reconcileAutoCheckSchedule,
  resolveAutoCheckFloorMs,
  resolveEffectiveCheckFloorMs,
} = await import("./coreAutoCheck");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.error(`FAIL: ${msg}`); }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual === expected) passed++;
  else {
    failed++;
    failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

console.log("Running Core Auto-Check tests...\n");

// ─── Test 1: normalization + clamping ───────────────────────────────────────
function testNormalization() {
  assertEq(normalizeAutoCheckMode("smart"), "smart", "smart stays smart");
  assertEq(normalizeAutoCheckMode("interval"), "interval", "interval stays interval");
  assertEq(normalizeAutoCheckMode(undefined), "smart", "unknown modes fall back to smart");
  assertEq(normalizeAutoCheckMode("nonsense"), "smart", "bogus strings fall back to smart");
  assertEq(DEFAULT_AUTO_CHECK_MODE, "smart", "default mode is smart (no forced 15s cadence)");
  assertEq(DEFAULT_AUTO_CHECK_INTERVAL_MS, 60_000, "default interval is 1 minute");

  assertEq(clampAutoCheckIntervalMs(1000), AUTO_CHECK_MIN_INTERVAL_MS, "too-fast intervals clamp up to the floor");
  assertEq(clampAutoCheckIntervalMs(999_999_999), AUTO_CHECK_MAX_INTERVAL_MS, "absurd intervals clamp down");
  assertEq(clampAutoCheckIntervalMs(NaN), DEFAULT_AUTO_CHECK_INTERVAL_MS, "NaN falls back to the default");
  assertEq(clampAutoCheckIntervalMs(120_000), 120_000, "valid intervals pass through");

  assertEq(formatAutoCheckInterval(30_000), "30s", "30s label");
  assertEq(formatAutoCheckInterval(60_000), "1m", "1m label");
  assertEq(formatAutoCheckInterval(300_000), "5m", "5m label");
  assert(AUTO_CHECK_INTERVAL_OPTIONS.length >= 4, "at least four interval options are offered");
  assert(AUTO_CHECK_INTERVAL_OPTIONS.every((v) => v >= AUTO_CHECK_MIN_INTERVAL_MS), "no offered option polls faster than the floor");
}

// ─── Test 2: context fingerprint ────────────────────────────────────────────
function testSignal() {
  const base = {
    chatLog: [{ id: "m1", user: "a", text: "hi", timestamp: 1 }],
    audioTranscript: "the streamer is talking",
    visualSnapshotUrl: "blob:1",
    visualSnapshotHistoryLength: 1,
    sentMessagesLength: 2,
    audioEnergyLabel: "hype",
  };
  const first = captureAutoCheckSignal(base, 1000);
  const same = captureAutoCheckSignal(base, 2000);
  assert(!hasMeaningfulContextChange(first, same), "identical context is not a meaningful change");
  assert(hasMeaningfulContextChange(null, first), "first observation counts as a change");

  const newChat = captureAutoCheckSignal({ ...base, chatLog: [...base.chatLog, { id: "m2", user: "b", text: "yo" }] }, 3000);
  assert(hasMeaningfulContextChange(first, newChat), "new chat message is a meaningful change");

  const newTranscript = captureAutoCheckSignal({ ...base, audioTranscript: "the streamer is talking about a new game" }, 3000);
  assert(hasMeaningfulContextChange(first, newTranscript), "transcript growth is a meaningful change");

  const newVisual = captureAutoCheckSignal({ ...base, visualSnapshotHistoryLength: 2 }, 3000);
  assert(hasMeaningfulContextChange(first, newVisual), "new visual snapshot is a meaningful change");

  const botSpoke = captureAutoCheckSignal({ ...base, sentMessagesLength: 3 }, 3000);
  assert(hasMeaningfulContextChange(first, botSpoke), "bot activity is a meaningful change");

  const energy = captureAutoCheckSignal({ ...base, audioEnergyLabel: "chill" }, 3000);
  assert(hasMeaningfulContextChange(first, energy), "audio energy shift is a meaningful change");
}

// ─── Test 3: interval-mode cadence ──────────────────────────────────────────
function testIntervalCadence() {
  const now = 1_000_000;
  const gate = (over: Partial<Parameters<typeof evaluateAutoCheckCadence>[0]>) =>
    evaluateAutoCheckCadence({
      mode: "interval",
      intervalMs: 120_000,
      now,
      lastCheckAt: now - 60_000,
      signalsChanged: false,
      ...over,
    });

  assertEq(gate({}).run, false, "interval mode withholds a check before the chosen cadence");
  assertEq(gate({ lastCheckAt: now - 120_000 }).run, true, "interval mode checks once the cadence elapses");
  assertEq(gate({ lastCheckAt: now - 119_999 }).run, false, "interval mode is strict about the boundary");
  assertEq(gate({ lastCheckAt: 0 }).run, true, "never-checked sessions are not blocked forever");
  assertEq(gate({ urgent: true, lastCheckAt: now - 1 }).run, true, "mentions bypass the interval cadence");
  assertEq(resolveAutoCheckFloorMs("interval", 300_000), 300_000, "interval floor equals the configured cadence");
}

// ─── Test 4: smart-mode cadence ─────────────────────────────────────────────
function testSmartCadence() {
  const now = 2_000_000;
  const gate = (over: Partial<Parameters<typeof evaluateAutoCheckCadence>[0]>) =>
    evaluateAutoCheckCadence({
      mode: "smart",
      intervalMs: 300_000,
      now,
      lastCheckAt: now - 60_000,
      signalsChanged: true,
      ...over,
    });

  assertEq(gate({}).run, true, "smart mode runs when context changed");
  assertEq(gate({ signalsChanged: false }).run, false, "smart mode does not spend a model call with unchanged context");
  assertEq(gate({ signalsChanged: false }).armed, false, "nothing is queued when nothing changed");
  assertEq(
    gate({ lastCheckAt: now - 5_000, signalsChanged: true }).armed,
    true,
    "cadence-gated new context reports as queued/armed",
  );
  assertEq(
    gate({ lastCheckAt: now - AUTO_CHECK_SMART_FLOOR_MS - 1, signalsChanged: true }).run,
    true,
    "smart floor only delays, never blocks, a real change",
  );
  assertEq(resolveAutoCheckFloorMs("smart", 300_000), AUTO_CHECK_SMART_FLOOR_MS, "smart floor ignores the manual interval");
}

// ─── Test 5: countdown + status copy ────────────────────────────────────────
function testStatusHelpers() {
  const now = 5_000_000;
  const win = computeAutoCheckWindow({ mode: "interval", intervalMs: 60_000, lastCheckAt: now - 30_000, now });
  assertEq(win.dueInMs, 30_000, "dueInMs counts down to the cadence");
  assertEq(win.elapsedMs, 30_000, "elapsedMs tracks time since the last check");
  assertEq(win.progress, 0.5, "progress is 0→1 toward the next check");

  const never = computeAutoCheckWindow({ mode: "interval", intervalMs: 60_000, lastCheckAt: 0, now });
  assertEq(never.elapsedMs, 0, "never-checked sessions report zero elapsed");
  assertEq(never.dueInMs, 60_000, "never-checked sessions are due after one full cadence");

  assertEq(
    describeAutoCheckStatus({ mode: "interval", checking: false, armed: false, dueInMs: 42_000 }),
    "Next check in 42s",
    "interval mode reports a real countdown",
  );
  assertEq(
    describeAutoCheckStatus({ mode: "smart", checking: false, armed: false, dueInMs: 5_000 }),
    "Waiting for new context",
    "smart mode never fakes a countdown",
  );
  assertEq(
    describeAutoCheckStatus({ mode: "smart", checking: false, armed: true, dueInMs: 0 }),
    "New context — check queued",
    "smart mode reports queued context honestly",
  );
  assertEq(
    describeAutoCheckStatus({ mode: "smart", checking: true, armed: false, dueInMs: 0 }),
    "Checking now…",
    "in-flight state wins over mode copy",
  );
  assertEq(
    describeAutoCheckStatus({ mode: "interval", checking: false, armed: false, dueInMs: 10_000, paused: true }),
    "Auto-Check paused",
    "paused state is explicit",
  );
}

testNormalization();
testSignal();
testIntervalCadence();
testSmartCadence();
testStatusHelpers();

// ─── Test 6: effective check floor (min cooldown widens the floor) ──────────
function testEffectiveFloor() {
  // Smart floor is 30s; a smaller cooldown does not shrink it.
  assertEq(
    resolveEffectiveCheckFloorMs("smart", 60_000, 5_000),
    AUTO_CHECK_SMART_FLOOR_MS,
    "effective floor never goes below the cadence floor (smart)",
  );
  // A larger cooldown widens the floor.
  assertEq(
    resolveEffectiveCheckFloorMs("smart", 60_000, 90_000),
    90_000,
    "effective floor widens to a larger min cooldown (smart)",
  );
  // Interval mode: the cadence floor is the interval; cooldown can widen it.
  assertEq(
    resolveEffectiveCheckFloorMs("interval", 30_000, 25_000),
    30_000,
    "effective floor uses the cadence interval when cooldown is smaller (interval)",
  );
  assertEq(
    resolveEffectiveCheckFloorMs("interval", 30_000, 120_000),
    120_000,
    "effective floor widens to a larger min cooldown (interval)",
  );
  // Invalid / missing cooldown falls back to the cadence floor.
  assertEq(
    resolveEffectiveCheckFloorMs("smart", 60_000, 0),
    AUTO_CHECK_SMART_FLOOR_MS,
    "zero cooldown falls back to the cadence floor",
  );
  assertEq(
    resolveEffectiveCheckFloorMs("smart", 60_000, NaN),
    AUTO_CHECK_SMART_FLOOR_MS,
    "NaN cooldown falls back to the cadence floor",
  );
}

// ─── Test 7: cadence decision honors min cooldown + nextEligibleMs ──────────
function testCadenceWithCooldown() {
  const now = 3_000_000;
  const lastCheck = now - 10_000; // 10s ago — below the 30s smart floor

  // Without minCooldownMs: smart floor (30s) applies, blocks, nextEligibleMs
  // is lastCheck + 30s.
  const blocked = evaluateAutoCheckCadence({
    mode: "smart", intervalMs: 60_000, now, lastCheckAt: lastCheck,
    signalsChanged: true,
  });
  assertEq(blocked.run, false, "smart mode blocks before the floor");
  assertEq(blocked.nextEligibleMs, lastCheck + AUTO_CHECK_SMART_FLOOR_MS, "nextEligibleMs = lastCheck + floor");

  // With a 90s min cooldown: the floor widens to 90s, so 10s elapsed still
  // blocks, and nextEligibleMs is lastCheck + 90s.
  const wideFloor = evaluateAutoCheckCadence({
    mode: "smart", intervalMs: 60_000, now, lastCheckAt: lastCheck,
    signalsChanged: true, minCooldownMs: 90_000,
  });
  assertEq(wideFloor.run, false, "min cooldown widens the floor — still blocked at 10s");
  assertEq(wideFloor.nextEligibleMs, lastCheck + 90_000, "nextEligibleMs reflects the widened floor");

  // Urgent bypasses even the widened floor.
  const urgent = evaluateAutoCheckCadence({
    mode: "smart", intervalMs: 60_000, now, lastCheckAt: lastCheck,
    signalsChanged: true, minCooldownMs: 90_000, urgent: true,
  });
  assertEq(urgent.run, true, "urgent bypasses the widened floor");
  assertEq(urgent.nextEligibleMs, 0, "urgent does not schedule a floor reschedule");

  // Context-based block (smart, no change) has nextEligibleMs = 0 (no time
  // reschedule — the check should run as soon as context changes).
  const noChange = evaluateAutoCheckCadence({
    mode: "smart", intervalMs: 60_000, now: now + 60_000, lastCheckAt: lastCheck,
    signalsChanged: false,
  });
  assertEq(noChange.run, false, "smart mode blocks with no context change");
  assertEq(noChange.nextEligibleMs, 0, "context-based block does not reschedule the pacing gate");

  // Run case: nextEligibleMs = 0 (no reschedule needed).
  const run = evaluateAutoCheckCadence({
    mode: "smart", intervalMs: 60_000, now: now + 60_000, lastCheckAt: lastCheck,
    signalsChanged: true,
  });
  assertEq(run.run, true, "smart mode runs after the floor with a change");
  assertEq(run.nextEligibleMs, 0, "run case does not populate nextEligibleMs");
}

// ─── Test 8: computeAutoCheckWindow honors min cooldown ─────────────────────
function testWindowWithCooldown() {
  const now = 4_000_000;
  const lastCheck = now - 10_000;

  // Without minCooldownMs: dueInMs counts down to the 30s smart floor.
  const base = computeAutoCheckWindow({ mode: "smart", intervalMs: 60_000, lastCheckAt: lastCheck, now });
  assertEq(base.dueInMs, 20_000, "base window counts down to the smart floor");

  // With a 90s min cooldown: dueInMs counts down to 90s (80s remaining).
  const wide = computeAutoCheckWindow({ mode: "smart", intervalMs: 60_000, lastCheckAt: lastCheck, now, minCooldownMs: 90_000 });
  assertEq(wide.dueInMs, 80_000, "widened floor pushes the due time out");

  // Model pacing later than the floor still wins.
  const modelLater = computeAutoCheckWindow({
    mode: "smart", intervalMs: 60_000, lastCheckAt: lastCheck, now,
    nextActionMs: now + 120_000, minCooldownMs: 90_000,
  });
  assertEq(modelLater.dueInMs, 120_000, "model pacing later than the floor wins");
}

testEffectiveFloor();
testCadenceWithCooldown();
testWindowWithCooldown();

// ─── Test 9: mode-switch schedule reconciliation ──────────────────────────
function testScheduleReconcile() {
  const now = 10_000_000;
  const rec = (over: Partial<Parameters<typeof reconcileAutoCheckSchedule>[0]>) =>
    reconcileAutoCheckSchedule({
      mode: "interval",
      intervalMs: 60_000,
      now,
      lastCheckAt: 0,
      scheduledMs: 0,
      ...over,
    });

  // Interval: an overlong countdown pulls forward to the new cadence.
  const long = rec({ intervalMs: 30_000, scheduledMs: now + 48_000 });
  assertEq(long.nextActionMs, now + 30_000, "48s remaining + 30s mode → 30s");
  assertEq(long.shortened, true, "a real pull-forward reports shortened");

  // Interval: an already-sooner attempt is never pushed back out.
  const sooner = rec({ intervalMs: 30_000, scheduledMs: now + 8_000 });
  assertEq(sooner.nextActionMs, now + 8_000, "8s remaining + 30s mode stays ~8s");
  assertEq(sooner.shortened, false, "preserving a sooner attempt is not a shortening");

  // Interval: a longer countdown trims to the new cadence.
  assertEq(rec({ scheduledMs: now + 90_000 }).nextActionMs, now + 60_000, "90s + 60s mode → 60s");

  // Smart: fresh assessment = floor residual (lastCheck + 30s floor).
  // 12s elapsed → residual 18s pulls a stale 40s countdown forward.
  const smartShort = rec({ mode: "smart", lastCheckAt: now - 12_000, scheduledMs: now + 40_000 });
  assertEq(smartShort.nextActionMs, now + 18_000, "smart residual 18s pulls a stale 40s forward");
  assertEq(smartShort.shortened, true, "smart pull-forward reports shortened");

  // Smart: a legitimately sooner attempt survives a longer smart result.
  const smartKeep = rec({ mode: "smart", lastCheckAt: now - 6_000, scheduledMs: now + 5_000 });
  assertEq(smartKeep.nextActionMs, now + 5_000, "5s stays under a 24s smart residual");
  assertEq(smartKeep.shortened, false, "keeping the sooner attempt is not a shortening");

  // Smart: floor already elapsed → the assessment says "due now", replacing
  // whatever stale countdown a previous mode left behind.
  assertEq(
    rec({ mode: "smart", lastCheckAt: now - 60_000, scheduledMs: now + 40_000 }).nextActionMs,
    now,
    "smart floor elapsed → check is due now",
  );

  // Smart → interval → smart round-trip: the smart re-entry computes from
  // lastCheck, never inherits the interval-mode timestamp.
  const roundTrip = rec({ mode: "smart", lastCheckAt: now - 25_000, scheduledMs: now + 55_000 });
  assertEq(roundTrip.nextActionMs, now + 5_000, "smart re-entry recomputes the residual (5s)");

  // An already-due schedule stays due — a mode switch must not push a
  // pending attempt back out to the full cadence.
  assertEq(rec({ scheduledMs: now - 1_000 }).nextActionMs, now - 1_000, "overdue schedule stays due");
  assertEq(rec({ scheduledMs: 0 }).nextActionMs, 0, "never-scheduled (0) stays due");

  // Missing schedule is replaced by the mode's target.
  assertEq(rec({ scheduledMs: NaN }).nextActionMs, now + 60_000, "NaN schedule is replaced");

  // Min cooldown widens the interval target exactly like the live loops.
  assertEq(
    rec({ intervalMs: 30_000, minCooldownMs: 45_000, scheduledMs: now + 200_000 }).nextActionMs,
    now + 45_000,
    "cooldown widens the interval target",
  );

  // Sub-second pull-forwards don't count as a user-visible shortening.
  const subSecond = rec({ scheduledMs: now + 60_500 });
  assertEq(subSecond.nextActionMs, now + 60_000, "60.5s + 60s mode → 60s");
  assertEq(subSecond.shortened, false, "sub-second pull-forward doesn't flash");

  // dueAtMs: the countdown's scheduled-attempt identity.
  const win = computeAutoCheckWindow({ mode: "interval", intervalMs: 60_000, lastCheckAt: now - 30_000, now });
  assertEq(win.dueAtMs, now + 30_000, "dueAtMs = cadence due timestamp");
  const paced = computeAutoCheckWindow({
    mode: "interval", intervalMs: 60_000, lastCheckAt: now - 30_000, now, nextActionMs: now + 90_000,
  });
  assertEq(paced.dueAtMs, now + 90_000, "dueAtMs = model pacing when it is later");
}

testScheduleReconcile();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failures:\n" + failures.join("\n"));
  process.exit(1);
} else {
  console.log("All Core Auto-Check tests passed!");
}