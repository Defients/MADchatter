import assert from "node:assert/strict";
import {
  acknowledgeMobileWelcome,
  hasSeenMobileWelcome,
  MOBILE_WELCOME_SEEN_KEY,
  shouldShowMobileFriendTrial,
} from "./mobileOnboarding";
import type { TrialStatus } from "./trial";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
assert.equal(hasSeenMobileWelcome(storage), false, "fresh storage shows the mobile welcome");
acknowledgeMobileWelcome(storage);
assert.equal(storage.getItem(MOBILE_WELCOME_SEEN_KEY), "1", "acknowledgment uses the versioned local preference");
assert.equal(hasSeenMobileWelcome(storage), true, "acknowledgment survives a later preference read");

const enabled: TrialStatus = {
  enabled: true,
  requiresTurnstile: true,
  requiresInviteCode: false,
};
const disabled: TrialStatus = { ...enabled, enabled: false, reason: "DISABLED" };
const ended: TrialStatus = { ...enabled, enabled: false, reason: "ENDED" };

assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: true,
  turnstileConfigured: true,
  status: enabled,
  sessionValid: false,
}), true, "configured and authoritatively enabled trial is visible");

// BYOK selection is intentionally absent from the visibility contract. An
// enabled Friend Trial stays first in the list whether another provider is
// configured, selected, or neither.
assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: true,
  turnstileConfigured: true,
  status: enabled,
  sessionValid: false,
}), true, "enabled trial visibility is independent of BYOK provider state");

assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: true,
  turnstileConfigured: true,
  status: disabled,
  sessionValid: false,
}), false, "disabled trial is hidden");

assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: true,
  turnstileConfigured: true,
  status: ended,
  sessionValid: false,
}), false, "ended trial is hidden");

assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: false,
  turnstileConfigured: false,
  status: null,
  sessionValid: true,
}), true, "a valid canonical session remains visible and manageable");

assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: true,
  turnstileConfigured: false,
  status: enabled,
  sessionValid: false,
}), false, "required but missing Turnstile configuration never advertises an unusable trial");

assert.equal(shouldShowMobileFriendTrial({
  workerConfigured: true,
  turnstileConfigured: false,
  status: { ...enabled, requiresTurnstile: false },
  sessionValid: false,
}), true, "a Worker that does not require Turnstile needs no site key");

console.log("Mobile onboarding preference and Friend Trial availability regressions passed");
