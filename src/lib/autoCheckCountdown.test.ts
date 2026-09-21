/**
 * AutoCheck countdown tick state machine tests.
 *
 * Run with: npx tsx src/lib/autoCheckCountdown.test.ts
 *
 * Covers the pure 3→2→1 tick reducer the mobile hook drives: exactly-once
 * per scheduled attempt, re-render dedupe, disable/pause/resume, schedule
 * supersede, direct jumps into the final seconds, and rapid mode-change
 * sequences — all without touching React or audio.
 */

const {
  evaluateSharedCountdownTick,
  initialCountdownTickState,
  resetSharedCountdownTick,
  stepCountdownTick,
} = await import("./autoCheckCountdown");

type State = ReturnType<typeof initialCountdownTickState>;
type Step = 1 | 2 | 3 | null;

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

console.log("Running Auto-Check countdown tick tests...\n");

/** Drive a fresh state through a sequence of observations; collect ticks. */
function runSequence(
  observations: Array<{ enabled: boolean; dueAtMs: number | null; nowMs: number }>,
): { ticks: Step[]; state: State } {
  let state = initialCountdownTickState();
  const ticks: Step[] = [];
  for (const obs of observations) {
    const { next, tick } = stepCountdownTick(state, obs);
    state = next;
    ticks.push(tick);
  }
  return { ticks, state };
}

/** Build an observation at `secsLeft` seconds before due. */
function at(dueAtMs: number, secsLeft: number, enabled = true) {
  return { enabled, dueAtMs, nowMs: dueAtMs - secsLeft * 1000 };
}

// ─── Normal countdown ──────────────────────────────────────────────────────
function testNormalCountdown() {
  const due = 1_000_000;
  const { ticks } = runSequence([
    at(due, 10), at(due, 5), at(due, 4), at(due, 3), at(due, 2), at(due, 1), at(due, 0),
  ]);
  assertEq(ticks.join(","), ",,,3,2,1,", "3/2/1 each tick once during a normal countdown");
}

// ─── Exactly-once across repeated observations of the same second ──────────
function testNoDuplicateWithinSecond() {
  const due = 2_000_000;
  // Three observations inside the "3s" window (re-renders / sub-second ticks).
  const { ticks } = runSequence([
    { enabled: true, dueAtMs: due, nowMs: due - 3_400 },
    { enabled: true, dueAtMs: due, nowMs: due - 3_200 },
    { enabled: true, dueAtMs: due, nowMs: due - 2_900 },
    at(due, 2),
  ]);
  assertEq(ticks.filter(Boolean).join(","), "3,2", "repeated same-second observations never re-tick");
}

// ─── Disabled mid-countdown ────────────────────────────────────────────────
function testDisableStopsTicks() {
  const due = 3_000_000;
  const { ticks } = runSequence([
    at(due, 4), at(due, 3), at(due, 2, false), at(due, 1, false),
  ]);
  assertEq(ticks.join(","), ",3,,", "disabled gate silences future ticks");
}

// ─── Pause → resume keeps the attempt ledger ──────────────────────────────
function testPauseResume() {
  const due = 4_000_000;
  // 3 ticks, pause at 2, resume still at 2 (display froze) → no replay of 2,
  // then 1 ticks as the countdown actually descends.
  const { ticks } = runSequence([
    at(due, 3), at(due, 2), at(due, 2, false), at(due, 2), at(due, 1),
  ]);
  assertEq(ticks.join(","), "3,2,,,1", "resume never replays ticks the attempt already spent");

  // Resume at a LATER second (the schedule effectively paused in wall time)
  // never fabricates the skipped second.
  const { ticks: later } = runSequence([
    at(due, 2), at(due, 2, false), at(due, 5, false), at(due, 5),
  ]);
  assertEq(later.join(","), "2,,,", "resume at a later second stays silent");
}

// ─── Superseded schedule: no orphan ticks, new attempt may re-tick ─────────
function testSupersede() {
  const due1 = 5_000_000;
  const due2 = 5_000_000 + 7_000; // a new, later schedule replaces it
  const { ticks } = runSequence([
    at(due1, 3),
    { enabled: true, dueAtMs: due2, nowMs: due1 - 2_000 }, // superseded at 2s (shows 9s)
    at(due2, 4), at(due2, 3), at(due2, 2), at(due2, 1),
  ]);
  assertEq(ticks.join(","), "3,,,3,2,1", "superseded attempt ticks once; the new attempt re-ticks normally");

  // Cancelled outright (no schedule) — silence.
  const { ticks: cancelled } = runSequence([
    at(due1, 3),
    { enabled: true, dueAtMs: null, nowMs: due1 - 2_000 },
    { enabled: true, dueAtMs: null, nowMs: due1 - 1_000 },
  ]);
  assertEq(cancelled.join(","), "3,,", "cancelled countdown stops ticking");
}

// ─── Mode-change jumps into the final seconds ──────────────────────────────
function testReconcileJump() {
  const due1 = 6_000_000;
  // Countdown at 12s → mode change reconciles to 3s (new due timestamp):
  // tick 3 fires once, then 2 and 1.
  const due2 = due1 - 12_000 + 3_000;
  const { ticks } = runSequence([
    at(due1, 12),
    { enabled: true, dueAtMs: due2, nowMs: due1 - 12_000 },
    at(due2, 2), at(due2, 1), at(due2, 0),
  ]);
  assertEq(ticks.join(","), ",3,2,1,", "12s → 3s reconciliation ticks 3 once, then 2, then 1");

  // 12s → 2s direct jump: only the actually-reached second fires — no
  // fabricated 3.
  const due3 = due1 - 12_000 + 2_000;
  const { ticks: jump } = runSequence([
    at(due1, 12),
    { enabled: true, dueAtMs: due3, nowMs: due1 - 12_000 },
    at(due3, 1),
  ]);
  assertEq(jump.join(","), ",2,1", "12s → 2s jump never fabricates a 3 tick");

  // With ceil semantics, a fraction of the final second is honestly second 1.
  const due4 = due1 - 12_000 + 400;
  const { ticks: under } = runSequence([
    at(due1, 12),
    { enabled: true, dueAtMs: due4, nowMs: due1 - 12_000 },
  ]);
  assertEq(under.join(","), ",1", "reconcile to the final fractional second ticks 1");
}

// ─── Rapid mode changes: no spam ───────────────────────────────────────────
function testRapidModeChanges() {
  const base = 7_000_000;
  const { ticks } = runSequence([
    at(base, 12),
    // Three rapid reconciliations, each landing in the final seconds.
    { enabled: true, dueAtMs: base - 9_000, nowMs: base - 12_000 },  // 3s
    { enabled: true, dueAtMs: base - 9_500, nowMs: base - 12_000 },  // 2.5s → still shows 3
    { enabled: true, dueAtMs: base - 10_000, nowMs: base - 12_000 }, // 2s
  ]);
  assertEq(ticks.join(","), ",3,,2", "rapid reschedules tick only genuinely-new reached seconds");
}

// ─── A new attempt with the same second doesn't double-fire ───────────────
function testSameSecondNewAttempt() {
  const due1 = 8_000_000;
  const due2 = 8_000_000 + 500; // reschedule that lands on the same displayed second
  const { ticks } = runSequence([
    at(due1, 3),
    { enabled: true, dueAtMs: due2, nowMs: due1 - 3_000 }, // still shows 3
  ]);
  assertEq(ticks.join(","), "3,", "same-second reschedule does not re-tick");
}

// ─── Shared instance dedupes across consumers / survives reset ────────────
function testSharedInstance() {
  resetSharedCountdownTick();
  const due = 9_000_000;
  assertEq(evaluateSharedCountdownTick({ enabled: true, dueAtMs: due, nowMs: due - 3_000 }), 3,
    "shared instance ticks at 3");
  assertEq(evaluateSharedCountdownTick({ enabled: true, dueAtMs: due, nowMs: due - 3_000 }), null,
    "shared instance dedupes a second consumer evaluating the same second");
  assertEq(evaluateSharedCountdownTick({ enabled: true, dueAtMs: due, nowMs: due - 2_000 }), 2,
    "shared instance ticks at 2");
  resetSharedCountdownTick();
  assertEq(evaluateSharedCountdownTick({ enabled: true, dueAtMs: due, nowMs: due - 3_000 }), 3,
    "reset restores a clean ledger");
}

testNormalCountdown();
testNoDuplicateWithinSecond();
testDisableStopsTicks();
testPauseResume();
testSupersede();
testReconcileJump();
testRapidModeChanges();
testSameSecondNewAttempt();
testSharedInstance();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failures:\n" + failures.join("\n"));
  process.exit(1);
} else {
  console.log("All countdown tick tests passed!");
}
