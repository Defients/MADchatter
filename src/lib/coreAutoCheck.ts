/**
 * coreAutoCheck — user-configurable AutoForge Auto-Check cadence.
 *
 * Before this module, every AutoForge loop re-evaluated the chat context on a
 * hard-coded 15s tick. That made "NEXT CHECK" feel arbitrary: the user could
 * not slow it down (saving tokens/battery) and CORE had no way to say when the
 * next evaluation was actually going to happen.
 *
 * This module is the single source of truth for *when an AutoForge evaluation
 * is worthwhile*:
 *
 *   - `"interval"` — the user picks a cadence (30s / 1m / 2m / 5m). A check
 *     runs no more often than that, and only if the existing model pacing
 *     (`autoForgeNextActionMs`) also says it's time.
 *   - `"smart"` — no fixed cadence. A check runs when the context actually
 *     changed (new chat, new transcript, new visual frame, new bot activity)
 *     and the minimum floor has elapsed. Mentions and activity spikes always
 *     bypass the gate so the bot never ignores being addressed.
 *
 * Pure functions only — no React, no store access — so both AutoForge loops,
 * CORE, STUDIO and the test suite share exactly one implementation.
 */

// Import the pure normalization from a leaf module — importing it from
// sessionScope would make store → coreAutoCheck → sessionScope → store a
// circular graph (TDZ crash when coreAutoCheck is the first entry point).
import { normalizeSessionChannel } from "./normalizeChannel";

export type AutoCheckMode = "smart" | "interval";

export interface AutoCheckModeOption {
  value: AutoCheckMode;
  label: string;
  description: string;
}

/** Smart = context-driven. Interval = user-chosen cadence. */
export const AUTO_CHECK_MODE_OPTIONS: ReadonlyArray<AutoCheckModeOption> = [
  {
    value: "smart",
    label: "Smart",
    description: "Checks only when something meaningful changes — new chat, transcript, visual frame, or bot activity.",
  },
  {
    value: "interval",
    label: "Interval",
    description: "Checks on a fixed cadence you choose. Predictable token spend.",
  },
];

export const DEFAULT_AUTO_CHECK_MODE: AutoCheckMode = "smart";
export const DEFAULT_AUTO_CHECK_INTERVAL_MS = 60_000;

/** Floor used in Smart mode. Prevents ultra-frequent polling while still
 *  reacting to new context faster than the coarsest manual cadence. */
export const AUTO_CHECK_SMART_FLOOR_MS = 30_000;

export const AUTO_CHECK_MIN_INTERVAL_MS = 30_000;
export const AUTO_CHECK_MAX_INTERVAL_MS = 15 * 60_000;

/** Supported manual cadences. Chosen around the existing AutoForge pacing
 *  architecture (the loop already respected a model-driven next-action time
 *  measured in tens of seconds) — not arbitrary ultra-frequent polling. */
export const AUTO_CHECK_INTERVAL_OPTIONS: ReadonlyArray<number> = [
  30_000,
  60_000,
  120_000,
  300_000,
];

export function normalizeAutoCheckMode(value: unknown): AutoCheckMode {
  return value === "interval" ? "interval" : "smart";
}

export function clampAutoCheckIntervalMs(value: unknown): number {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_AUTO_CHECK_INTERVAL_MS;
  return Math.min(AUTO_CHECK_MAX_INTERVAL_MS, Math.max(AUTO_CHECK_MIN_INTERVAL_MS, Math.round(ms)));
}
// ─── Context signal ───────────────────────────────────────────────────────

/**
 * A cheap fingerprint of "the things an AutoForge evaluation actually reads".
 * Comparing two of these answers: has anything meaningful changed since the
 * last evaluation? No AI call, no heavy work — string/number comparisons.
 */
export interface AutoCheckSignal {
  chatRevision: string;
  chatLength: number;
  transcriptRevision: string;
  visualRevision: string;
  botActivityCount: number;
  audioEnergyLabel: string;
  capturedAt: number;
}

export interface AutoCheckSignalInput {
  chatLog: ReadonlyArray<{ id?: string; user?: string; text?: string; timestamp?: number }>;
  audioTranscript: string;
  visualSnapshotUrl: string | null;
  visualSnapshotHistoryLength: number;
  sentMessagesLength: number;
  audioEnergyLabel?: string | null;
}

export function captureAutoCheckSignal(input: AutoCheckSignalInput, now: number = Date.now()): AutoCheckSignal {
  const chatLog = input.chatLog || [];
  const last = chatLog.length > 0 ? chatLog[chatLog.length - 1] : null;
  const transcript = input.audioTranscript || "";
  return {
    chatRevision: last ? `${last.id ?? last.timestamp ?? chatLog.length}:${last.user ?? ""}:${last.text ?? ""}` : "",
    chatLength: chatLog.length,
    transcriptRevision: transcript ? `${transcript.length}:${transcript.slice(-24)}` : "",
    visualRevision: `${input.visualSnapshotUrl ?? ""}:${input.visualSnapshotHistoryLength}`,
    botActivityCount: input.sentMessagesLength,
    audioEnergyLabel: input.audioEnergyLabel || "",
    capturedAt: now,
  };
}

/** True when the context an evaluation would read has meaningfully changed.
 *  A `null` baseline (first observation of a session) counts as a change so
 *  the first evaluation is never blocked by the fingerprint. */
export function hasMeaningfulContextChange(
  prev: AutoCheckSignal | null,
  next: AutoCheckSignal,
): boolean {
  if (!prev) return true;
  return (
    prev.chatRevision !== next.chatRevision ||
    prev.transcriptRevision !== next.transcriptRevision ||
    prev.visualRevision !== next.visualRevision ||
    prev.botActivityCount !== next.botActivityCount ||
    prev.audioEnergyLabel !== next.audioEnergyLabel
  );
}

// ─── Cadence decision ─────────────────────────────────────────────────────

/** The minimum gap between two AutoForge evaluations for the given mode. */
export function resolveAutoCheckFloorMs(mode: AutoCheckMode, intervalMs: number): number {
  return mode === "interval" ? clampAutoCheckIntervalMs(intervalMs) : AUTO_CHECK_SMART_FLOOR_MS;
}

/**
 * The effective minimum gap between two *non-urgent* AutoForge evaluations.
 *
 * Combines the user's Auto-Check cadence floor with their send rate-limit min
 * cooldown. Rationale: if the bot cannot send more often than every N seconds,
 * evaluating more often than that only burns tokens/GPU on checks that can't
 * act anyway (mentions and activity spikes bypass this — they always proceed).
 *
 * This is the single source of truth the loops use to (a) floor the
 * model-driven next-check schedule, and (b) reschedule the pacing gate when
 * the cadence gate withholds a check — so the 15s heartbeat can no longer spin
 * the loop (flashing "Processing…" every tick) while the floor holds.
 */
export function resolveEffectiveCheckFloorMs(
  mode: AutoCheckMode,
  intervalMs: number,
  minCooldownMs: number,
): number {
  const cadenceFloor = resolveAutoCheckFloorMs(mode, intervalMs);
  const cooldown = typeof minCooldownMs === "number" && Number.isFinite(minCooldownMs) && minCooldownMs > 0
    ? minCooldownMs
    : 0;
  return Math.max(cadenceFloor, cooldown);
}

export interface AutoCheckCadenceDecision {
  /** True when the loop may spend a model evaluation now. */
  run: boolean;
  /** True when new context exists but the cadence floor is withholding the
   *  check — the UI can honestly say "new context queued". */
  armed: boolean;
  reason: string;
  /** Timestamp of the next time a non-urgent evaluation becomes eligible
   *  (`lastCheckAt + effectiveFloorMs`). Populated only for the time-based
   *  floor block — the loops use it to reschedule the pacing gate so the
   *  15s heartbeat doesn't spin (flashing "Processing…" every tick) while
   *  the floor withholds. `0` when the block is context-based (smart mode,
   *  no change) or when the check is allowed to run. */
  nextEligibleMs: number;
}

export interface AutoCheckCadenceArgs {
  mode: AutoCheckMode;
  intervalMs: number;
  now: number;
  /** Timestamp of the last evaluation that actually reached the model.
   *  0 (or a value in the future / non-finite) means "never checked yet". */
  lastCheckAt: number;
  /** Whether the context fingerprint changed since the last evaluation. */
  signalsChanged: boolean;
  /** Mention or activity spike — always takes priority over pacing. */
  urgent?: boolean;
  /** Send rate-limit min cooldown (ms). When greater than the cadence floor,
   *  the effective floor widens to it: there's no value evaluating faster
   *  than the bot is allowed to act. Urgent checks bypass this. Optional for
   *  backward compatibility (callers/tests that omit it get the cadence-only
   *  floor, preserving existing behavior). */
  minCooldownMs?: number;
}

export function evaluateAutoCheckCadence(args: AutoCheckCadenceArgs): AutoCheckCadenceDecision {
  const mode = normalizeAutoCheckMode(args.mode);
  const floorMs = args.minCooldownMs && args.minCooldownMs > 0
    ? resolveEffectiveCheckFloorMs(mode, args.intervalMs, args.minCooldownMs)
    : resolveAutoCheckFloorMs(mode, args.intervalMs);

  if (args.urgent) {
    return { run: true, armed: false, reason: "mention or activity spike", nextEligibleMs: 0 };
  }

  const last = args.lastCheckAt;
  const elapsed = typeof last === "number" && Number.isFinite(last) && last > 0 && last <= args.now
    ? args.now - last
    : Infinity;

  if (elapsed < floorMs) {
    // Time-based floor block: the next eligible moment is deterministic
    // (lastCheck + floor). Return it so the loop can reschedule the pacing
    // gate and stop the 15s heartbeat from spinning while the floor holds.
    const base = typeof last === "number" && last > 0 ? last : args.now;
    return {
      run: false,
      armed: args.signalsChanged,
      reason: `cadence floor (${formatAutoCheckInterval(floorMs)}) not reached`,
      nextEligibleMs: base + floorMs,
    };
  }

  if (mode === "smart" && !args.signalsChanged) {
    // Context-based block (no time floor): the check should run as soon as
    // context changes, so do NOT reschedule the pacing gate forward — leave
    // nextEligibleMs at 0 and let the next heartbeat re-evaluate cheaply.
    return { run: false, armed: false, reason: "smart mode: no new context", nextEligibleMs: 0 };
  }

  return {
    run: true,
    armed: false,
    reason: mode === "smart" ? "smart mode: new context detected" : "interval elapsed",
    nextEligibleMs: 0,
  };
}

// ─── UI helpers ───────────────────────────────────────────────────────────

export interface AutoCheckStatusArgs {
  mode: AutoCheckMode;
  /** True when a check is currently in-flight. */
  checking: boolean;
  /** True when new context is waiting for the cadence floor. */
  armed: boolean;
  /** Milliseconds until the next scheduled evaluation (interval mode only). */
  dueInMs: number | null;
  /** Auto-Check is paused entirely (`autoForgeAutoCheckEnabled === false`). */
  paused?: boolean;
}

/** The one-line status the AutoForge control area shows. Honest by design:
 *  interval mode reports a real countdown, smart mode never fakes one. */
export function describeAutoCheckStatus(args: AutoCheckStatusArgs): string {
  if (args.paused) return "Auto-Check paused";
  if (args.checking) return "Checking now…";
  if (normalizeAutoCheckMode(args.mode) === "smart") {
    return args.armed ? "New context — check queued" : "Waiting for new context";
  }
  if (args.dueInMs === null || !Number.isFinite(args.dueInMs)) return "Next check pending";
  const seconds = Math.max(0, Math.round(args.dueInMs / 1000));
  return seconds <= 0 ? "Checking shortly…" : `Next check in ${seconds}s`;
}

export interface AutoCheckWindow {
  /** Milliseconds since the last evaluation (0 when never checked). */
  elapsedMs: number;
  /** Milliseconds until the next evaluation is due. */
  dueInMs: number;
  /** Absolute timestamp of the effective due moment (max of cadence due and
   *  model pacing due) — the countdown's scheduled-attempt identity. */
  dueAtMs: number;
  /** 0→1 progress toward the next evaluation. */
  progress: number;
}

/**
 * Progress toward the next evaluation, used to drive the CORE countdown bar.
 * Derived from a timestamp the loops already maintain — the bar itself is a
 * pure CSS animation, so nothing here runs per frame.
 *
 * `nextActionMs` is the model-driven pacing floor (`autoForgeNextActionMs`).
 * The actual next check is `max(lastCheckAt + floorMs, nextActionMs)` — the
 * cadence is the user's maximum frequency, but the model can pace slower.
 * Without this, the countdown reaches 0 and sits at "Checking shortly…"
 * for minutes while the model pacing gate blocks the cadence gate from
 * running.
 */
export function computeAutoCheckWindow(
  args: { mode: AutoCheckMode; intervalMs: number; lastCheckAt: number; now: number; nextActionMs?: number; minCooldownMs?: number },
): AutoCheckWindow {
  const floorMs = args.minCooldownMs && args.minCooldownMs > 0
    ? resolveEffectiveCheckFloorMs(args.mode, args.intervalMs, args.minCooldownMs)
    : resolveAutoCheckFloorMs(args.mode, args.intervalMs);
  const last = args.lastCheckAt;
  const elapsed = typeof last === "number" && Number.isFinite(last) && last > 0 && last <= args.now
    ? args.now - last
    : 0;
  // Cadence due time: lastCheck + floor. Model pacing due time: nextActionMs.
  // The actual next check is the LATER of the two — whichever gate opens last.
  const cadenceDueMs = last > 0 ? last + floorMs : 0;
  const modelDueMs = typeof args.nextActionMs === "number" && args.nextActionMs > 0 ? args.nextActionMs : 0;
  const effectiveDueMs = Math.max(cadenceDueMs, modelDueMs);
  const dueInMs = effectiveDueMs > 0 ? Math.max(0, effectiveDueMs - args.now) : floorMs;
  return {
    elapsedMs: elapsed,
    dueInMs,
    dueAtMs: effectiveDueMs > 0 ? effectiveDueMs : args.now + floorMs,
    progress: floorMs <= 0 ? 1 : Math.min(1, elapsed / floorMs),
  };
}

// ─── Mode-switch reconciliation ───────────────────────────────────────────

/** Minimum pull-forward (ms) that counts as a user-visible shortening. */
export const AUTO_CHECK_SHORTEN_NOTICE_MS = 1_000;

export interface AutoCheckScheduleReconcileArgs {
  /** The newly selected mode. */
  mode: AutoCheckMode;
  /** The newly selected cadence (interval mode). */
  intervalMs: number;
  now: number;
  /** Timestamp of the last evaluation that reached the model (0 = never). */
  lastCheckAt: number;
  /** Current pacing-gate timestamp (`autoForgeNextActionMs`). A timestamp ≤ now
   *  means the schedule is already due — treated as "as soon as possible",
   *  never pushed back out. Non-finite means no schedule. */
  scheduledMs: number;
  /** Send rate-limit min cooldown — widens the floor exactly like the loops. */
  minCooldownMs?: number;
}

export interface AutoCheckScheduleReconcileResult {
  /** The reconciled pacing-gate timestamp to write back. */
  nextActionMs: number;
  /** True when reconciliation moved the schedule meaningfully earlier — the
   *  UI uses this to flash the shortened countdown. */
  shortened: boolean;
}

/**
 * Reconcile the live NEXT CHECK schedule against a newly selected mode.
 *
 * A mode change may pull an overlong countdown forward, but must never push
 * an already-sooner (or already-due) attempt farther away:
 *
 *   - interval: the target is one cadence from now — `min(remaining, floor)`.
 *     48s remaining → 15s cadence = 15s; 8s remaining → 15s cadence = 8s.
 *   - smart: the target is the smart floor residual (lastCheck + floor). A
 *     fresh timing assessment replaces a stale countdown left over from a
 *     different mode; when the floor has already elapsed the check is due now
 *     and the context gate decides whether it spends a model call.
 *
 * The result is written to the pacing gate (`autoForgeNextActionMs`) only —
 * the cadence gate (lastCheck + floor) is recomputed live by the loops, so an
 * already-sooner attempt that the new floor legitimately blocks still resolves
 * honestly at fire time.
 */
export function reconcileAutoCheckSchedule(
  args: AutoCheckScheduleReconcileArgs,
): AutoCheckScheduleReconcileResult {
  const mode = normalizeAutoCheckMode(args.mode);
  const now = args.now;
  const floorMs = resolveEffectiveCheckFloorMs(mode, args.intervalMs, args.minCooldownMs ?? 0);

  // Earliest moment the cadence gate itself permits a non-urgent check.
  const last =
    typeof args.lastCheckAt === "number" && Number.isFinite(args.lastCheckAt) && args.lastCheckAt > 0 && args.lastCheckAt <= now
      ? args.lastCheckAt
      : 0;
  const cadenceDueMs = last > 0 ? last + floorMs : now;

  const modeDueMs = mode === "interval" ? now + floorMs : cadenceDueMs;
  const scheduledMs = typeof args.scheduledMs === "number" ? args.scheduledMs : NaN;
  const hasValidSchedule = Number.isFinite(scheduledMs) && scheduledMs > now;
  // A due/overdue timestamp means "check as soon as possible" — preserving it
  // as the remaining time keeps the attempt maximally soon rather than
  // pushing it out to the new mode's cadence.
  const remainingMs = Number.isFinite(scheduledMs) ? scheduledMs - now : Infinity;

  const nextActionMs = now + Math.min(remainingMs, Math.max(0, modeDueMs - now));
  return {
    nextActionMs,
    shortened: hasValidSchedule && nextActionMs <= scheduledMs - AUTO_CHECK_SHORTEN_NOTICE_MS,
  };
}

/** Re-exported so callers can normalize a channel the same way the rest of
 *  the app does (strips "#", trims, lowercases). */
export { normalizeSessionChannel };
/** "30s" | "1m" | "2m" | "5m" */
export function formatAutoCheckInterval(ms: number): string {
  const seconds = Math.round(clampAutoCheckIntervalMs(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}