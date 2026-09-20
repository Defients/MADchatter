import { useEffect } from "react";
import { evaluateSharedCountdownTick } from "../lib/autoCheckCountdown";
import { playAutoCheckTick } from "../lib/sfx";

/**
 * useAutoCheckCountdownTicks — mobile-only soft 3→2→1 ticks as the NEXT CHECK
 * countdown reaches its final seconds.
 *
 * Pure evaluation lives in `lib/autoCheckCountdown.ts` (shared ledger, keyed
 * by the scheduled-attempt timestamp, remount-safe); this hook only feeds it
 * the shared 1s clock and owns the sound side-effect. Ticks never fire while
 * the tab is hidden — a backgrounded phone doesn't need countdown feedback
 * and mobile browsers throttle/suspend audio there anyway.
 */
export function useAutoCheckCountdownTicks(input: {
  /** Master gate: mobile + AutoForge on + auto-check on + live countdown. */
  enabled: boolean;
  /** Absolute due timestamp of the scheduled attempt (null = no countdown). */
  dueAtMs: number | null;
  /** Shared 1s clock value (`useNowTick`). */
  now: number;
}): void {
  const { enabled, dueAtMs, now } = input;
  useEffect(() => {
    if (enabled && typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const tick = evaluateSharedCountdownTick({ enabled, dueAtMs, nowMs: now });
    if (tick) playAutoCheckTick(tick);
  }, [enabled, dueAtMs, now]);
}
