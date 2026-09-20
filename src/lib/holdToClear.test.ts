/**
 * Focused test harness for the shared Hold-to-Clear controller
 * (src/lib/holdToClear.ts) — the deterministic core behind the desktop
 * Forge and mobile CORE "Hold to Clear" buttons.
 * Run: npx tsx src/lib/holdToClear.test.ts
 *
 * Regression context: the previous duplicated timer/RAF implementations
 * could leave a stale final RAF frame alive after completion — the completion
 * timeout reset progress to 0, then the stale RAF set it back to 1, leaving
 * the button stuck on "Clearing...". These tests pin the generation-guard
 * contract that makes that impossible.
 *
 * Fully deterministic: the controller accepts injected timer/frame/clock
 * I/O, so no real timers or RAF are used.
 */

type Frame = { cb: (t: number) => void; id: number };

let frames: Frame[] = [];
let frameId = 0;
let timers: Array<{ fn: () => void; id: number; cleared: boolean }> = [];
let timerId = 0;

const requestFrame = (cb: (t: number) => void) => {
  frameId += 1;
  frames.push({ cb, id: frameId });
  return frameId;
};
const cancelFrame = (id: number) => {
  frames = frames.filter((f) => f.id !== id);
};
const setTimer = (fn: () => void, _ms: number) => {
  timerId += 1;
  timers.push({ fn, id: timerId, cleared: false });
  return timerId;
};
const clearTimer = (id: unknown) => {
  const t = timers.find((x) => x.id === id);
  if (t) t.cleared = true;
};

function resetHarness() {
  frames = [];
  timers = [];
  frameId = 0;
  timerId = 0;
}

function pumpFrame(time: number) {
  const pending = frames;
  frames = [];
  for (const f of pending) f.cb(time);
}

function flushTimers() {
  const due = timers.filter((t) => !t.cleared);
  timers = [];
  for (const t of due) t.fn();
}

// Static import (this file has no other import syntax — without it tsx
// would treat the file as CommonJS and reject top-level await usage).
import { createHoldToClear } from "./holdToClear";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let currentTime = 0;
let confirmCount = 0;

function make(opts: { durationMs?: number; onConfirm?: () => void } = {}) {
  return createHoldToClear({
    durationMs: opts.durationMs ?? 1250,
    onConfirm: opts.onConfirm,
    now: () => currentTime,
    setTimer,
    clearTimer,
    requestFrame,
    cancelFrame,
  });
}

resetHarness();

// ─── 1. Complete hold clears exactly once + 2. stale RAF cannot resurrect ──
{
  confirmCount = 0;
  const c = make({ onConfirm: () => { confirmCount += 1; } });
  let progress = -1;
  let holding = false;
  c.subscribe(() => { progress = c.getProgress(); holding = c.isHolding(); });
  c.start();
  check("start sets holding", c.isHolding() === true);
  pumpFrame(400);
  check("mid-hold progress is partial", progress > 0 && progress < 1, `progress=${progress}`);
  pumpFrame(1250);
  check("progress reaches 1", progress === 1, `progress=${progress}`);
  check("timer still pending before flush", timers.some((t) => !t.cleared));
  flushTimers();
  check("confirm fired exactly once", confirmCount === 1);
  check("progress back to 0 after completion", c.getProgress() === 0, `progress=${c.getProgress()}`);
  check("no longer holding after completion", c.isHolding() === false);
  check("no pending frames after completion", frames.length === 0);
  check("no pending timers after completion", !timers.some((t) => !t.cleared));

  // Historical race: a frame callback queued BEFORE completion arrives AFTER
  // it — the old bug set progress back to 1 ("Clearing..." stuck forever).
  c.start();
  pumpFrame(100);
  const stale = frames[0];
  pumpFrame(1250);
  flushTimers();
  check("completed second hold", confirmCount === 2 && c.getProgress() === 0);
  stale.cb(1300);
  check("stale RAF cannot resurrect progress", c.getProgress() === 0, `progress=${c.getProgress()}`);
  check("stale RAF does not re-fire confirm", confirmCount === 2);
}

// ─── 3. Short press cancels and does not clear ──────────────────────────────
{
  confirmCount = 0;
  const c = make({ onConfirm: () => { confirmCount += 1; } });
  c.start();
  pumpFrame(300);
  c.cancel();
  check("cancel resets progress to 0", c.getProgress() === 0);
  check("cancel stops holding", c.isHolding() === false);
  check("cancel clears the timer", !timers.some((t) => !t.cleared));
  flushTimers();
  check("confirm never fires after cancel", confirmCount === 0);
  c.start();
  pumpFrame(200);
  const late = frames[0];
  c.cancel();
  late.cb(900);
  check("late frame after cancel is inert", c.getProgress() === 0);
  flushTimers();
  check("late frame after cancel does not confirm", confirmCount === 0);
}

// ─── 4. Second complete hold works immediately (repeatable) ─────────────────
{
  confirmCount = 0;
  const c = make({ onConfirm: () => { confirmCount += 1; } });
  let progress = -1;
  c.subscribe(() => { progress = c.getProgress(); });
  c.start();
  pumpFrame(1250);
  flushTimers();
  check("first hold completes", confirmCount === 1 && c.getProgress() === 0);
  c.start();
  check("second hold restarts from 0", progress === 0, `progress=${progress}`);
  pumpFrame(1250);
  flushTimers();
  check("second hold completes", confirmCount === 2 && c.getProgress() === 0);
  c.start();
  pumpFrame(1250);
  flushTimers();
  check("third hold completes (repeatable)", confirmCount === 3 && c.getProgress() === 0);
}

// ─── 5. Restart mid-hold invalidates the previous attempt ───────────────────
{
  confirmCount = 0;
  const c = make({ onConfirm: () => { confirmCount += 1; } });
  c.start();
  pumpFrame(300);
  const orphan = frames[0];
  c.start();
  orphan.cb(1000);
  check("orphaned frame from the first attempt is inert", c.getProgress() < 0.9, `progress=${c.getProgress()}`);
  pumpFrame(1250);
  flushTimers();
  check("exactly one confirm after restart", confirmCount === 1, `count=${confirmCount}`);
  check("progress fully reset after completion", c.getProgress() === 0);
}

// ─── 6. Pointer-cancel semantics: cancel is always harmless ─────────────────
{
  const c = make();
  c.cancel();
  check("cancel while idle is a no-op", c.getProgress() === 0 && !c.isHolding());
  c.start();
  pumpFrame(1250);
  flushTimers();
  c.cancel();
  check("cancel after completion is a no-op", c.getProgress() === 0 && !c.isHolding());
}

// ─── 7. Dispose cleans everything (unmount) ─────────────────────────────────
{
  confirmCount = 0;
  const c = make({ onConfirm: () => { confirmCount += 1; } });
  c.start();
  pumpFrame(600);
  c.dispose();
  check("dispose resets progress", c.getProgress() === 0);
  check("dispose clears the timer", !timers.some((t) => !t.cleared));
  check("dispose cancels the frame", frames.length === 0);
  flushTimers();
  check("dispose prevents confirm", confirmCount === 0);
}

console.log(`\nHold-to-Clear: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
