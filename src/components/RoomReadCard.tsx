/**
 * RoomReadCard — the primary perception surface connecting MADchatter's
 * situational awareness to the human operating it.
 *
 * Answers "what is happening right now?" in one sentence, backed by
 * inspectable evidence. Pure consumer: all semantics come from the shared
 * RoomReadState (useRoomRead → deriveRoomRead over the Room Model mirror).
 * This component owns presentation only — never signal computation.
 *
 * Variants (same contract, different density):
 * - core:    headline + 3-5 signal chips + freshness/confidence + Why? panel
 * - compact: mobile — headline + chips + updated line, details via accordion
 * - studio:  core + significance/confidence meters + perception lane table
 */

import { useState, useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  AtSign,
  Bot,
  ChevronDown,
  Clock,
  Eye,
  Gift,
  MessageSquare,
  MessagesSquare,
  Mic,
  Radio,
  Smile,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store";
import { useRoomRead } from "../hooks/useRoomRead";
import { PerceptionStrip } from "./PerceptionStrip";
import { deterministicMomentTitle, type RoomMoment } from "../lib/roomModel";
import type { RoomReadChip, RoomReadLaneInfo, RoomReadState } from "../lib/roomRead";
import { cn } from "../lib/utils";

export type RoomReadVariant = "core" | "compact" | "studio";

// ─── Chip presentation ────────────────────────────────────────────────────────

const CHIP_ICONS: Record<RoomReadChip["kind"], typeof Zap> = {
  activity: Zap,
  mood: Smile,
  streamer: Mic,
  threads: MessagesSquare,
  vision: Eye,
  platform: Gift,
  callout: AtSign,
  bots: Bot,
  stale: AlertTriangle,
};

function chipClass(emphasis: RoomReadChip["emphasis"], kind: RoomReadChip["kind"]): string {
  if (kind === "callout") return "text-amber-300 bg-amber-400/10 border-amber-400/20";
  if (kind === "stale") return "text-amber-400/80 bg-amber-400/5 border-amber-400/10";
  switch (emphasis) {
    case "high":
      return "text-cyan-300 bg-cyan-400/10 border-cyan-400/20";
    case "dim":
      return "text-gray-500 bg-white/[0.02] border-white/5";
    default:
      return "text-gray-300 bg-white/[0.03] border-white/10";
  }
}

// ─── Status / band presentation ────────────────────────────────────────────────

function statusDot(read: RoomReadState): { className: string; label: string } {
  switch (read.status) {
    case "ready":
      return { className: "bg-emerald-400", label: "Live" };
    case "partial":
      return { className: "bg-amber-400", label: "Partial" };
    case "quiet":
      return { className: "bg-gray-500", label: "Quiet" };
    case "stale":
      return { className: "bg-amber-400", label: "Stale" };
    default:
      return { className: "bg-cyan-400 animate-pulse", label: "Reading" };
  }
}

function headlineClass(read: RoomReadState): string {
  switch (read.band) {
    case "high":
      return "text-[13px] font-semibold text-gray-100 leading-snug";
    case "medium":
      return "text-[13px] font-medium text-gray-200 leading-snug";
    default:
      return "text-[13px] text-gray-300 leading-snug";
  }
}

const BAND_LABELS: Record<RoomReadState["band"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ─── Lane table (Why? / Studio detail) ────────────────────────────────────────

const LANE_LABELS: Record<string, string> = {
  chat: "Chat",
  audio: "Audio",
  vision: "Vision",
  platform: "Events",
  transcript: "Speech",
};

function laneStatusText(status: string): string {
  switch (status) {
    case "live":
      return "LIVE";
    case "quiet":
      return "QUIET";
    case "stale":
      return "STALE";
    default:
      return "—";
  }
}

function LaneTable({ lanes }: { lanes: RoomReadLaneInfo[] }) {
  if (lanes.length === 0) return null;
  return (
    <div className="space-y-0.5" role="table" aria-label="Perception lane freshness">
      {(Object.keys(LANE_LABELS) as (keyof typeof LANE_LABELS)[]).map((lane) => {
        const info = lanes.find((l) => l.lane === lane);
        if (!info) return null;
        const stale = info.status === "stale";
        return (
          <div key={lane} role="row" className="flex items-center justify-between gap-2 font-mono text-[10px]">
            <span role="cell" className="text-gray-500">{LANE_LABELS[lane]}</span>
            <span
              role="cell"
              className={cn(
                info.status === "live" ? "text-emerald-400" : stale ? "text-amber-400" : "text-gray-600",
              )}
            >
              {laneStatusText(info.status)}
              {info.ageMs != null && info.status !== "unavailable" && (
                <span className="text-gray-600"> {ageLabel(info.ageMs)}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Why? evidence panel ───────────────────────────────────────────────────────

function WhyPanel({
  read,
  aiConfigured,
  showLanes,
}: {
  read: RoomReadState;
  aiConfigured: boolean;
  showLanes: boolean;
}) {
  return (
    <div className="space-y-2 pt-2 border-t border-white/5">
      <span className="text-[9px] uppercase tracking-widest text-gray-500">Why this read</span>
      {read.evidence.length === 0 && (
        <p className="text-[11px] text-gray-500 italic">Not enough context yet — MADchatter is still collecting evidence.</p>
      )}
      {read.evidence.map((group) => (
        <div key={group.source} className="space-y-0.5">
          <span className="text-[10px] font-semibold text-gray-400">{group.source}</span>
          {group.lines.map((line, i) => (
            <p key={i} className="text-[10px] text-gray-400 font-mono leading-snug truncate" title={line}>
              {line}
            </p>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-2 text-[10px] text-gray-500">
        <span>Confidence: <span className="font-mono">{BAND_LABELS[read.band]}</span></span>
        {read.momentId && <span className="font-mono text-gray-600">moment {read.momentId.slice(0, 14)}</span>}
      </div>
      {showLanes && <LaneTable lanes={read.lanes} />}
      {!aiConfigured && read.band === "low" && (
        <p className="text-[10px] text-gray-500 italic">
          Reading chat and events deterministically — connect an AI provider for richer interpretation.
        </p>
      )}
    </div>
  );
}

// ─── Moment timeline (collapsed history; the Room Read stays present-tense) ────

function momentKindIcon(kind: RoomMoment["kind"]): typeof Zap {
  switch (kind) {
    case "reaction":
      return Zap;
    case "conversation":
      return MessageSquare;
    case "stream_event":
      return Radio;
    case "visual_event":
      return Eye;
    case "energy_shift":
      return Activity;
    case "quiet":
      return Clock;
    default:
      return Smile;
  }
}

function durationLabel(moment: RoomMoment): string {
  const end = moment.endedAt ?? moment.updatedAt;
  const s = Math.max(1, Math.round((end - moment.startedAt) / 1000));
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

function MomentRow({ moment, now }: { moment: RoomMoment; now: number }) {
  const [open, setOpen] = useState(false);
  const Icon = momentKindIcon(moment.kind);
  const s = moment.signals;
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03] transition-colors"
        aria-expanded={open}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-gray-400" />
        <span className="flex-1 min-w-0 truncate text-[11px] text-gray-200">
          {moment.title ?? deterministicMomentTitle(moment)}
        </span>
        <span className="text-[9px] font-mono text-gray-500 shrink-0">
          {moment.status === "active" ? "live" : ageLabel(now - (moment.endedAt ?? moment.updatedAt))}
        </span>
        <ChevronDown className={cn("w-3 h-3 text-gray-500 transition-transform shrink-0", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0.5 space-y-1.5 border-t border-white/5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-[9px] text-gray-500 font-mono">
            <span>{moment.kind} · {durationLabel(moment)}</span>
            <span>sig {moment.significance.toFixed(2)} · conf {moment.confidence.toFixed(2)}</span>
            {moment.provenance.aiSynthesized ? <span>AI-named</span> : <span>deterministic</span>}
          </div>
          {moment.summary && <p className="text-[10px] text-gray-300 leading-snug">{moment.summary}</p>}
          {moment.topicHints && moment.topicHints.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {moment.topicHints.map((h) => (
                <span key={h} className="px-1.5 py-0.5 rounded text-[9px] bg-white/5 text-gray-400">#{h}</span>
              ))}
            </div>
          )}
          {moment.evidenceLines.length > 0 && (
            <div className="space-y-0.5">
              <span className="text-[9px] uppercase tracking-wide text-gray-500">Evidence</span>
              {moment.evidenceLines.map((line, i) => (
                <p key={i} className="text-[10px] text-gray-400 font-mono truncate" title={line}>{line}</p>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-gray-500">
            {s.chatActivity && (
              <span>chat: {s.chatActivity.level}{s.chatActivity.humanMessages ? ` (${s.chatActivity.humanMessages} human)` : ""}</span>
            )}
            {s.sentiment?.current && <span>sentiment: {s.sentiment.current}</span>}
            {s.audio?.energy && <span>audio: {s.audio.energy}</span>}
            {s.vision?.tags?.length ? <span>visual: {s.vision.tags.slice(0, 2).join(", ")}</span> : null}
            {s.conversation?.activeThreads ? <span>threads: {s.conversation.activeThreads}</span> : null}
            {s.agentActivity?.sends ? <span>bot sends: {s.agentActivity.sends}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── The card ─────────────────────────────────────────────────────────────────

export function RoomReadCard({
  variant,
  compact = false,
}: {
  variant?: RoomReadVariant;
  compact?: boolean;
}) {
  const { read, aiConfigured } = useRoomRead();
  const roomMoments = useAppStore((s) => s.roomMoments);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const [whyOpen, setWhyOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [compactExpanded, setCompactExpanded] = useState(false);

  const v: RoomReadVariant = variant ?? (compact ? "compact" : "core");

  const now = useMemo(() => Date.now(), [read]);

  if (!read) return null;

  const dot = statusDot(read);
  const updatedAgeMs = now - read.updatedAt;
  const activeMoment = read.momentId ? roomMoments.find((m) => m.id === read.momentId) ?? null : null;
  const recentMoments = roomMoments
    .filter((m) => m.status === "closed" && m.id !== read.momentId)
    .slice(-5)
    .reverse();
  const chips = v === "compact" ? read.chips.slice(0, 3) : read.chips;

  if (v === "compact" && !compactExpanded) {
    return (
      <div data-section="room-read" className="mx-auto w-full max-w-5xl">
        <section aria-live="polite" aria-label="Room read — collapsed" className={cn(
          "rounded-lg border bg-white/[0.03]",
          read.status === "stale" ? "border-amber-400/20" : "border-white/10",
        )}>
          <button
            type="button"
            onClick={() => setCompactExpanded(true)}
            aria-expanded={false}
            aria-label={`Expand Room Read. ${read.headline}`}
            className="mobile-touch-compact flex h-8 w-full min-w-0 items-center gap-1.5 px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full motion-reduce:animate-none", dot.className)} aria-hidden="true" />
            <span className="shrink-0 text-[10px] font-bold tracking-widest text-gray-300">ROOM READ</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400">{read.headline}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />
          </button>
        </section>
      </div>
    );
  }

  return (
    <div data-section="room-read" className={cn("max-w-5xl mx-auto w-full", v === "studio" && "max-w-none")}>
      <section
        aria-live="polite"
        aria-label="Room read — what MADchatter thinks is happening right now"
        className={cn(
          "rounded-lg border bg-white/[0.03] space-y-2",
          read.status === "stale" ? "border-amber-400/20" : "border-white/10",
          v === "compact" ? "p-2" : "p-2.5",
        )}
      >
        {/* Header: ROOM READ + status */}
        {v === "compact" ? (
          <button
            type="button"
            onClick={() => setCompactExpanded(false)}
            aria-expanded={true}
            aria-label="Collapse Room Read"
            className="mobile-touch-compact flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full motion-reduce:animate-none", dot.className)} aria-hidden="true" />
              <span className="text-[11px] font-bold tracking-widest text-gray-300">ROOM READ</span>
              <span className="font-mono text-[9px] text-gray-500">{dot.label}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 rotate-180 text-gray-500" aria-hidden="true" />
          </button>
        ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot.className)} aria-hidden="true" />
            <span className="text-[11px] font-bold tracking-widest text-gray-300">ROOM READ</span>
            <span className="text-[9px] font-mono text-gray-500">{dot.label}</span>
            {v === "studio" && activeMoment && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/20">
                {activeMoment.kind}
              </span>
            )}
          </div>
          {v === "studio" && activeMoment && (
            <span className="text-[9px] font-mono text-gray-500 shrink-0" title="Moment significance / confidence">
              sig {activeMoment.significance.toFixed(2)} · conf {activeMoment.confidence.toFixed(2)}
            </span>
          )}
        </div>
        )}

        {/* Layer 1 — The Read */}
        <p className={cn(headlineClass(read), "transition-opacity duration-300")} title={read.headline}>
          {read.headline}
        </p>

        {/* Layer 2 — Room signals */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {chips.map((chip, i) => {
              const Icon = CHIP_ICONS[chip.kind];
              return (
                <span
                  key={`${chip.kind}-${i}`}
                  className={cn(
                    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium",
                    chipClass(chip.emphasis, chip.kind),
                  )}
                >
                  <Icon className="w-3 h-3" aria-hidden="true" />
                  {chip.label}
                </span>
              );
            })}
          </div>
        )}

        {/* Layer 2.5 — Perception liveness (canonical sensor truth) */}
        <PerceptionStrip variant={v} />

        {/* Layer 3 — Freshness / confidence */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] font-mono text-gray-500 truncate">
            Updated {updatedAgeMs < 3_000 ? "now" : `${ageLabel(updatedAgeMs)} ago`}
            {" · "}
            <span
              className={cn(
                read.band === "high" ? "text-emerald-400/80" : read.band === "medium" ? "text-gray-400" : "text-gray-600",
              )}
            >
              {BAND_LABELS[read.band]}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setWhyOpen((x) => !x)}
            aria-expanded={whyOpen}
            className="flex items-center gap-0.5 text-[9px] uppercase tracking-widest text-gray-500 hover:text-gray-300 transition-colors shrink-0"
          >
            Why?
            <ChevronDown className={cn("w-3 h-3 transition-transform", whyOpen && "rotate-180")} />
          </button>
        </div>

        {/* Layer 4 — Evidence (expandable) */}
        {whyOpen && <WhyPanel read={read} aiConfigured={aiConfigured} showLanes={v !== "compact"} />}

        {/* Layer 5 — Action bridge (contextual, single primary action) */}
        {!hasForgedOnce && read.status !== "observing" && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("forge-trigger"))}
            className="w-full h-7 flex items-center justify-center gap-1.5 rounded-md bg-cyan-500/15 border border-cyan-400/25 text-cyan-300 text-[10px] font-bold uppercase tracking-wider hover:bg-cyan-500/25 transition-colors"
          >
            <Zap className="w-3 h-3" aria-hidden="true" />
            Forge a reply to this
          </button>
        )}

        {/* Moment timeline (temporal history — collapsed by default) */}
        {v !== "compact" && (activeMoment || recentMoments.length > 0) && (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setTimelineOpen((x) => !x)}
              className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-gray-500 hover:text-gray-300 transition-colors"
              aria-expanded={timelineOpen}
            >
              <ChevronDown className={cn("w-3 h-3 transition-transform", timelineOpen && "rotate-180")} />
              Moment timeline ({recentMoments.length + (activeMoment ? 1 : 0)})
            </button>
            {timelineOpen && (
              <div className="space-y-1">
                {activeMoment && <MomentRow moment={activeMoment} now={now} />}
                {recentMoments.map((m) => (
                  <MomentRow key={m.id} moment={m} now={now} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Studio density: canonical Perception Liveness stages render inline
            via PerceptionStrip (variant="studio") — pipeline stages, reason
            codes, and recovery hints — superseding the plain lane table. */}
      </section>
    </div>
  );
}
