import { useMemo, useState, useEffect, useRef, Fragment } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "./ui/tooltip";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { Settings, Check } from "lucide-react";
import type { AutoForgeEvent, ActionHistoryEntry } from "../types";

interface TimelineItem {
  id: string;
  timestamp: number;
  type: string;
  color: string;
  size: number;
  label: string;
  detail: string;
  pulse?: boolean;
  category: EventCategory;
}

type EventCategory = "actions" | "mentions" | "spikes" | "silence" | "errors" | "system" | "director";

const TYPE_CONFIG: Record<string, { color: string; label: string; category: EventCategory }> = {
  action_sent: { color: "bg-orange-400", label: "Message Sent", category: "actions" },
  silence: { color: "bg-gray-500", label: "Deliberate Silence", category: "silence" },
  mention: { color: "bg-yellow-400", label: "Bot Mentioned", category: "mentions" },
  spike: { color: "bg-red-500", label: "Activity Spike", category: "spikes" },
  error: { color: "bg-red-500", label: "Error", category: "errors" },
  enable_disable: { color: "bg-blue-400", label: "AutoForge Toggle", category: "system" },
  metadata_change: { color: "bg-gray-400", label: "Metadata Change", category: "system" },
  full_forge: { color: "bg-purple-400", label: "Full Forge Triggered", category: "actions" },
  quick_followup: { color: "bg-cyan-400", label: "Quick Follow-up", category: "actions" },
  send_message: { color: "bg-orange-400", label: "Message Sent", category: "actions" },
  deliberate_silence: { color: "bg-gray-500", label: "Deliberate Silence", category: "silence" },
  director_note: { color: "bg-purple-500", label: "Director Note", category: "director" },
};

const CATEGORY_CONFIG: Record<EventCategory, { label: string; color: string; description: string }> = {
  actions: { label: "Actions", color: "bg-orange-400", description: "Messages sent, full forges, follow-ups" },
  mentions: { label: "Mentions", color: "bg-yellow-400", description: "Bot mentioned by name in chat or audio" },
  spikes: { label: "Activity Spikes", color: "bg-red-500", description: "Sudden bursts of chat activity" },
  silence: { label: "Silence", color: "bg-gray-500", description: "Deliberate silence decisions" },
  errors: { label: "Errors", color: "bg-red-500", description: "Failures and error events" },
  system: { label: "System", color: "bg-blue-400", description: "AutoForge toggles, metadata changes" },
  director: { label: "Director Notes", color: "bg-purple-500", description: "Private streamer-to-bot directives" },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_CONFIG) as EventCategory[];

const SEVERITY_SIZE = { high: 10, medium: 7, low: 5 };

const TIME_WINDOW_OPTIONS = [
  { label: "1m", value: 1 * 60 * 1000 },
  { label: "5m", value: 5 * 60 * 1000 },
  { label: "15m", value: 15 * 60 * 1000 },
  { label: "30m", value: 30 * 60 * 1000 },
];

const MAX_ITEMS = 50;

const FILTERS_STORAGE_KEY = "forge-timeline-filters";
const TIMEWINDOW_STORAGE_KEY = "forge-timeline-window";

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function timeAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  return `${min}m ago`;
}

export function ActionTimeline() {
  const autoForgeEventLog = useAppStore((s) => s.autoForgeEventLog);
  const actionHistory = useAppStore((s) => s.actionHistory);
  const bots = useAppStore((s) => s.bots);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const [feedVisible, setFeedVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem("forge-timeline-visible") !== "false";
    } catch {}
    return true;
  });
  const [enabledCategories, setEnabledCategories] = useState<Set<EventCategory>>(() => {
    try {
      const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return new Set(parsed as EventCategory[]);
      }
    } catch {}
    return new Set(ALL_CATEGORIES);
  });
  const [timeWindowMs, setTimeWindowMs] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(TIMEWINDOW_STORAGE_KEY);
      if (raw) return parseInt(raw, 10) || 5 * 60 * 1000;
    } catch {}
    return 5 * 60 * 1000;
  });

  const toggleCategory = (cat: EventCategory) => {
    playSfx("select_change");
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        if (next.size > 1) next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const items = useMemo(() => {
    const now = Date.now();
    const cutoff = now - timeWindowMs;

    // Merge global + per-bot AutoForge events so the timeline shows multi-bot
    // activity. Per-bot events go to bots[].runtime.autoForgeEvents, not the
    // global log, so without this merge the timeline stays empty in multi-bot
    // mode.
    const allEvents: AutoForgeEvent[] = [
      ...autoForgeEventLog,
      ...bots.flatMap((b) => b.runtime.autoForgeEvents),
    ];

    const fromEvents: TimelineItem[] = allEvents
      .filter((e: AutoForgeEvent) => e.timestamp >= cutoff)
      .map((e: AutoForgeEvent) => {
        const cfg = TYPE_CONFIG[e.type] || { color: "bg-gray-400", label: e.type, category: "system" as EventCategory };
        return {
          id: e.id,
          timestamp: e.timestamp,
          type: e.type,
          color: cfg.color,
          size: SEVERITY_SIZE[e.severity] || 5,
          label: cfg.label,
          detail: e.summary,
          pulse: e.severity === "high",
          category: cfg.category,
        };
      });

    // Merge global + per-bot action history
    const allActions: ActionHistoryEntry[] = [
      ...actionHistory,
      ...bots.flatMap((b) => b.runtime.actionHistory),
    ];

    const fromActions: TimelineItem[] = allActions
      .filter((a: ActionHistoryEntry) => a.timestamp >= cutoff)
      .map((a: ActionHistoryEntry) => {
        const cfg = TYPE_CONFIG[a.actionType] || { color: "bg-gray-400", label: a.actionType, category: "system" as EventCategory };
        return {
          id: a.id,
          timestamp: a.timestamp,
          type: a.actionType,
          color: a.success ? cfg.color : "bg-red-500",
          size: 7,
          label: cfg.label,
          detail: `${a.message.slice(0, 80)}${a.message.length > 80 ? "..." : ""} · ${a.provider}${a.success ? "" : " · FAILED"}`,
          category: a.success ? cfg.category : "errors",
        };
      });

    const merged = [...fromEvents, ...fromActions]
      .filter((item) => enabledCategories.has(item.category))
      // Dedupe by id — the global log and bots[0].runtime.* can contain the
      // same event when multi-bot was enabled (legacy state is copied into
      // bots[0] on enable). Without this, React warns about duplicate keys.
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_ITEMS);

    return merged;
  }, [autoForgeEventLog, actionHistory, bots, enabledCategories, timeWindowMs]);

  const now = Date.now();
  const cutoff = now - timeWindowMs;
  const activeFilterCount = ALL_CATEGORIES.length - enabledCategories.size;

  return (
    <div className="shrink-0 h-9 relative">
    {feedVisible && (
    <Fragment>
    <div className="h-9 relative border-b border-white/5 bg-[#0d0d12]/80 backdrop-blur-sm overflow-visible">
      {/* Timeline base line */}
      <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      {/* Left edge fade */}
      <div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-[#0d0d12] to-transparent z-10 pointer-events-none" />
      {/* Right edge fade */}
      <div className="absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-[#0d0d12] to-transparent z-10 pointer-events-none" />

      {/* Dots */}
      <div className="absolute inset-0 overflow-hidden">
      <TooltipProvider delay={250} closeDelay={200}>
      <div className="absolute inset-0 flex items-center">
        <AnimatePresence mode="popLayout">
          {items.map((item) => {
            const ageRatio = (item.timestamp - cutoff) / timeWindowMs;
            const leftPct = Math.max(2, Math.min(94, ageRatio * 100));
            const isNewest = item.id === items[items.length - 1]?.id;

            return (
              <div key={item.id} className="contents">
              <Tooltip>
                <TooltipTrigger render={
                  <motion.div
                    layout
                    initial={{ opacity: 0, scale: 0, x: 20 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0, x: -20 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    className="absolute z-20 flex items-center justify-center"
                    style={{ left: `${leftPct}%`, transform: "translateX(-50%)", width: "28px", height: "28px" }}
                  >
                    <div
                      className={cn(
                        "rounded-full border border-white/20 cursor-pointer transition-transform hover:scale-150",
                        item.color,
                        isNewest && "ring-2 ring-white/30 ring-offset-1 ring-offset-[#0d0d12]",
                        item.pulse && "animate-pulse"
                      )}
                      style={{ width: `${item.size}px`, height: `${item.size}px` }}
                    />
                  </motion.div>
                } />
                <TooltipContent
                  side="bottom"
                  align="center"
                  sideOffset={6}
                  className="max-w-xs p-0 bg-[#1a1a22] border border-white/10 text-left rounded-lg shadow-2xl"
                >
                  <div className="p-2.5 space-y-1">
                    <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                      <span className={cn("w-2 h-2 rounded-full", item.color)} />
                      <span className="text-[10px] font-bold uppercase font-mono tracking-wider text-gray-200">
                        {item.label}
                      </span>
                    </div>
                    <p className="text-[10px] leading-relaxed text-gray-400">{item.detail}</p>
                    <div className="flex items-center justify-between text-[9px] text-gray-600 pt-0.5">
                      <span className="font-mono">{formatTime(item.timestamp)}</span>
                      <span className="font-mono">{timeAgo(item.timestamp)}</span>
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
              </div>
            );
          })}
        </AnimatePresence>
      </div>
      </TooltipProvider>
      </div>
      </div>
    </Fragment>
    )}

      {/* Settings menu — always visible even when feed is off */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 z-[60]">
        <button
          ref={settingsBtnRef}
          onClick={() => {
            setSettingsOpen((v) => {
              if (!v && settingsBtnRef.current) {
                const rect = settingsBtnRef.current.getBoundingClientRect();
                setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
              }
              return !v;
            });
            playSfx("hud_open");
          }}
          className={cn(
            "flex items-center gap-1 p-1 rounded transition-colors",
            settingsOpen ? "bg-white/10" : "hover:bg-white/5",
            activeFilterCount > 0 && !settingsOpen && "ring-1 ring-orange-400/40"
          )}
        >
          <Settings className={cn("w-3 h-3 transition-transform", settingsOpen && "rotate-45", activeFilterCount > 0 ? "text-orange-400" : "text-gray-500")} />
          {activeFilterCount > 0 && (
            <span className="text-[8px] font-bold font-mono text-orange-400/80">{activeFilterCount}</span>
          )}
        </button>
      </div>

      {/* Settings dropdown — portaled to body to escape all stacking contexts */}
      {settingsOpen && dropdownPos && createPortal(
        <>
          {/* Invisible backdrop */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 99998 }}
            onClick={() => setSettingsOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            style={{ position: "fixed", top: dropdownPos.top, right: dropdownPos.right, zIndex: 99999 }}
            className="w-56 bg-[#121217] border border-white/10 rounded-lg shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="px-3 py-2 border-b border-white/5 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase font-mono tracking-wider text-gray-300">Timeline Filters</span>
                <button
                  onClick={() => {
                    setFeedVisible((v) => !v);
                    playSfx("select_change");
                  }}
                  className={cn(
                    "text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors",
                    feedVisible
                      ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                      : "bg-green-500/15 text-green-400 hover:bg-green-500/25"
                  )}
                >
                  {feedVisible ? "Turn Off" : "Turn On"}
                </button>
              </div>

              {/* Time window selector */}
              <div className="px-3 py-2 border-b border-white/5">
                <div className="text-[9px] text-gray-500 font-mono uppercase tracking-wider mb-1.5">Time Window</div>
                <div className="flex gap-1">
                  {TIME_WINDOW_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setTimeWindowMs(opt.value);
                        playSfx("select_change");
                      }}
                      className={cn(
                        "flex-1 text-[10px] font-mono py-1 rounded transition-colors",
                        timeWindowMs === opt.value
                          ? "bg-orange-500/20 text-orange-300 border border-orange-500/30"
                          : "text-gray-500 hover:text-gray-300 hover:bg-white/5 border border-transparent"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Category toggles */}
              <div className="py-1">
                {ALL_CATEGORIES.map((cat) => {
                  const cfg = CATEGORY_CONFIG[cat];
                  const enabled = enabledCategories.has(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => toggleCategory(cat)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-1.5 transition-colors text-left",
                        "hover:bg-white/5"
                      )}
                    >
                      <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", cfg.color, !enabled && "opacity-30")} />
                      <div className="flex-1 min-w-0">
                        <div className={cn("text-[10px] font-bold", enabled ? "text-gray-200" : "text-gray-600")}>
                          {cfg.label}
                        </div>
                        <div className="text-[8px] text-gray-600 truncate">
                          {cfg.description}
                        </div>
                      </div>
                      <div className={cn(
                        "w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                        enabled ? "bg-orange-500/20 border-orange-500/40" : "border-white/10"
                      )}>
                        {enabled && <Check className="w-2.5 h-2.5 text-orange-400" />}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="px-3 py-1.5 border-t border-white/5 flex items-center justify-between">
                <button
                  onClick={() => {
                    const allEnabled = enabledCategories.size === ALL_CATEGORIES.length;
                    setEnabledCategories(allEnabled ? new Set([ALL_CATEGORIES[0]]) : new Set(ALL_CATEGORIES));
                    playSfx("select_change");
                  }}
                  className="text-[9px] text-gray-500 hover:text-gray-300 font-mono uppercase tracking-wider transition-colors"
                >
                  {enabledCategories.size === ALL_CATEGORIES.length ? "Hide All" : "Show All"}
                </button>
                <span className="text-[9px] text-gray-700 font-mono">
                  {items.length} event{items.length !== 1 ? "s" : ""}
                </span>
              </div>
            </motion.div>
        </>,
        document.body
      )}

      {/* Status text — below the timeline bar */}
      {feedVisible && (items.length === 0 || activeFilterCount > 0) && (
        <div className="flex items-center justify-center py-0.5">
          <span className="text-[9px] text-gray-700 font-mono uppercase tracking-widest">
            {items.length === 0
              ? activeFilterCount > 0
                ? `${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""} active — no events`
                : "Awaiting activity..."
              : `${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""} hidden`}
          </span>
        </div>
      )}
    </div>
  );
}
