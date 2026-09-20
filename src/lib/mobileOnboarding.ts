import type { TrialStatus } from "./trial";

/** Versioned independently from the application release. */
export const MOBILE_WELCOME_SEEN_KEY = "madchatter_mobile_welcome_seen_v1";

export function hasSeenMobileWelcome(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(MOBILE_WELCOME_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function acknowledgeMobileWelcome(storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(MOBILE_WELCOME_SEEN_KEY, "1");
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // current visit still dismisses normally; only cross-reload memory is lost.
  }
}

export interface MobileFriendTrialVisibilityInput {
  workerConfigured: boolean;
  turnstileConfigured: boolean;
  status: TrialStatus | null;
  sessionValid: boolean;
}

/**
 * A valid canonical session always remains manageable. Otherwise the compact
 * entry is shown only after the configured Worker authoritatively reports an
 * enabled trial and any required Turnstile configuration is present.
 */
export function shouldShowMobileFriendTrial({
  workerConfigured,
  turnstileConfigured,
  status,
  sessionValid,
}: MobileFriendTrialVisibilityInput): boolean {
  if (sessionValid) return true;
  if (!workerConfigured || !status?.enabled) return false;
  return !status.requiresTurnstile || turnstileConfigured;
}
