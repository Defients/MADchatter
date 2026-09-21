import assert from "node:assert/strict";
import { ChannelSaveGate } from "./channelSave";

let calls = 0;
assert.equal(await new ChannelSaveGate().submit("old", "new", async () => { calls++; return true; }), "success");
assert.equal(await new ChannelSaveGate().submit("old", "new", async () => false), "failure");
assert.equal(await new ChannelSaveGate().submit("same", "same", async () => { throw new Error("must not call"); }), "same");

const gate = new ChannelSaveGate();
let release!: (value: boolean) => void;
const first = gate.submit("old", "new", () => new Promise<boolean>((resolve) => { release = resolve; }));
assert.equal(await gate.submit("old", "newer", async () => true), "duplicate");
release(true);
assert.equal(await first, "success");

await assert.rejects(
  () => new ChannelSaveGate().submit("old", "new", async () => { throw new Error("save exploded"); }),
  /save exploded/,
);
assert.equal(calls, 1);
console.log("6/6 channel-save contract scenarios passed");
