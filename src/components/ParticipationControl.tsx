import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { Ear, OctagonX, Play, ShieldAlert } from "lucide-react";
import { PARTICIPATION_REASON_LABELS, type ParticipationState } from "../lib/participationAwareness";

/**
 * Participation control — the ONE surface for annoyance awareness.
 *
 * Philosophy: surface outcome, not machinery. Users see what state the
 * ensemble is in, one calm line about why, and how to override. Restraint
 * reads as intelligence (Listening / Cooling down), never as breakage, and
 * deliberate silence is never celebrated — it's just stated.
 *
 * Two densities over one component:
 *   - full (STUDIO AutoForgeHUD): status + reasons + mode selector + stop
 *   - compact (CORE PreviousCycleDecisionPanel): status line + stop button
 */

const STATE_DISPLAY: Record<ParticipationState, { label: string; hint: string; tone: string; dot: string }> = {
  open: { label: "Participating", hint: "Normal participation", tone: "text-emerald-400", dot: "bg-emerald-400" },
  measured: { label: "Measured", hint: "Raising the bar for optional sends", tone: "text-cyan-400", dot: "bg-cyan-400" },
  quiet: { label: "Listening", hint: "Giving the room space", tone: "text-teal-400", dot: "bg-teal-400" },
  cooldown: { label: "Cooling down", hint: "Bots were very active — dialing back", tone: "text-amber-400", dot: "bg-amber-400" },
  direct_only: { label: "Direct replies only", hint: "Only responding when addressed", tone: "text-violet-400", dot: "bg-violet-400" },
};

export function ParticipationControl({ compact = false }: { compact?: boolean }) {
  const snapshot = useAppStore((s) => s.participationSnapshot);
  const manualMode = useAppStore((s) => s.participationManualMode);
  const setManualMode = useAppStore((s) => s.setParticipationManualMode);
  const awarenessEnabled = useAppStore((s) => s.participationAwarenessEnabled);
  const setAwarenessEnabled = useAppStore((s) => s.setParticipationAwarenessEnabled);
  const globalStop = useAppStore((s) => s.botsGlobalStop);
  const setGlobalStop = useAppStore((s) => s.setBotsGlobalStop);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);

  // Effective state: manual mode wins over the inferred snapshot; the global
  // stop is displayed above everything.
  const effectiveState: ParticipationState =
    manualMode === "quiet" ? "quiet"
    : manualMode === "direct_only" ? "direct_only"
    : snapshot?.state ?? "open";
  const source = manualMode !== "auto" ? "manual" : snapshot?.source ?? "inferred";
  const display = STATE_DISPLAY[effectiveState];

  const reasons = (snapshot?.reasonCodes ?? [])
    .slice(0, compact ? 1 : 3)
    .map((c) => PARTICIPATION_REASON_LABELS[c]);
  const statusLabel = globalStop ? "Automated sends stopped"
    : !autoForgeEnabled ? "AutoForge off"
    : !awarenessEnabled && manualMode === "auto" && !snapshot?.explicitQuietUntil
      ? "Awareness off" : display.label;

  const stopButton = (
    <button
      type="button"
      onClick={() => {
        setGlobalStop(!globalStop);
        playSfx(globalStop ? "panel_collapse" : "mention_alert");
      }}
      aria-pressed={globalStop}
      aria-label={globalStop ? "Resume automated bot sends" : "Stop all automated bot sends"}
      className={cn(
        "shrink-0 flex items-center gap-1 rounded font-bold uppercase tracking-wider transition-colors",
        compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-1 text-[9px]",
        globalStop
          ? "bg-red-500/25 text-red-300 border border-red-500/50 hover:bg-red-500/35"
          : "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20",
      )}
    >
      {globalStop ? <Play className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} /> : <OctagonX className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />}
      {globalStop ? "Resume" : "Stop All"}
    </button>
  );

  if (compact) {
    return (
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 bg-white/[0.03] rounded border border-white/5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Ear className={cn("w-3 h-3 shrink-0", globalStop ? "text-red-400" : display.tone)} />
          <span className={cn("text-[9px] font-bold uppercase tracking-wider truncate", globalStop ? "text-red-400" : display.tone)}>
            {statusLabel}
          </span>
          {reasons.length > 0 && !globalStop && (
            <span className="text-[9px] text-gray-500 truncate hidden sm:inline">— {reasons[0]}</span>
          )}
        </div>
        {stopButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2.5 bg-black/40 rounded border border-white/5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
          <Ear className="w-3 h-3 text-teal-400" /> Participation
        </span>
        {stopButton}
      </div>

      <div className="flex items-center gap-2">
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", globalStop ? "bg-red-400 animate-pulse" : cn(display.dot, "animate-pulse"))} />
        <div className="flex flex-col min-w-0">
          <span className={cn("text-[11px] font-bold", globalStop ? "text-red-400" : display.tone)}>
            {statusLabel}
          </span>
          <span className="text-[9px] text-gray-500">
            {globalStop ? "Manual chat input still works" : display.hint}
          </span>
        </div>
      </div>

      {reasons.length > 0 && !globalStop && (
        <div className="flex flex-col gap-0.5 pl-3.5 border-l border-white/5">
          {reasons.map((r) => (
            <span key={r} className="text-[9px] text-gray-400">{r}</span>
          ))}
          {snapshot && (
            <span className="text-[8px] text-gray-600 font-mono">
              risk {snapshot.risk.overall.toFixed(2)} · conf {snapshot.risk.confidence.toFixed(2)} · {source}
            </span>
          )}
        </div>
      )}

      {/* Mode selector — the ordinary-user control surface (no algorithm knobs) */}
      <div className="flex gap-1">
        {([
          ["auto", "Auto"],
          ["quiet", "Quiet"],
          ["direct_only", "Direct only"],
        ] as const).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => { setManualMode(mode); playSfx("panel_collapse"); }}
            aria-pressed={manualMode === mode}
            className={cn(
              "flex-1 px-1.5 py-1 rounded text-[9px] font-bold uppercase tracking-wider transition-colors border",
              manualMode === mode
                ? "bg-teal-500/15 text-teal-300 border-teal-500/40"
                : "bg-white/[0.03] text-gray-500 border-white/5 hover:text-gray-300",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-[8px] text-gray-600 leading-relaxed">
        Direct mentions stay eligible; STOP, availability, and send limits still apply.{" "}
        <button
          type="button"
          onClick={() => setAwarenessEnabled(!awarenessEnabled)}
          aria-pressed={awarenessEnabled}
          className={cn("underline underline-offset-1", awarenessEnabled ? "text-gray-400" : "text-amber-400")}
        >
          {awarenessEnabled ? "Awareness on" : "Awareness off (manual modes still apply)"}
        </button>
        {manualMode !== "auto" && (
          <span className="flex items-center gap-1 mt-0.5 text-amber-400/80">
            <ShieldAlert className="w-2.5 h-2.5" /> Manual override active
          </span>
        )}
      </p>
    </div>
  );
}
