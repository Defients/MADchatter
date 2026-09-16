/** Shared clock lifecycle regressions, with no wall-clock sleeps. */
import assert from "node:assert/strict";
import { subscribeSecondTick, getSecondTickNow } from "./useNowTick";

const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let now = realNow();
let nextTimer = 0;
const timers = new Map<number, () => void>();
const cleanup: Array<() => void> = [];
let passed = 0;

Date.now = () => now;
globalThis.setInterval = ((callback: () => void, delay: number) => {
  assert.equal(delay, 1000);
  const id = ++nextTimer;
  timers.set(id, callback);
  return id;
}) as unknown as typeof setInterval;
globalThis.clearInterval = ((id: number) => {
  timers.delete(id);
}) as unknown as typeof clearInterval;

function subscribe(listener: () => void) {
  const unsubscribe = subscribeSecondTick(listener);
  cleanup.push(unsubscribe);
  return unsubscribe;
}

function tick() {
  now += 1000;
  for (const callback of [...timers.values()]) callback();
}

function test(name: string, run: () => void) {
  try {
    run();
    console.log(`PASS ${name}`);
    passed++;
  } finally {
    for (const unsubscribe of cleanup.splice(0)) unsubscribe();
    assert.equal(timers.size, 0, "every subscription releases its timer");
  }
}

try {
  test("snapshot is finite and stable between ticks", () => {
    const snapshot = getSecondTickNow();
    assert.ok(Number.isFinite(snapshot) && snapshot > 0 && snapshot <= now);
    now += 5000;
    assert.equal(getSecondTickNow(), snapshot);
  });

  test("first subscriber refreshes a stopped clock; last release stops it", () => {
    let calls = 0;
    const unsubscribe = subscribe(() => calls++);
    assert.equal(getSecondTickNow(), now);
    assert.equal(timers.size, 1);
    tick();
    assert.equal(calls, 1);
    unsubscribe();
    const snapshot = getSecondTickNow();
    tick();
    assert.equal(calls, 1);
    assert.equal(getSecondTickNow(), snapshot);
    subscribe(() => calls++);
    assert.equal(getSecondTickNow(), now);
    tick();
    assert.equal(calls, 2);
  });

  test("joining an active clock does not silently change its snapshot", () => {
    const a: number[] = [];
    const b: number[] = [];
    subscribe(() => a.push(getSecondTickNow()));
    const snapshot = getSecondTickNow();
    now += 250;
    subscribe(() => b.push(getSecondTickNow()));
    assert.equal(getSecondTickNow(), snapshot);
    assert.equal(timers.size, 1, "all consumers share one interval");
    tick();
    assert.deepEqual(a, [now]);
    assert.deepEqual(b, a);
  });

  test("duplicate callbacks have independent, idempotent subscriptions", () => {
    let calls = 0;
    const listener = () => calls++;
    const first = subscribe(listener);
    const second = subscribe(listener);
    tick();
    assert.equal(calls, 2);
    first();
    first();
    tick();
    assert.equal(calls, 3, "releasing one registration preserves the other");
    assert.equal(timers.size, 1);
    second();
    assert.equal(timers.size, 0);
  });

  test("a listener removed during notification is not called", () => {
    let calls = 0;
    let removeNext = () => {};
    subscribe(() => removeNext());
    removeNext = subscribe(() => calls++);
    tick();
    assert.equal(calls, 0);
  });

  test("listeners added during notification start on the following tick", () => {
    let calls = 0;
    let added = false;
    subscribe(() => {
      if (!added) {
        added = true;
        const snapshot = getSecondTickNow();
        now += 10;
        subscribe(() => calls++);
        assert.equal(getSecondTickNow(), snapshot);
      }
    });
    tick();
    assert.equal(calls, 0);
    tick();
    assert.equal(calls, 1);
  });

  test("a listener may unsubscribe itself without skipping its peers", () => {
    let calls = 0;
    let removeSelf = () => {};
    removeSelf = subscribe(() => removeSelf());
    subscribe(() => calls++);
    tick();
    tick();
    assert.equal(calls, 2);
    assert.equal(timers.size, 1);
  });
} finally {
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}

console.log(`\n${passed} shared-clock lifecycle scenarios passed.`);
