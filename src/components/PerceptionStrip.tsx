/**
 * PerceptionStrip — the compact presentation of the canonical Perception
 * Liveness layer (src/lib/perceptionLiveness.ts).
 *
 * Answers "can MADchatter currently see/hear/read the room?" in one glance:
 *   💬 CHAT   LIVE   1s
 *   🎙 AUDIO  LIVE   3s
 *   👁 VISION STALE  48s
 *   ⚡ EVENTS QUIET   —
 *
 * Pure consumer: every status/age/reason comes from the shared store mirror
 * (flushed by usePerceptionLiveness). This component owns presentation only.
 *
 * Variants (same contract, different density):
 * - core:    one compact lane row (lane · status · freshness)
 * - compact: mobile — minimal dots + labels, expandable detail sheet
 * - studio:  full pipeline-stage diagnostics (capture vs processing vs
 *            output), reason codes, and recovery hints
 *
 * Accessibility: state is always text + color, never color alone. The strip
 * is marked aria-live="polite" so status changes are announced without
 * stealing focus.
 */

import { useState } from "react";
import { ChevronDown, Eye, MessageSquare, Mic, Zap } from "lucide-react";
import { useAppStore } from "../store";
import { useNowTick } from "../hooks/useNowTick";
import {
  PERCEPTION_REASON_LABELS,
  PERCEPTION_RECOVERY_HINTS,
  perceptionAgeLabel,
  perceptionStatusLabel,
  type PerceptionLiveness,
  type PerceptionLane,
  type PerceptionStatus,
} from "../lib/perceptionLiveness";
import { cn } from "../lib/utils";

export type PerceptionStripVariant = "core" | "compact" | "studio";

const LANE_META: Record<PerceptionLane, { label: string; icon: typeof Zap }> = {
  chat: { label: "Chat", icon: MessageSquare },
  audio: { label: "Audio", icon: Mic },
  vision: { label: "Vision", icon: Eye },
  platform_events: { label: "Events", icon: Zap },
};

const LANE_ORDER: PerceptionLane[] = ["chat", "audio", "vision", "platform_events"];

const STAGE_LABELS: Record<string, string> = {
  capture: "Capture",
  energy: "Energy",
  transcription: "Transcription",
  semantic: "Analysis",
  model: "Model",
  transport: "Transport",
};

function statusTextClass(status: PerceptionStatus): string {
  switch (status) {
    case "live": return "text-emerald-400";
    case "quiet": return "text-gray-500";
    case "stale":
    case "degraded": return "text-amber-400";
    case "error": return "text-red-400";
    case "initializing": return "text-cyan-400 animate-pulse";
    default: return "text-gray-600"; // disabled / unavailable
  }
}

function statusDotClass(status: PerceptionStatus): string {
  switch (status) {
    case "live": return "bg-emerald-400";
    case "quiet": return "bg-gray-500";
    case "stale":
    case "degraded": return "bg-amber-400";
    case "error": return "bg-red-400";
    case "initializing": return "bg-cyan-400 animate-pulse";
    default: return "bg-gray-700";
  }
}

function laneFreshness(lane: PerceptionLiveness): string {
  if (lane.status === "live" || lane.status === "quiet") {
    return lane.ageMs != null ? perceptionAgeLabel(lane.ageMs) : "—";
  }
  return "—";
}

function laneTooltip(lane: PerceptionLiveness): string {
  const reason = lane.reasonCode ? PERCEPTION_REASON_LABELS[lane.reasonCode] ?? lane.reasonCode : null;
  const recovery = lane.reasonCode ? PERCEPTION_RECOVERY_HINTS[lane.reasonCode] : null;
  const age = lane.ageMs != null ? ` — last valid output ${perceptionAgeLabel(lane.ageMs)} ago` : "";
  return [
    `${LANE_META[lane.lane].label}: ${perceptionStatusLabel(lane.status)}`,
    reason,
    recovery,
    lane.error?.code,
  ].filter(Boolean).join(" · ") + age;
}

// ─── Studio stage table (diagnostic density) ──────────────────────────────────

function StageTable({ lane }: { lane: PerceptionLiveness }) {
  if (!lane.stages) return null;
  return (
    <div className="space-y-0.5 pl-4 border-l border-white/5">
      {Object.entries(lane.stages).map(([stage, s]) => (
        <div key={stage} className="flex items-center justify-between gap-2 font-mono text-[9px]">
          <span className="text-gray-600">{STAGE_LABELS[stage] ?? stage}</span>
          <span className={cn(statusTextClass(s.status))}>
            {perceptionStatusLabel(s.status)}
            {s.detail ? <span className="text-gray-600"> · {s.detail}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── The strip ─────────────────────────────────────────────────────────────────

export function PerceptionStrip({ variant = "core" }: { variant?: PerceptionStripVariant }) {
  const summary = useAppStore((s) => s.perceptionSummary);
  const [open, setOpen] = useState(false);
  // Age labels refresh from the shared app clock (hooks/useNowTick). This only
  // re-renders this leaf component — never the whole app (§35/§73). The summary
  // itself is signature-deduped by the wiring hook; this only recomputes
  // display strings.
  useNowTick();

  if (!summary) return null;
  const lanes = LANE_ORDER.map((l) => summary.lanes[l]).filter(Boolean);
  if (lanes.length === 0) return null;

  // Mobile: minimal dots + textual labels, expandable detail sheet.
  if (variant === "compact") {
    return (
      <div data-section="perception-strip" className="space-y-1">
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          aria-expanded={open}
          aria-label={`Perception: ${lanes.map((l) => `${LANE_META[l.lane].label} ${perceptionStatusLabel(l.status)}`).join(", ")}`}
          className="w-full flex items-center justify-between gap-1 px-2 py-1 rounded-md bg-white/[0.02] border border-white/5"
        >
          <span className="flex items-center gap-2 min-w-0">
            {lanes.map((l) => (
              <span key={l.lane} className="flex items-center gap-0.5" title={laneTooltip(l)}>
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", statusDotClass(l.status))} aria-hidden="true" />
                <span className={cn("text-[10px] font-mono", statusTextClass(l.status))}>
                  {perceptionStatusLabel(l.status)}
                </span>
                <span className="sr-only">{`${LANE_META[l.lane].label} is ${perceptionStatusLabel(l.status)}`}</span>
              </span>
            ))}
          </span>
          <ChevronDown className={cn("w-3 h-3 text-gray-500 transition-transform shrink-0", open && "rotate-180")} aria-hidden="true" />
        </button>
        {open && (
          <div className="space-y-1 px-2 py-1.5 rounded-md bg-white/[0.02] border border-white/5">
            {lanes.map((l) => (
              <div key={l.lane} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-[11px] text-gray-300">
                  {(() => { const Icon = LANE_META[l.lane].icon; return <Icon className="w-3 h-3 text-gray-500" aria-hidden="true" />; })()}
                  {LANE_META[l.lane].label}
                </span>
                <span className={cn("text-[10px] font-mono", statusTextClass(l.status))}>
                  {perceptionStatusLabel(l.status)}
                  {laneFreshness(l) !== "—" && <span className="text-gray-600"> {laneFreshness(l)}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Core + Studio: one compact row; Studio adds stage diagnostics + reasons.
  // In Studio the header row is a toggle — the detail block below it is
  // collapsed by default and expands on click (the compact summary row is
  // always visible so a glance still answers "are the sensors live?").
  const studioCollapsible = variant === "studio";
  return (
    <div
      data-section="perception-strip"
      aria-live="polite"
      aria-label="Perception — sensor freshness"
      className={cn(
        "flex flex-col gap-1",
        studioCollapsible && "pt-1 border-t border-white/5",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-0.5",
          studioCollapsible && "cursor-pointer select-none hover:bg-white/[0.02] rounded -mx-1 px-1 py-0.5 transition-colors",
        )}
        onClick={studioCollapsible ? () => setOpen((x) => !x) : undefined}
        role={studioCollapsible ? "button" : undefined}
        tabIndex={studioCollapsible ? 0 : undefined}
        aria-expanded={studioCollapsible ? open : undefined}
        onKeyDown={studioCollapsible ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((x) => !x); }
        } : undefined}
      >
        <span className="text-[9px] uppercase tracking-widest text-gray-500 shrink-0 flex items-center gap-1">
          {studioCollapsible && <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} aria-hidden="true" />}
          Perception
        </span>
        {lanes.map((l) => {
          const Icon = LANE_META[l.lane].icon;
          return (
            <span
              key={l.lane}
              title={laneTooltip(l)}
              className="inline-flex items-center gap-1 font-mono text-[10px]"
            >
              <Icon className="w-3 h-3 text-gray-500 shrink-0" aria-hidden="true" />
              <span className="text-gray-500">{LANE_META[l.lane].label.toUpperCase()}</span>
              <span className={statusTextClass(l.status)}>{perceptionStatusLabel(l.status)}</span>
              <span className="text-gray-600">{laneFreshness(l)}</span>
              <span className="sr-only">{` — ${LANE_META[l.lane].label} is ${perceptionStatusLabel(l.status)}`}</span>
            </span>
          );
        })}
      </div>
      {studioCollapsible && open && (
        <div className="space-y-1">
          {lanes.map((l) => {
            const reason = l.reasonCode ? PERCEPTION_REASON_LABELS[l.reasonCode] ?? l.reasonCode : null;
            const recovery = l.reasonCode ? PERCEPTION_RECOVERY_HINTS[l.reasonCode] : null;
            return (
              <div key={l.lane} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                  <span className="text-gray-500">{LANE_META[l.lane].label}</span>
                  <span className={statusTextClass(l.status)}>
                    {perceptionStatusLabel(l.status)}
                    {reason && <span className="text-gray-600"> · {reason}</span>}
                    {l.ageMs != null && (l.status === "live" || l.status === "quiet") && (
                      <span className="text-gray-600"> · {perceptionAgeLabel(l.ageMs)}</span>
                    )}
                  </span>
                </div>
                <StageTable lane={l} />
                {recovery && (l.status === "error" || l.status === "degraded" || l.status === "stale") && (
                  <p className="pl-4 text-[9px] text-gray-500 italic">{recovery}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
