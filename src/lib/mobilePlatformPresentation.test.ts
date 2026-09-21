import assert from "node:assert/strict";
import { getMobilePlatformPresentation, normalizePersistedMobilePlatform } from "./mobilePlatformPresentation";

assert.equal(normalizePersistedMobilePlatform({ platform: "joystick", twitchAuthenticated: false, kickAuthenticated: false }), "twitch");
assert.equal(normalizePersistedMobilePlatform({ platform: "joystick", twitchAuthenticated: false, kickAuthenticated: true }), "kick");
assert.equal(normalizePersistedMobilePlatform({ platform: "joystick", twitchAuthenticated: true, kickAuthenticated: true }), "twitch");
assert.match(getMobilePlatformPresentation("twitch").showVideoClass, /9146FF|purple/i);
assert.match(getMobilePlatformPresentation("kick").showVideoClass, /53fc18/i);
assert.notEqual(getMobilePlatformPresentation("twitch").activeSelectorClass, getMobilePlatformPresentation("kick").activeSelectorClass);
console.log("Mobile Twitch/Kick normalization and presentation scenarios passed");
