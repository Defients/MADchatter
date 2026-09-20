/**
 * autoCheckCountdown — dedupe state machine for the mobile 3→2→1 countdown
 * ticks.
 *
 * The NEXT CHECK countdown is display-driven (a shared 1s clock re-renders
 * the label), so ticks are derived from the same source: the absolute
 * scheduled-attempt timestamp (`dueAtMs`) and the displayed second. This
 * module decides — purely — whether the current observation should produce a
 * tick:
 *
 *   - each countdown second (3, 2, 1) fires at most once per scheduled
 *     attempt, where the attempt's identity IS its due timestamp;
 *   - a superseding schedule (mode reconciliation, model reschedule, a fresh
 *     post-check attempt) starts a fresh ledger — ticks for the new attempt
 *     may play again;
 *   - only genuinely *reached* seconds tick: a 12s→2s jump plays 2 (never a
 *     fabricated 3), a jump to <1s plays nothing, and a jump to a later
 *     second never ticks;
 *   - disabling/pausing drops the displayed-second tracker but keeps the
 *     attempt ledger, so a resume never replays ticks the attempt already
 *     spent.
 *
 * Pure functions only — no React, no store, no audio. The React hook drives
 * this reducer and owns the sound side-effect; tests drive it directly.
 */

export type CountdownTickStep = 1 | 2 | 3;

export interface CountdownTickState {
  /** Absolute due timestamp identifying the current scheduled attempt. */
  attemptMs: number | null;
  /** The displayed second last observed (null = no observation yet). */
  lastSecond: number | null;
  /** Seconds already ticked for the current attempt. */
  played: ReadonlySet<CountdownTickStep>;
}

export function initialCountdownTickState(): CountdownTickState {
  return { attemptMs: null, lastSecond: null, played: new Set() };
}

export interface CountdownTickInput {
  /** Master gate: AutoForge enabled + auto-check on + interval countdown live. */
  enabled: boolean;
  /** Absolute due timestamp of the scheduled attempt (null = no countdown). */
  dueAtMs: number | null;
  /** Current clock value (the same 1s tick the label renders from). */
  nowMs: number;
}

export interface CountdownTickResult {
  next: CountdownTickState;
  tick: CountdownTickStep | null;
}

/** The displayed countdown second — same rounding the status label uses. */
export function countdownSecond(dueAtMs: number, nowMs: number): number {
  return Math.max(0, Math.round((dueAtMs - nowMs) / 1000));
}

export function stepCountdownTick(
  state: CountdownTickState,
  input: CountdownTickInput,
): CountdownTickResult {
  const { enabled, dueAtMs, nowMs } = input;

  if (!enabled || dueAtMs === null || !Number.isFinite(dueAtMs)) {
    if (!enabled) {
      // Gate closed (pause/disable): forget the displayed second so resume
      // re-evaluates it, but keep the attempt ledger — a paused attempt must
      // not replay ticks it already spent.
      return { next: { ...state, lastSecond: null }, tick: null };
    }
    // No schedule at all — drop everything.
    return { next: initialCountdownTickState(), tick: null };
  }

  let attemptMs = state.attemptMs;
  let played = state.played;
  if (attemptMs !== dueAtMs) {
    // New or superseding scheduled attempt — fresh per-attempt ledger.
    attemptMs = dueAtMs;
    played = new Set();
  }

  const sec = countdownSecond(dueAtMs, nowMs);
  if (sec === state.lastSecond) {
    // Same displayed second (re-render, repeated timer update, or a
    // reschedule that landed on the same second) — never re-tick.
    return { next: { attemptMs, lastSecond: sec, played }, tick: null };
  }

  const reached = state.lastSecond === null || sec < state.lastSecond;
  const next: CountdownTickState = { attemptMs, lastSecond: sec, played };
  if (!reached || sec < 1 || sec > 3 || played.has(sec as CountdownTickStep)) {
    return { next, tick: null };
  }

  const newPlayed = new Set(played);
  newPlayed.add(sec as CountdownTickStep);
  return { next: { ...next, played: newPlayed }, tick: sec as CountdownTickStep };
}

// ─── Shared instance ──────────────────────────────────────────────────────
// Exactly one Auto-Check countdown exists app-wide, so one ledger lives at
// module scope: it survives component remounts and dedupes across any number
// of mounted consumers (a second consumer evaluating the same observation can
// never double-tick).

let shared: CountdownTickState = initialCountdownTickState();

/** Evaluate the shared ledger. Returns the tick to play, if any. */
export function evaluateSharedCountdownTick(input: CountdownTickInput): CountdownTickStep | null {
  const { next, tick } = stepCountdownTick(shared, input);
  shared = next;
  return tick;
}

/** Test/reset hook — clears the shared ledger. */
export function resetSharedCountdownTick(): void {
  shared = initialCountdownTickState();
}
