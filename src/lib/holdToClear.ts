/**
 * Hold-to-Clear controller — the deterministic core of the "hold to confirm"
 * interaction used by the Forge (desktop) and Core Mobile workspace.
 *
 * This used to be duplicated in TheForge.tsx and CoreMobileWorkspace.tsx with
 * a subtle race: the completion setTimeout reset holdProgress to 0, but a
 * stale final requestAnimationFrame callback could run afterwards and set the
 * progress back to 1 — leaving the button rendered as "Clearing..." forever.
 *
 * Fix: a generation guard. Every start() and every teardown (completion,
 * cancel, dispose) bumps the generation; a tick whose captured generation no
 * longer matches the live one is a no-op. Timeout and RAF are always cleared
 * on teardown, and progress is forced back to exactly 0.
 *
 * Pure, framework-free, fully injectable I/O for deterministic tests.
 */

export interface HoldToClearController {
  /** Begin (or restart) a hold. */
  start(): void;
  /** Cancel an in-flight hold (release, pointer cancel, etc.). Harmless if idle. */
  cancel(): void;
  /** Current progress in [0, 1]. Exactly 0 whenever idle. */
  getProgress(): number;
  /** True only while a hold is in flight. */
  isHolding(): boolean;
  /** Subscribe to progress/holding changes. Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
  /** Teardown — call on unmount. Cancels timer + RAF, resets progress. */
  dispose(): void;
}

export interface HoldToClearOptions {
  /** Hold duration in ms (default 1250). */
  durationMs?: number;
  /** Called exactly once, after a successful hold completes. */
  onConfirm?: () => void;
  /** Injectable clock (default performance.now). */
  now?: () => number;
  /** Injectable timer I/O (default setTimeout/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** Injectable frame I/O (default requestAnimationFrame/cancelAnimationFrame). */
  requestFrame?: (cb: (t: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

export function createHoldToClear(options: HoldToClearOptions = {}): HoldToClearController {
  const durationMs = Math.max(1, options.durationMs ?? 1250);
  const now = options.now ?? (() => performance.now());
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const requestFrame = options.requestFrame ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));
  const onConfirm = options.onConfirm;

  let progress = 0;
  let holding = false;
  // The generation guard: every start() captures the current generation; every
  // teardown bumps it. Stale timer/RAF callbacks compare against the live
  // generation and do nothing when they no longer match.
  let generation = 0;
  let timerId: unknown = null;
  let rafId: number | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of listeners) l();
  };
  const setProgress = (p: number) => {
    progress = p;
    emit();
  };
  const setHolding = (h: boolean) => {
    if (holding === h) return;
    holding = h;
    emit();
  };

  /** Invalidate everything in flight, reset progress to exactly 0. */
  function teardown() {
    generation += 1;
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    if (progress !== 0) setProgress(0);
    setHolding(false);
  }

  let startAt = 0;

  function start() {
    teardown();
    const gen = generation;
    setHolding(true);
    startAt = now();
    const boundedTick = (t: number) => {
      // Stale callback from a previous hold (or after completion/cancel):
      // the generation moved on — never touch state.
      if (gen !== generation) return;
      const p = Math.min(1, (t - startAt) / durationMs);
      setProgress(p);
      if (p < 1) rafId = requestFrame(boundedTick);
    };
    rafId = requestFrame(boundedTick);
    timerId = setTimer(() => {
      // Completion only counts if this hold is still the live one.
      if (gen !== generation) return;
      teardown();
      onConfirm?.();
    }, durationMs);
  }

  return {
    start,
    cancel: teardown,
    getProgress: () => progress,
    isHolding: () => holding,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: teardown,
  };
}
