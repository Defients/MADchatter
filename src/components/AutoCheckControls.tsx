/**
 * AutoCheckControls — the single AutoForge Auto-Check cadence surface for CORE.
 *
 * Replaces the implicit "checks every 15 seconds" behavior with something the
 * user actually controls, and makes the next evaluation legible:
 *
 *   [ Auto-Check ON/OFF ]  [ Smart | 30s | 1m | 2m | 5m ]
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
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import {
  AUTO_CHECK_INTERVAL_OPTIONS,
  computeAutoCheckWindow,
  describeAutoCheckStatus,
  formatAutoCheckInterval,
  normalizeAutoCheckMode,
  resolveAutoCheckFloorMs,
} from "../lib/coreAutoCheck";

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

  const normalizedMode = normalizeAutoCheckMode(mode);
  const isInterval = normalizedMode === "interval";
  const floorMs = resolveAutoCheckFloorMs(normalizedMode, intervalMs);

  // Contained 1s tick — only ticks while a real countdown is being displayed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isInterval || !autoCheckEnabled || !autoForgeEnabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isInterval, autoCheckEnabled, autoForgeEnabled]);

  const window = computeAutoCheckWindow({
    mode: normalizedMode,
    intervalMs,
    lastCheckAt: lastCheckMs,
    now,
  });

  const status = describeAutoCheckStatus({
    mode: normalizedMode,
    checking,
    armed,
    dueInMs: isInterval ? window.dueInMs : null,
    paused: !autoCheckEnabled,
  });

  const idle = !autoCheckEnabled || !autoForgeEnabled;

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
          onClick={() => setAutoCheckEnabled(!autoCheckEnabled)}
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
  return (
    <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Auto-Check cadence">
      <button
        type="button"
        role="radio"
        aria-checked={smartActive}
        onClick={() => props.onSelect("smart")}
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
            onClick={() => props.onSelect("interval", option)}
            title={`Check at most once every ${formatAutoCheckInterval(option)}`}
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
}) {
  const { idle, isInterval, floorMs, lastCheckMs, elapsedMs, status, checking, armed } = props;
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
          <span className="truncate">{status}</span>
        </span>
        {!idle && isInterval && (
          <span className="text-gray-500 shrink-0">{formatAutoCheckInterval(floorMs)}</span>
        )}
      </div>
    </div>
  );
}