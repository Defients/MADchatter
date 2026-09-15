import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SendRateLimiter } from "./rateLimiter";
import { SendCancelledError } from "./sendCancellation";

const realNow = Date.now;
let now = 0;
afterEach(() => { Date.now = realNow; });

class TestSender extends SendRateLimiter {
  waits: number[] = [];
  constructor(limit = 2) {
    super();
    this.maxPerWindow = limit;
    now = 0;
    Date.now = () => now;
  }
  send(message: string, deliver: () => Promise<void> = async () => {}) {
    return this.sendWithRateLimit(message, deliver);
  }
  protected async waitForCapacity(ms: number) {
    this.waits.push(ms);
    now += ms;
  }
}

test("concurrent bursts obey the sliding window and preserve order", async () => {
  const sender = new TestSender();
  const deliveries: { message: string; time: number }[] = [];
  await Promise.all(Array.from({ length: 7 }, (_, i) => sender.send(String(i), async () => {
    deliveries.push({ message: String(i), time: Date.now() });
  })));
  assert.deepEqual(deliveries.map((d) => d.message), ["0", "1", "2", "3", "4", "5", "6"]);
  for (const delivery of deliveries) {
    assert.ok(deliveries.filter((d) => d.time <= delivery.time && delivery.time - d.time < 30_000).length <= 2);
  }
  assert.equal(sender.waits.length, 3);
});

test("duplicate queued behind a pending success is rejected", async () => {
  const sender = new TestSender();
  let finish!: () => void;
  let delivered = 0;
  const first = sender.send("Hello", () => new Promise<void>((resolve) => { finish = resolve; delivered++; }));
  const second = assert.rejects(sender.send(" hello ", async () => { delivered++; }), /Duplicate message/);
  await Promise.resolve();
  assert.equal(delivered, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(delivered, 1);
});

test("failure releases the queue and allows the same message to retry", async () => {
  const sender = new TestSender();
  let deliveries = 0;
  const failed = assert.rejects(sender.send("retry", async () => { throw new Error("offline"); }), /offline/);
  const retry = sender.send("retry", async () => { deliveries++; });
  await Promise.all([failed, retry]);
  assert.equal(deliveries, 1);
  assert.equal(sender.getRateStatus().used, 2, "failed attempts still use capacity");
});

test("repeated failures are paced without poisoning duplicate tracking", async () => {
  const sender = new TestSender(1);
  await assert.rejects(sender.send("retry", async () => { throw new Error("offline"); }), /offline/);
  await sender.send("retry");
  assert.equal(sender.waits.length, 1);
});

test("deduplication starts at completion and expires at the exact boundary", async () => {
  const sender = new TestSender();
  await sender.send("hello", async () => { now = 40_000; });
  now = 99_999;
  await assert.rejects(sender.send("HELLO"), /Duplicate message/);
  now = 100_000;
  await sender.send("hello");
});

test("a send at timestamp zero is still deduplicated", async () => {
  const sender = new TestSender();
  await sender.send("hello");
  await assert.rejects(sender.send("hello"), /Duplicate message/);
});

test("separate account limiters do not block or deduplicate each other", async () => {
  const alpha = new TestSender();
  const beta = new TestSender();
  let finish!: () => void;
  const pending = alpha.send("hello", () => new Promise<void>((resolve) => { finish = resolve; }));
  await beta.send("hello");
  assert.equal(beta.getRateStatus().used, 1);
  finish();
  await pending;
});

test("capacity is rechecked when a timer wakes early", async () => {
  class EarlyWakeSender extends TestSender {
    protected async waitForCapacity(ms: number) {
      this.waits.push(ms);
      now += this.waits.length === 1 ? 1 : ms;
    }
  }
  const sender = new EarlyWakeSender(1);
  await sender.send("one");
  await sender.send("two");
  assert.equal(sender.waits.length, 2);
  assert.ok(now >= 30_000);
});

class CancellableSender extends SendRateLimiter {
  constructor(limit = 20) { super(); this.maxPerWindow = limit; }
  send(message: string, deliver = async () => {}, signal?: AbortSignal) {
    return this.sendWithRateLimit(message, deliver, signal);
  }
}

test("pre-cancelled admission consumes no capacity and never delivers", async () => {
  const sender = new CancellableSender();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sender.send("cancelled", async () => { assert.fail("must not deliver"); }, controller.signal), SendCancelledError);
  assert.equal(sender.getRateStatus().used, 0);
  await sender.send("cancelled");
});

test("cancelled queued caller leaves promptly but does not overtake active delivery", async () => {
  const sender = new CancellableSender();
  let finish!: () => void;
  const first = sender.send("first", () => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const cancelled = assert.rejects(sender.send("withdrawn", async () => { assert.fail("withdrawn send delivered"); }, controller.signal), SendCancelledError);
  controller.abort();
  await cancelled;
  assert.equal(sender.getRateStatus().used, 1);
  let lastDelivered = false;
  const last = sender.send("last", async () => { lastDelivered = true; });
  await Promise.resolve();
  assert.equal(lastDelivered, false);
  finish();
  await Promise.all([first, last]);
  assert.equal(sender.getRateStatus().used, 2);
});

test("cancelling a rate wait consumes no additional capacity", async () => {
  const sender = new CancellableSender(1);
  await sender.send("first");
  const controller = new AbortController();
  const pending = assert.rejects(sender.send("waiting", async () => { assert.fail("must not deliver"); }, controller.signal), SendCancelledError);
  await Promise.resolve();
  controller.abort();
  await pending;
  assert.equal(sender.getRateStatus().used, 1);
});

test("cancelled non-abortable delivery retains ordering and success deduplication", async () => {
  const sender = new CancellableSender();
  const controller = new AbortController();
  let finish!: () => void;
  const first = assert.rejects(sender.send("uncertain", () => new Promise<void>(resolve => { finish = resolve; }), controller.signal), SendCancelledError);
  await Promise.resolve();
  controller.abort();
  await first;
  const duplicate = assert.rejects(sender.send("uncertain"), /Duplicate message/);
  finish();
  await duplicate;
  await sender.send("next");
});
