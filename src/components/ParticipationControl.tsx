import { useId, useState } from "react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { ChevronDown, Ear, OctagonX, Play, ShieldAlert } from "lucide-react";
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
 *   - full (STUDIO AutoForgeHUD): collapsible details; status + stop stay visible
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
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const detailsId = `${id}-participation-details`;
  const statusId = `${id}-participation-status`;
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
        "min-h-11 min-w-11 shrink-0 flex items-center justify-center rounded-lg font-bold uppercase tracking-wider focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300",
        compact ? "text-[8px]" : "text-[9px]",
      )}
    >
      <span className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-1 transition-colors",
        globalStop
          ? "bg-red-500/25 text-red-300 border border-red-500/50 hover:bg-red-500/35"
          : "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20",
      )}>
        {globalStop ? <Play aria-hidden="true" className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} /> : <OctagonX aria-hidden="true" className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />}
        {globalStop ? "Resume" : "Stop All"}
      </span>
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
    <div className={cn("overflow-hidden rounded-xl border", globalStop ? "border-red-400/25 bg-red-400/[0.035]" : "border-teal-400/15 bg-teal-400/[0.025]")}>
      <div className="flex items-center gap-1 px-2 py-0.5">
        <button type="button" aria-label="Participation details" aria-expanded={expanded}
          aria-controls={detailsId} aria-describedby={statusId} onClick={() => setExpanded(open => !open)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300">
          <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", globalStop ? "bg-red-400/10 text-red-300" : cn("bg-teal-400/10", display.tone))}>
            <Ear className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-semibold text-gray-200">Participation</span>
            <span id={statusId} title={statusLabel} className={cn("block truncate text-[10px] leading-4", globalStop ? "text-red-300" : display.tone)}>{statusLabel}</span>
          </span>
          <ChevronDown aria-hidden="true" className={cn("mr-1 h-3 w-3 shrink-0 text-gray-500", expanded && "rotate-180")} />
        </button>
        {stopButton}
      </div>

      <div id={detailsId} hidden={!expanded} className="border-t border-white/[0.06] px-3 pb-2.5 pt-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", globalStop ? "bg-red-400" : display.dot)} />
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
                  "min-h-11 min-w-0 flex-1 px-1.5 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-colors border focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300",
                  manualMode === mode
                    ? "bg-teal-500/15 text-teal-300 border-teal-500/40"
                    : "bg-white/[0.03] text-gray-500 border-white/5 hover:text-gray-300",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">
            Direct mentions stay eligible; STOP, availability, and send limits still apply.
          </p>
          <button
            type="button"
            onClick={() => setAwarenessEnabled(!awarenessEnabled)}
            aria-pressed={awarenessEnabled}
            className={cn("min-h-11 flex items-center justify-between gap-2 rounded-lg border px-2 text-left text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300", awarenessEnabled ? "border-white/[0.07] text-gray-400" : "border-amber-400/20 text-amber-400")}
          >
            <span>{awarenessEnabled ? "Awareness on" : "Awareness off (manual modes still apply)"}</span>
            <span aria-hidden="true" className={cn("relative h-5 w-8 shrink-0 rounded-full", awarenessEnabled ? "bg-teal-400/20" : "bg-white/10")}>
              <span className={cn("absolute top-1 h-3 w-3 rounded-full", awarenessEnabled ? "right-1 bg-teal-300" : "left-1 bg-gray-500")} />
            </span>
          </button>
          {manualMode !== "auto" && (
            <span className="flex items-center gap-1 mt-0.5 text-[10px] text-amber-400/80">
              <ShieldAlert className="w-2.5 h-2.5" /> Manual override active
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
