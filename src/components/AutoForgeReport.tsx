import React, { useState, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { generateAutoForgeBriefing } from "../lib/ai";
import { getActiveProvider } from "../lib/keys";
import { toast } from "sonner";
import { playSfx } from "../lib/sfx";
import { AutoForgeEvent, AutoForgeEventType } from "../types";
import { ThemedTooltip } from "./ui/tooltip";
import {
  X,
  ScrollText,
  Zap,
  AtSign,
  TrendingUp,
  VolumeX,
  AlertTriangle,
  Power,
  Send,
  Sparkles,
  Copy,
  Download,
  Trash2,
  Filter,
  Megaphone,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";

const EVENT_ICONS: Record<AutoForgeEventType, React.ReactNode> = {
  action_sent: <Send className="w-3.5 h-3.5" />,
  mention: <AtSign className="w-3.5 h-3.5" />,
  spike: <TrendingUp className="w-3.5 h-3.5" />,
  silence: <VolumeX className="w-3.5 h-3.5" />,
  error: <AlertTriangle className="w-3.5 h-3.5" />,
  enable_disable: <Power className="w-3.5 h-3.5" />,
  metadata_change: <Sparkles className="w-3.5 h-3.5" />,
  director_note: <Megaphone className="w-3.5 h-3.5" />,
  rule_fired: <Filter className="w-3.5 h-3.5" />,
};

const EVENT_COLORS: Record<AutoForgeEventType, string> = {
  action_sent: "text-green-400 bg-green-500/10 border-green-500/20",
  mention: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  spike: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
  silence: "text-gray-400 bg-gray-500/10 border-gray-500/20",
  error: "text-red-400 bg-red-500/10 border-red-500/20",
  enable_disable: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  metadata_change: "text-orange-400 bg-orange-500/10 border-orange-500/20",
  director_note: "text-purple-300 bg-purple-500/10 border-purple-500/20",
  rule_fired: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
};

const SEVERITY_DOT: Record<string, string> = {
  high: "bg-red-400",
  medium: "bg-yellow-400",
  low: "bg-gray-500",
};

const ALL_TYPES: AutoForgeEventType[] = [
  "action_sent",
  "mention",
  "spike",
  "silence",
  "error",
  "enable_disable",
  "metadata_change",
  "rule_fired",
];

function formatTimeAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s ago`;
  return `${secs}s ago`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 0) return `${hrs}h ${remMins}m`;
  return `${mins}m`;
}

export function AutoForgeReport() {
  const {
    isAutoForgeReportOpen,
    setIsAutoForgeReportOpen,
    autoForgeEventLog,
    clearAutoForgeEvents,
    streamMetadata,
    config,
    bots,
  } = useAppStore();

  const [now, setNow] = useState(Date.now());
  const [activeFilters, setActiveFilters] = useState<Set<AutoForgeEventType>>(new Set());
  const [severityFilter, setSeverityFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [briefing, setBriefing] = useState<string | null>(null);
  const [isGeneratingBriefing, setIsGeneratingBriefing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  React.useEffect(() => {
    if (!isAutoForgeReportOpen) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isAutoForgeReportOpen]);

  // Merge global autoForgeEventLog with per-bot runtime.autoForgeEvents so the
  // report shows multi-bot activity. Per-bot events go to bots[].runtime, not
  // the global log, so without this merge the report stays empty in multi-bot
  // mode.
  const allEvents = useMemo(() => {
    const global = autoForgeEventLog.map((e) => ({ ...e, botName: undefined as string | undefined }));
    const perBot = bots.flatMap((b) =>
      b.runtime.autoForgeEvents.map((e) => ({ ...e, botName: b.session?.username }))
    );
    return [...global, ...perBot].sort((a, b) => a.timestamp - b.timestamp);
  }, [autoForgeEventLog, bots]);

  const filteredEvents = useMemo(() => {
    return allEvents.filter((e) => {
      if (activeFilters.size > 0 && !activeFilters.has(e.type)) return false;
      if (severityFilter !== "all" && e.severity !== severityFilter) return false;
      return true;
    });
  }, [allEvents, activeFilters, severityFilter]);

  const stats = useMemo(() => {
    const actions = allEvents.filter((e) => e.type === "action_sent").length;
    const mentions = allEvents.filter((e) => e.type === "mention").length;
    const spikes = allEvents.filter((e) => e.type === "spike").length;
    const errors = allEvents.filter((e) => e.type === "error").length;
    const silences = allEvents.filter((e) => e.type === "silence").length;

    const first = allEvents[0]?.timestamp;
    const last = allEvents[allEvents.length - 1]?.timestamp;
    const span = first && last ? last - first : 0;

    return { actions, mentions, spikes, errors, silences, total: allEvents.length, span };
  }, [allEvents]);

  const toggleFilter = (type: AutoForgeEventType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerateBriefing = useCallback(async () => {
    if (allEvents.length === 0) {
      toast.error("No events to summarize yet.");
      return;
    }
    setIsGeneratingBriefing(true);
    setBriefing(null);
    try {
      const activeProvider = getActiveProvider();
      const result = await generateAutoForgeBriefing({
        events: allEvents,
        streamMetadata,
        activeProvider,
        config,
      });
      if (result.tokenUsage) {
        useAppStore.getState().recordTokenUsage("briefing", result.tokenUsage);
      }
      setBriefing(result.text);
      toast.success("AI briefing generated!");
    } catch (e: any) {
      toast.error(`Failed to generate briefing: ${e.message || "Unknown error"}`);
    } finally {
      setIsGeneratingBriefing(false);
    }
  }, [allEvents, streamMetadata, config]);

  const handleCopyLog = async () => {
    const text = allEvents.map((e) => {
      const botPrefix = (e as any).botName ? ` [${(e as any).botName}]` : "";
      return `[${formatClock(e.timestamp)}] [${e.type}] [${e.severity}]${botPrefix} ${e.summary}${e.details ? "\n  Details: " + JSON.stringify(e.details) : ""}`;
    }).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Event log copied to clipboard!");
    } catch {
      toast.error("Failed to copy — clipboard not available in this context");
    }
  };

  const handleDownloadLog = () => {
    const file = {
      format: "madchatter-autoforge-report",
      version: 1,
      channel: streamMetadata?.channelName || "",
      exportedAt: new Date().toISOString(),
      events: allEvents,
    };
    const data = JSON.stringify(file, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `autoforge-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Report downloaded!");
  };

  const handleClearLog = () => {
    clearAutoForgeEvents();
    // Also clear per-bot event logs so stale multi-bot events don't persist.
    const state = useAppStore.getState();
    for (const bot of state.bots) {
      state.clearBotAutoForgeEvents(bot.id);
    }
    setBriefing(null);
    toast.success("Event log cleared.");
  };

  if (!isAutoForgeReportOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={() => { setIsAutoForgeReportOpen(false); playSfx('report_close'); }}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 20 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-5xl h-[82vh] bg-[#121217] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-3 border-b border-white/10 bg-black/40 shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-orange-500/15 border border-orange-500/30 flex items-center justify-center">
                <ScrollText className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <h2 className="text-sm font-black tracking-widest text-white uppercase font-mono">
                  AutoForge Report
                </h2>
                <p className="text-[10px] text-gray-500 font-mono">
                  {stats.total} events{stats.span > 0 ? ` over ${formatDuration(stats.span)}` : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ThemedTooltip content="Copy log to clipboard">
                <button
                  type="button"
                  onClick={handleCopyLog}
                  className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </ThemedTooltip>
              <ThemedTooltip content="Download as JSON">
                <button
                  type="button"
                  onClick={handleDownloadLog}
                  className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <Download className="w-4 h-4" />
                </button>
              </ThemedTooltip>
              <ThemedTooltip content="Clear event log">
                <button
                  type="button"
                  onClick={handleClearLog}
                  className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </ThemedTooltip>
              <ThemedTooltip content="Close report">
                <button
                  type="button"
                  onClick={() => { setIsAutoForgeReportOpen(false); playSfx('report_close'); }}
                  className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </ThemedTooltip>
            </div>
          </div>

          {/* Stats Bar */}
          <div className="flex items-center gap-2 p-3 border-b border-white/5 bg-black/20 shrink-0 overflow-x-auto">
            <StatChip label="Actions" value={stats.actions} color="text-green-400 bg-green-500/10 border-green-500/20" />
            <StatChip label="Mentions" value={stats.mentions} color="text-blue-400 bg-blue-500/10 border-blue-500/20" />
            <StatChip label="Spikes" value={stats.spikes} color="text-yellow-400 bg-yellow-500/10 border-yellow-500/20" />
            <StatChip label="Silences" value={stats.silences} color="text-gray-400 bg-gray-500/10 border-gray-500/20" />
            <StatChip label="Errors" value={stats.errors} color="text-red-400 bg-red-500/10 border-red-500/20" />
          </div>

          {/* AI Briefing Section */}
          <div className="p-3 border-b border-white/5 bg-black/20 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold tracking-wider text-gray-500 uppercase font-mono flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-purple-400" /> AI Briefing
              </span>
              <button
                type="button"
                onClick={handleGenerateBriefing}
                disabled={isGeneratingBriefing || allEvents.length === 0}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase font-mono tracking-wider transition-all",
                  isGeneratingBriefing
                    ? "bg-purple-500/20 text-purple-300 cursor-wait"
                    : "bg-purple-500/15 border border-purple-500/30 text-purple-300 hover:bg-purple-500/25"
                )}
              >
                {isGeneratingBriefing ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="w-3 h-3" /> Generate Briefing</>
                )}
              </button>
            </div>
            {briefing && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-gray-600">Select text or use the copy button</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(briefing).then(
                        () => { toast.success("Briefing copied to clipboard!"); playSfx('copy'); },
                        () => toast.error("Failed to copy — clipboard not available"),
                      );
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/30 transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                    Copy
                  </button>
                </div>
                <div
                  className="p-3 bg-purple-500/5 border border-purple-500/15 rounded-lg text-xs text-gray-300 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto forge-scroll-report select-text"
                  style={{ userSelect: "text", WebkitUserSelect: "text" }}
                >
                  {briefing}
                </div>
              </motion.div>
            )}
          </div>

          {/* Filter Bar */}
          <div className="flex items-center gap-2 p-2 border-b border-white/5 bg-black/10 shrink-0">
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono uppercase text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Filter className="w-3 h-3" />
              Filters
              {activeFilters.size > 0 && (
                <span className="bg-orange-500/20 text-orange-400 px-1 rounded text-[8px]">{activeFilters.size}</span>
              )}
            </button>
            {showFilters && (
              <div className="flex items-center gap-1 flex-wrap">
                {ALL_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleFilter(type)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono uppercase border transition-all",
                      activeFilters.has(type)
                        ? EVENT_COLORS[type]
                        : "text-gray-600 bg-white/5 border-white/5 hover:text-gray-400"
                    )}
                  >
                    {EVENT_ICONS[type]}
                    {type.replace(/_/g, " ")}
                  </button>
                ))}
                <div className="w-px h-4 bg-white/10 mx-1" />
                {(["all", "high", "medium", "low"] as const).map((sev) => (
                  <button
                    key={sev}
                    type="button"
                    onClick={() => setSeverityFilter(sev)}
                    className={cn(
                      "px-2 py-0.5 rounded text-[9px] font-mono uppercase border transition-all",
                      severityFilter === sev
                        ? "bg-white/15 border-white/20 text-white"
                        : "text-gray-600 bg-white/5 border-white/5 hover:text-gray-400"
                    )}
                  >
                    {sev}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Event Timeline */}
          <div className="flex-1 overflow-y-auto p-3 space-y-1 forge-scroll-report">
            {filteredEvents.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-2">
                <ScrollText className="w-8 h-8 opacity-30" />
                <p className="text-xs font-mono">
                  {allEvents.length === 0 ? "No events logged yet." : "No events match current filters."}
                </p>
              </div>
            ) : (
              [...filteredEvents].reverse().map((event) => {
                const isExpanded = expandedIds.has(event.id);
                return (
                  <div
                    key={event.id}
                    className={cn(
                      "rounded-lg border p-2 transition-all cursor-pointer",
                      EVENT_COLORS[event.type]
                    )}
                    onClick={() => event.details && toggleExpand(event.id)}
                  >
                    <div className="flex items-start gap-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", SEVERITY_DOT[event.severity])} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[9px] font-mono text-gray-500 shrink-0">
                            {formatClock(event.timestamp)}
                          </span>
                          <span className="text-[8px] font-mono text-gray-600 shrink-0">
                            {formatTimeAgo(event.timestamp, now)}
                          </span>
                          <span className="flex items-center gap-1 text-[9px] font-mono uppercase font-bold shrink-0">
                            {EVENT_ICONS[event.type]}
                            {event.type.replace(/_/g, " ")}
                          </span>
                          {(event as any).botName && (
                            <span className="text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border text-[#c79bff] bg-[#9146FF]/10 border-[#9146FF]/20 shrink-0">
                              {(event as any).botName}
                            </span>
                          )}
                          {event.details && (
                            <span className="ml-auto shrink-0">
                              {isExpanded ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-200 leading-snug break-words">
                          {event.summary}
                        </p>
                        {isExpanded && event.details && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            className="mt-2 p-2 bg-black/40 rounded border border-white/5"
                          >
                            <pre className="text-[10px] font-mono text-gray-400 whitespace-pre-wrap break-words">
                              {JSON.stringify(event.details, null, 2)}
                            </pre>
                          </motion.div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-lg border shrink-0", color)}>
      <span className="text-[9px] font-mono uppercase font-bold opacity-70">{label}</span>
      <span className="text-xs font-mono font-bold">{value}</span>
    </div>
  );
}
