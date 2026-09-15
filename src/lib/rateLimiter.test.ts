import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SendRateLimiter } from "./rateLimiter";

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
