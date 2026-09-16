/**
 * useNowTick — the app's single shared 1-second clock.
 *
 * Problem this solves: eleven `setInterval(() => setNow(Date.now()), 1000)` timers
 * across ten modules ran only to keep relative labels honest ("12s ago",
 * "Next check in 42s", "Session 3m 20s"): AnalyticsPanel, AutoForgeHUD (the
 * decision card *and* the rate-limit indicator), AutoForgeReport,
 * AutoCheckControls, CoreWorkspace, CoreMobileWorkspace, MultiBotPanel,
 * PerceptionStrip, StatusBar, and the provider-health poll inside
 * useCoreReadiness. Every one was a separate browser timer wake-up *and* a
 * potential React update, even though they all wanted the same value at the
 * same instant.
 *
 * Now there is one refcounted interval: the first subscriber starts it, the
 * last one stops it. Every consumer reads the same cached value; actual React
 * commit counts depend on scheduling and must be measured in the browser.
 *
 * Semantics (deliberate):
 *   - `useNowTick()` re-renders the calling component once per second.
 *   - `useNowTick(false)` drops the subscription entirely — for panels that
 *     only show relative times while open, so a closed panel costs no timer.
 *     While disabled the returned number is the last cached tick rather than a
 *     fresh `Date.now()`: a snapshot that changes without a notification would
 *     make React re-render on every read.
 *   - The clock can be up to one tick (~1s) old when first observed. That is
 *     the same granularity these labels already rendered at, so it is not a
 *     behaviour change — it just means callers must not treat the value as an
 *     exact `Date.now()`.
 *   - `Date.now()` is never called during render, so nothing here can loop.
 *
 * Non-React callers (module-level polling) use `subscribeSecondTick` directly.
 * The cadence pollers that only need a 1s heartbeat ride the same interval:
 * the `useCoreReadiness` provider-health poll, StatusBar's send-rate read,
 * ForgeLayout's vision countdown and chat-activity level, and TuningDeck's
 * provider sync — none of them owns a private timer.
 */

import { useCallback, useSyncExternalStore } from "react";

const TICK_MS = 1000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let currentNow = Date.now();

function startTimer() {
  if (timer !== null) return;
  timer = setInterval(() => {
    currentNow = Date.now();
    // New subscriptions wait until the next tick; removed ones must not run
    // from this snapshot after their owner has already cleaned up.
    for (const listener of Array.from(listeners)) {
      if (listeners.has(listener)) listener();
    }
  }, TICK_MS);
}

function stopTimer() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Subscribe to the shared 1s clock. Returns the unsubscribe function.
 *
 * Used directly by non-React polling (see `useCoreReadiness`) so the whole app
 * still shares exactly one interval.
 */
export function subscribeSecondTick(listener: () => void): () => void {
  // Each registration owns its lifetime, even for the same callback. A repeated
  // cleanup must not remove another consumer's registration.
  const subscription = () => listener();
  // Only a stopped clock needs refreshing. Mutating an active snapshot here
  // would change the external store without notifying its existing consumers.
  if (listeners.size === 0) currentNow = Date.now();
  listeners.add(subscription);
  startTimer();
  return () => {
    listeners.delete(subscription);
    if (listeners.size === 0) stopTimer();
  };
}

/** Current cached tick (milliseconds since epoch). Stable between ticks. */
export function getSecondTickNow(): number {
  return currentNow;
}

// No SSR in this app (Vite SPA), so the client snapshot is also the server one.
const noopSubscribe = () => () => {};

/**
 * Re-render the calling component once per second and return the cached tick.
 * Pass `false` to release the subscription (and the shared timer, once nobody
 * else is listening).
 */
export function useNowTick(enabled: boolean = true): number {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeSecondTick(listener) : noopSubscribe(),
    [enabled],
  );
  return useSyncExternalStore(subscribe, getSecondTickNow, getSecondTickNow);
}
