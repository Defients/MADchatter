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
  resolveAutoCheckFloorMs,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failures:\n" + failures.join("\n"));
  process.exit(1);
} else {
  console.log("All Core Auto-Check tests passed!");
}