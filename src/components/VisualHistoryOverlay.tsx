import { useState } from "react";
import { useAppStore } from "../store";
import { X, Clock, Camera, Zap, Trash2, Pin, Download, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { toast } from "sonner";
import { ThemedTooltip } from "./ui/tooltip";
import { stripReasoningBlocks } from "../lib/textSanitize";

function formatTimeAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function VisualHistoryOverlay() {
  const open = useAppStore((s) => s.visualHistoryOpen);
  const setOpen = useAppStore((s) => s.setVisualHistoryOpen);
  const history = useAppStore((s) => s.visualSnapshotHistory);
  const clearHistory = useAppStore((s) => s.clearVisualSnapshotHistory);
  const removeSnapshot = useAppStore((s) => s.removeVisualSnapshot);
  const addPinnedMemory = useAppStore((s) => s.addPinnedMemory);
  // Per-entry expansion — tap-to-expand is the only reliable way to read the
  // full analysis on touch devices (the old hover tooltip doesn't exist on
  // phones) and doubles as the desktop "inspect" path.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!open) return null;

  const now = Date.now();
  const reversed = [...history].reverse();

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4"
        onClick={() => { setOpen(false); playSfx("hud_close"); }}
      >
        <motion.div
          onClick={(e) => e.stopPropagation()}
          className="bg-[#121217] border border-white/10 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] min-w-0 flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 p-3 sm:p-4 border-b border-white/10 bg-black/40 shrink-0 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Camera className="w-5 h-5 text-orange-400 shrink-0" />
              <h2 className="text-sm sm:text-lg font-bold text-white truncate">Visual Snapshot History</h2>
              <span className="hidden min-[380px]:inline text-[10px] text-gray-500 sm:ml-2 shrink-0">
                {history.length} / 30 snapshots
              </span>
            </div>
            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {history.length > 0 && (
                <button
                  onClick={() => {
                    clearHistory();
                    playSfx("clear_context");
                    toast.success("Visual history cleared");
                  }}
                  aria-label="Clear visual snapshot history"
                  className="text-[10px] text-gray-400 hover:text-red-400 px-2 py-1 rounded border border-white/10 hover:border-red-500/30 transition-colors flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> <span className="hidden min-[360px]:inline">Clear</span>
                </button>
              )}
              <button
                onClick={() => { setOpen(false); playSfx("hud_close"); }}
                aria-label="Close visual snapshot history"
                className="text-gray-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div className="flex-1 overflow-y-auto p-2.5 sm:p-4 analytics-scroll min-w-0">
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <Camera className="w-12 h-12 text-orange-500/20" />
                <p className="text-sm text-gray-500">No visual snapshots captured yet.</p>
                <p className="text-[10px] text-gray-600">
                  Start screen capture and frames will appear here automatically as they're analyzed.
                </p>
              </div>
            ) : (
              <div className="relative">
                {/* Timeline line */}
                <div className="hidden sm:block absolute left-[88px] top-2 bottom-2 w-px bg-white/5" />

                <div className="space-y-3">
                  {reversed.map((entry, idx) => {
                    const isLatest = idx === 0;
                    // Entries captured before the reasoning-block sanitizer
                    // existed can still carry raw <think> chain-of-thought
                    // in this session — sanitize for display regardless.
                    const cleanTags = entry.tags
                      .map((t) => stripReasoningBlocks(t))
                      .filter((t) => t.length > 0);
                    const displayText = cleanTags.join("\n");
                    const expanded = expandedIds.has(entry.id);
                    const expandable = displayText.length > 180 || displayText.includes("\n");
                    return (
                      <div key={entry.id} className="flex flex-col gap-1.5 sm:flex-row sm:gap-3 group min-w-0">
                        {/* Timestamp column */}
                        <div className="w-full sm:w-20 shrink-0 flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-2 sm:gap-0 sm:pt-1 px-0.5 sm:px-0">
                          <span className={cn(
                            "text-[10px] font-mono",
                            isLatest ? "text-orange-400 font-bold" : "text-gray-500"
                          )}>
                            {formatClock(entry.timestamp)}
                          </span>
                          <span className="text-[9px] text-gray-600 mt-0.5">
                            {formatTimeAgo(entry.timestamp, now)}
                          </span>
                        </div>

                        {/* Timeline dot */}
                        <div className="relative shrink-0 w-4 hidden sm:flex justify-center pt-3">
                          <div className={cn(
                            "w-2.5 h-2.5 rounded-full border-2 transition-colors",
                            isLatest
                              ? "bg-orange-500 border-orange-400 shadow-[0_0_8px_rgba(249,115,22,0.6)]"
                              : entry.source === "manual"
                                ? "bg-blue-500/60 border-blue-400/40"
                                : "bg-white/10 border-white/20"
                          )} />
                        </div>

                        {/* Content card */}
                        <div className={cn(
                          "flex-1 min-w-0 rounded-lg border overflow-hidden transition-colors",
                          isLatest
                            ? "bg-orange-500/5 border-orange-500/20"
                            : "bg-white/[0.02] border-white/5 hover:border-white/10"
                        )}>
                          {/* Image + meta */}
                          <div className="flex flex-col min-[420px]:flex-row gap-2.5 min-[420px]:gap-3 p-2.5 min-w-0">
                            <div className="relative w-full min-[420px]:w-auto min-w-0 shrink-0 overflow-hidden rounded-md">
                              <img
                                src={entry.url}
                                alt={`Snapshot ${formatClock(entry.timestamp)}`}
                                className="w-full min-[420px]:w-28 h-auto min-[420px]:h-16 aspect-video min-[420px]:aspect-auto rounded-md object-cover border border-white/10"
                              />
                              {/* Source badge */}
                              <span className={cn(
                                "absolute top-1 left-1 text-[8px] font-bold uppercase px-1 py-0.5 rounded",
                                entry.source === "manual"
                                  ? "bg-blue-500/80 text-white"
                                  : "bg-black/70 text-gray-300"
                              )}>
                                {entry.source === "manual" ? (
                                  <span className="flex items-center gap-0.5">
                                    <Camera className="w-2 h-2" /> M
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-0.5">
                                    <Zap className="w-2 h-2" /> A
                                  </span>
                                )}
                              </span>
                              {/* Delta badge */}
                              {entry.delta !== undefined && entry.delta > 0 && (
                                <span className="absolute bottom-1 right-1 text-[8px] font-mono px-1 py-0.5 rounded bg-black/70 text-cyan-400">
                                  Δ{(entry.delta * 100).toFixed(0)}%
                                </span>
                              )}
                            </div>

                            {/* Analysis text */}
                            <div className="flex-1 min-w-0 flex flex-col justify-between">
                              <div>
                                <div className="flex flex-wrap items-center gap-1.5 mb-1 min-w-0 max-w-full overflow-hidden">
                                  {isLatest && (
                                    <span className="shrink-0 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">
                                      Latest
                                    </span>
                                  )}
                                  {/* Analysis status badge — makes it obvious
                                      whether this archived entry contains a
                                      real vision observation. The archive is
                                      history; only the latest analyzed
                                      visualContextTags are live perception. */}
                                  {(() => {
                                    const first = entry.tags[0] ?? "";
                                    if (first.includes("vision failed")) {
                                      return (
                                        <span className="min-w-0 max-w-full shrink text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30 whitespace-nowrap overflow-hidden text-ellipsis">
                                          Vision Failed
                                        </span>
                                      );
                                    }
                                    if (first.startsWith("Captured")) {
                                      return (
                                        <span className="min-w-0 max-w-full shrink text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/5 text-gray-500 border border-white/10 whitespace-nowrap overflow-hidden text-ellipsis">
                                          No Analysis
                                        </span>
                                      );
                                    }
                                    return (
                                      <span className="min-w-0 max-w-full shrink text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap overflow-hidden text-ellipsis">
                                        Analyzed
                                      </span>
                                    );
                                  })()}
                                </div>
                                {displayText ? (
                                  expandable ? (
                                    /* Tap-to-expand: the full observation stays
                                       in-flow so it works on touch (no hover)
                                       and isn't width-capped like a tooltip. */
                                    <button
                                      type="button"
                                      onClick={() => toggleExpanded(entry.id)}
                                      aria-expanded={expanded}
                                      className="block w-full text-left group/analysis"
                                    >
                                      <p
                                        className={cn(
                                          "text-[11px] text-gray-300 leading-relaxed font-mono break-words",
                                          expanded ? "whitespace-pre-wrap" : "line-clamp-3",
                                        )}
                                      >
                                        {displayText}
                                      </p>
                                      <span className="mt-0.5 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider text-teal-400 group-hover/analysis:text-teal-300">
                                        <ChevronDown className={cn("w-2.5 h-2.5 transition-transform", expanded && "rotate-180")} />
                                        {expanded ? "Show less" : "Show full analysis"}
                                      </span>
                                    </button>
                                  ) : (
                                    <p className="text-[11px] text-gray-300 leading-relaxed font-mono whitespace-pre-wrap break-words">
                                      {displayText}
                                    </p>
                                  )
                                ) : (
                                  <p className="text-[11px] text-gray-600 italic font-mono">
                                    No analysis captured.
                                  </p>
                                )}
                              </div>

                              {/* Actions */}
                              <div className="flex flex-wrap items-center gap-1.5 mt-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                                <ThemedTooltip content="Pin to Long-Term Memory">
                                  <button
                                    onClick={() => {
                                      addPinnedMemory({
                                        type: "visual",
                                        content: cleanTags.join(", ") || "Captured",
                                        label: `Visual Snapshot — ${cleanTags[0]?.slice(0, 60) || "Captured"}${cleanTags[0] && cleanTags[0].length > 60 ? "…" : ""}`,
                                        timestamp: entry.timestamp,
                                        imageUrl: entry.url,
                                      });
                                      toast.success("Pinned to Long-Term Memory");
                                      playSfx("memory_add");
                                    }}
                                    className="text-[9px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-blue-500/10 transition-colors"
                                  >
                                    <Pin className="w-2.5 h-2.5" /> Pin
                                  </button>
                                </ThemedTooltip>
                                <ThemedTooltip content="Download image">
                                  <button
                                    onClick={() => {
                                      const a = document.createElement("a");
                                      a.href = entry.url;
                                      a.download = `snapshot-${entry.timestamp}.jpg`;
                                      a.click();
                                    }}
                                    className="text-[9px] text-gray-400 hover:text-white flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
                                  >
                                    <Download className="w-2.5 h-2.5" /> Save
                                  </button>
                                </ThemedTooltip>
                                <ThemedTooltip content="Delete snapshot">
                                  <button
                                    onClick={() => {
                                      removeSnapshot(entry.id);
                                      playSfx("memory_remove");
                                      toast.success("Snapshot deleted");
                                    }}
                                    className="text-[9px] text-red-400 hover:text-red-300 flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-red-500/10 transition-colors"
                                  >
                                    <Trash2 className="w-2.5 h-2.5" /> Delete
                                  </button>
                                </ThemedTooltip>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Footer hint */}
          {history.length > 0 && (
            <div className="px-3 sm:px-4 py-2 border-t border-white/5 bg-black/20 flex items-start gap-2 text-[9px] text-gray-600 min-w-0">
              <Clock className="w-3 h-3 shrink-0 mt-0.5" />
              <span>
                <span className="text-blue-400 font-bold">P</span> = manual capture ·{" "}
                <span className="text-gray-400 font-bold">A</span> = auto capture ·{" "}
                <span className="text-cyan-400 font-bold">Δ</span> = frame change %
              </span>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
