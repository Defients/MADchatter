import assert from "node:assert/strict";
import { sanitizeChannelInput } from "./channelInput";

const cases: Array<[string, string]> = [
  ["https://twitch.tv/testuser", "testuser"],
  ["https://www.twitch.tv/Test_User/", "Test_User"],
  ["twitch.tv/testuser", "testuser"],
  ["https://kick.com/someone", "someone"],
  ["kick.com/someone/", "someone"],
  ["https://kick.com/xqc?something=1", "xqc"],
  ["https://www.twitch.tv/sodapoppin/videos?filter=archives#player", "sodapoppin"],
  ["#someone", "someone"],
  ["@someone", "someone"],
  [" someone ", "someone"],
];

for (const [raw, expected] of cases) {
  assert.equal(sanitizeChannelInput(raw), expected, raw);
}

assert.equal(sanitizeChannelInput("https://twitch.tv/"), "", "host-only Twitch URL is not a channel");
assert.equal(sanitizeChannelInput("kick.com/"), "", "host-only Kick URL is not a channel");
assert.equal(sanitizeChannelInput("https://example.com/not-a-channel"), "", "unrelated URL is rejected");
assert.equal(sanitizeChannelInput("twitch.tv"), "", "bare supported host is not stored as a channel");
assert.equal(sanitizeChannelInput("https://twitch.tv/directory"), "", "reserved Twitch route is rejected");

console.log(`${cases.length + 5} channel-input sanitizer scenarios passed`);
