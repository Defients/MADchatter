/**
 * AutoCheckControls — the single AutoForge Auto-Check cadence surface for CORE.
 *
 * Replaces the implicit "checks every 15 seconds" behavior with something the
 * user actually controls, and makes the next evaluation legible:
 *
 *   [ Auto-Check ON/OFF ]  [ Smart | 30s | 1m | 2m | Custom ]
 *   ▂▂▂▂▂▂▂▂▂▂▂———————   Next check in 42s
 *
 * Performance notes (these systems update often, so this component is built to
 * never be the reason CORE re-renders):
 *   - The progress bar is a pure CSS animation. Its duration is the cadence and
 *     its negative delay is the time already elapsed, so it resumes mid-way on
 *     mount/interval change without a per-frame timer.
 *   - Only the numeric label uses a 1s tick, and only in Interval mode, and the
 *     state lives INSIDE this small leaf component — CORE's render tree is
 *     unaffected.
 *   - In Smart mode no countdown is faked: the bar switches to an honest
 *     indeterminate pulse with "Waiting for new context".
 *
 * State comes from the store (shared with STUDIO and both AutoForge loops) —
 * no CORE-only copy of anything.
 */

import { useEffect, useState } from "react";
import { Activity, Clock, Sparkles, Zap } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { useNowTick } from "../hooks/useNowTick";
import { useAutoCheckCountdownTicks } from "../hooks/useAutoCheckCountdownTicks";
import { useIsMobile } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import {
  AUTO_CHECK_INTERVAL_OPTIONS,
  customAutoCheckMinutesToMs,
  computeAutoCheckWindow,
  describeAutoCheckStatus,
  formatAutoCheckInterval,
  normalizeAutoCheckMode,
  resolveAutoCheckFloorMs,
  normalizeCustomAutoCheckMinutes,
} from "../lib/coreAutoCheck";
import { playSfx } from "../lib/sfx";

export interface AutoCheckControlsProps {
  /** "compact" = mobile CORE (tight single row + thin bar).
   *  "full" = desktop CORE (labelled selector grid). */
  variant?: "compact" | "full";
  className?: string;
}

export function AutoCheckControls({ variant = "full", className }: AutoCheckControlsProps) {
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const autoCheckEnabled = useAppStore((s) => s.autoForgeAutoCheckEnabled);
  const setAutoCheckEnabled = useAppStore((s) => s.setAutoForgeAutoCheckEnabled);
  const mode = useAppStore((s) => s.autoForgeAutoCheckMode);
  const intervalMs = useAppStore((s) => s.autoForgeAutoCheckIntervalMs);
  const setCadence = useAppStore((s) => s.setAutoForgeAutoCheckCadence);
  const lastCheckMs = useAppStore((s) => s.autoForgeLastCheckMs);
  const armed = useAppStore((s) => s.autoForgeCheckArmed);
  const checking = useAppStore((s) => s.isAutoForgeThinking);
  // In Interval mode this timestamp is the authoritative user-owned attempt
  // deadline. Smart mode continues to use it for contextual/model pacing.
  const nextActionMs = useAppStore((s) => s.autoForgeNextActionMs);
  const channel = useAppStore((s) => s.streamMetadata.channelName);
  const connection = useAppStore((s) => s.tmiReadState);

  const normalizedMode = normalizeAutoCheckMode(mode);
  const isInterval = normalizedMode === "interval";
  const floorMs = resolveAutoCheckFloorMs(normalizedMode, intervalMs);
  const isMobile = useIsMobile();
  // Timestamp of the last mode change that pulled NEXT CHECK forward —
  // drives the subtle shortened-countdown flash below.
  const timerShortenedAt = useAppStore((s) => s.autoForgeTimerShortenedAtMs);
  const [shortenPulse, setShortenPulse] = useState(false);

  // Shared app clock — subscribed only while a real countdown is on screen.
  const now = useNowTick(isInterval && autoCheckEnabled && autoForgeEnabled);

  const window = computeAutoCheckWindow({
    mode: normalizedMode,
    intervalMs,
    lastCheckAt: lastCheckMs,
    now,
    nextActionMs,
  });

  const status = describeAutoCheckStatus({
    mode: normalizedMode,
    checking,
    armed,
    dueInMs: isInterval ? window.dueInMs : null,
    paused: !autoCheckEnabled,
  });

  const idle = !autoCheckEnabled || !autoForgeEnabled;

  // Mobile-only soft 3→2→1 ticks. The scheduled attempt's due timestamp is
  // the attempt identity — dedupe/pause/supersede semantics live in
  // lib/autoCheckCountdown.ts. Smart mode has no honest countdown → no ticks.
  useAutoCheckCountdownTicks({
    enabled: isMobile && !idle && isInterval && !!channel.trim() && connection === "connected",
    dueAtMs: isInterval && !idle ? window.dueAtMs : null,
    now,
  });

  // Brief emphasis when a cadence change shortens the live countdown.
  useEffect(() => {
    if (!timerShortenedAt) return;
    setShortenPulse(true);
    const t = setTimeout(() => setShortenPulse(false), 550);
    return () => clearTimeout(t);
  }, [timerShortenedAt]);

  return (
    <div className={cn("space-y-2", className)}>
      {/* Header row — toggle */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-gray-300">
          <Clock className="w-3.5 h-3.5 text-orange-400" />
          Auto-Check
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={autoCheckEnabled}
          onClick={() => { setAutoCheckEnabled(!autoCheckEnabled); playSfx("setting_toggle"); }}
          className={cn(
            "px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider transition-all touch-target",
            autoCheckEnabled
              ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
              : "bg-white/5 border-white/10 text-gray-500"
          )}
        >
          {autoCheckEnabled ? "On" : "Paused"}
        </button>
      </div>
      {/* Mode + cadence selector, progress and status are added below */}
      <AutoCheckCadenceRow
        compact={variant === "compact"}
        mode={normalizedMode}
        intervalMs={intervalMs}
        onSelect={setCadence}
      />
      <AutoCheckProgressRow
        idle={idle}
        isInterval={isInterval}
        floorMs={floorMs}
        lastCheckMs={lastCheckMs}
        elapsedMs={window.elapsedMs}
        status={status}
        checking={checking}
        armed={armed}
        pulse={shortenPulse}
      />
    </div>
  );
}
// ─── Cadence selector ─────────────────────────────────────────────────────

function AutoCheckCadenceRow(props: {
  compact: boolean;
  mode: "smart" | "interval";
  intervalMs: number;
  onSelect: (mode: "smart" | "interval", intervalMs?: number) => void;
}) {
  const { compact, mode, intervalMs } = props;
  const smartActive = mode === "smart";
  const customActive = mode === "interval" && !AUTO_CHECK_INTERVAL_OPTIONS.includes(intervalMs);
  const [customMinutes, setCustomMinutes] = useState(() => String(normalizeCustomAutoCheckMinutes(intervalMs / 60_000)));
  useEffect(() => {
    if (customActive) setCustomMinutes(String(normalizeCustomAutoCheckMinutes(intervalMs / 60_000)));
  }, [customActive, intervalMs]);
  const commitCustom = () => {
    if (!/^\d+$/.test(customMinutes)) {
      setCustomMinutes(String(normalizeCustomAutoCheckMinutes(intervalMs / 60_000)));
      toast.error("Enter a whole number from 1 to 99 minutes");
      return;
    }
    const raw = Number(customMinutes);
    const minutes = normalizeCustomAutoCheckMinutes(customMinutes);
    setCustomMinutes(String(minutes));
    if (raw !== minutes) toast.info(`Custom Auto-Check clamped to ${minutes} minute${minutes === 1 ? "" : "s"}`);
    props.onSelect("interval", customAutoCheckMinutesToMs(minutes));
    playSfx("select_change");
  };
  return (
    <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Auto-Check cadence">
      <button
        type="button"
        role="radio"
        aria-checked={smartActive}
        onClick={() => { props.onSelect("smart"); playSfx("select_change"); }}
        title="Smart — evaluate only when the context actually changes"
        className={cn(
          "rounded-lg border font-bold uppercase flex items-center justify-center gap-1 transition-all touch-target",
          compact ? "py-1 text-[9px]" : "py-1.5 text-[10px]",
          smartActive
            ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-200"
            : "bg-black/30 border-white/5 text-gray-500 hover:text-gray-300"
        )}
      >
        <Sparkles className="w-3 h-3" />
        Smart
      </button>
      {AUTO_CHECK_INTERVAL_OPTIONS.map((option) => {
        const active = mode === "interval" && intervalMs === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => { props.onSelect("interval", option); playSfx("select_change"); }}
            title={`Run an AutoCheck attempt every ${formatAutoCheckInterval(option)}`}
            className={cn(
              "rounded-lg border font-bold uppercase transition-all touch-target",
              compact ? "py-1 text-[9px]" : "py-1.5 text-[10px]",
              active
                ? "bg-orange-500/20 border-orange-500/50 text-orange-200"
                : "bg-black/30 border-white/5 text-gray-500 hover:text-gray-300"
            )}
          >
            {formatAutoCheckInterval(option)}
          </button>
        );
      })}
      {customActive ? (
        <label className={cn(
          "rounded-lg border border-orange-500/50 bg-orange-500/20 text-orange-100 font-bold uppercase flex items-center justify-center gap-0.5 touch-target",
          compact ? "py-1 text-[9px]" : "py-1.5 text-[10px]",
        )} title="Custom interval: 1–99 whole minutes">
          <input
            aria-label="Custom Auto-Check minutes"
            inputMode="numeric"
            pattern="[0-9]*"
            value={customMinutes}
            onChange={(event) => setCustomMinutes(event.target.value.slice(0, 3))}
            onBlur={commitCustom}
              // Blur owns the commit — Enter only blurs. Committing here AND
              // via the resulting blur would run the scheduler write, toast
              // and selection SFX twice.
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            }}
            className="w-6 bg-transparent text-right outline-none"
          />
          M
        </label>
      ) : (
        <button
          type="button"
          role="radio"
          aria-checked={false}
          onClick={() => {
            const minutes = 5;
            setCustomMinutes(String(minutes));
            props.onSelect("interval", customAutoCheckMinutesToMs(minutes));
            playSfx("select_change");
          }}
          title="Set a custom interval from 1 to 99 minutes"
          className={cn(
            "rounded-lg border font-bold uppercase transition-all touch-target bg-black/30 border-white/5 text-gray-500 hover:text-gray-300",
            compact ? "py-1 text-[9px]" : "py-1.5 text-[10px]",
          )}
        >Custom</button>
      )}
    </div>
  );
}

// ── Progress + honest status ─────────────────────────────────────────────

function AutoCheckProgressRow(props: {
  idle: boolean;
  isInterval: boolean;
  floorMs: number;
  lastCheckMs: number;
  elapsedMs: number;
  status: string;
  checking: boolean;
  armed: boolean;
  /** True for ~0.5s after a cadence change pulled NEXT CHECK forward. */
  pulse?: boolean;
}) {
  const { idle, isInterval, floorMs, lastCheckMs, elapsedMs, status, checking, armed, pulse } = props;
  return (
    <div className="space-y-1">
      <div className="h-1.5 rounded-full bg-black/50 border border-white/5 overflow-hidden">
        {idle ? (
          <div className="h-full w-0" />
        ) : isInterval ? (
          /* Keyed on the last check so the CSS animation restarts cleanly after
             a check, and the negative delay resumes it in place after any
             re-render. No per-frame JS involved. */
          <div
            key={`${lastCheckMs}-${floorMs}`}
            className="auto-check-fill h-full w-full bg-gradient-to-r from-orange-500 to-amber-400"
            style={{
              animationDuration: `${floorMs}ms`,
              animationDelay: `-${Math.min(elapsedMs, floorMs)}ms`,
            }}
          />
        ) : (
          <div className="auto-check-smart h-full w-full bg-gradient-to-r from-cyan-500/50 via-cyan-400/80 to-cyan-500/50" />
        )}
      </div>

      <div className="flex items-center justify-between text-[10px] font-mono">
        <span
          className={cn(
            "flex items-center gap-1 min-w-0",
            idle ? "text-gray-600"
              : checking ? "text-cyan-300"
              : armed ? "text-amber-300"
              : "text-gray-400"
          )}
        >
          {checking ? (
            <Activity className="w-3 h-3 animate-pulse shrink-0" />
          ) : (
            <Zap className="w-3 h-3 shrink-0 opacity-60" />
          )}
          <span className={cn("truncate", pulse && "auto-check-shortened")}>{status}</span>
        </span>
        {!idle && isInterval && (
          <span className="text-gray-500 shrink-0">{formatAutoCheckInterval(floorMs)}</span>
        )}
      </div>
    </div>
  );
}
