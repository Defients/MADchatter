import React, { useEffect, useState, useRef } from 'react';
import { useAppStore, selectMultiBotActive } from '../store';
import type { Bot } from '../types';
import { Activity, Brain, Clock, Zap, X, Minimize2, Maximize2, Sparkles, ScrollText, Gauge, Rows3, FlaskConical, Radio, TrendingUp, HelpCircle, ChevronDown, Send, Megaphone } from 'lucide-react';
import { cn } from '../lib/utils';
import { playSfx, playForceBurstSfx } from '../lib/sfx';
import { actionRateLimiter } from '../lib/actionRateLimiter';
import { sendManualMessage } from '../lib/manualSend';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { Reorder } from 'framer-motion';
import { ThemedTooltip } from './ui/tooltip';
import { DIRECTOR_NOTE_DURATIONS, directorNoteSummary, DirectorNoteChip, priorityBadge } from './directorNoteShared';
import { useEffectiveMode } from '../hooks/useMediaQuery';

// ─── Next Check color thresholds ───────────────────────────────────────────
// Short = hot/green (about to fire), long = cool/red (calm wait).
function nextCheckColor(secs: number): string {
  if (secs <= 10) return 'text-emerald-400';
  if (secs <= 30) return 'text-yellow-400';
  if (secs <= 90) return 'text-orange-400';
  return 'text-red-400';
}

function nextCheckBarColor(secs: number): string {
  if (secs <= 10) return 'bg-emerald-500';
  if (secs <= 30) return 'bg-yellow-500';
  if (secs <= 90) return 'bg-orange-500';
  return 'bg-red-500';
}

// Glow when imminent (≤ 5s) — pulses to draw the eye.
function nextCheckGlow(secs: number): string {
  if (secs <= 5) return 'drop-shadow-[0_0_8px_rgba(52,211,153,0.9)]';
  if (secs <= 10) return 'drop-shadow-[0_0_4px_rgba(250,204,21,0.6)]';
  return '';
}

function RateLimitIndicator() {
  const [stats, setStats] = useState(() => actionRateLimiter.getStats());

  useEffect(() => {
    const interval = setInterval(() => setStats(actionRateLimiter.getStats()), 1000);
    return () => clearInterval(interval);
  }, []);

  const hourPct = (stats.actionsLastHour / stats.maxPerHour) * 100;
  const tenMinPct = (stats.actionsLastTenMin / stats.maxPerTenMin) * 100;
  const cooldownSecs = Math.ceil(stats.msUntilNextAllowed / 1000);

  const hourColor = hourPct >= 80 ? 'bg-red-500' : hourPct >= 60 ? 'bg-yellow-500' : 'bg-green-500';
  const tenMinColor = tenMinPct >= 80 ? 'bg-red-500' : tenMinPct >= 60 ? 'bg-yellow-500' : 'bg-green-500';
  const canAct = stats.msUntilNextAllowed === 0;

  return (
    <div className="flex flex-col gap-2 p-2.5 bg-black/40 rounded border border-white/5">
      <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
        <Gauge className="w-3 h-3 text-cyan-400" /> Rate Limit Status
      </span>

      <div className="flex flex-col gap-1.5">
        {/* Per hour */}
        <div className="flex flex-col gap-0.5">
          <div className="flex justify-between items-center text-[10px]">
            <span className="text-gray-400 uppercase">Per Hour</span>
            <span className={cn('font-mono font-bold', hourPct >= 80 ? 'text-red-400' : hourPct >= 60 ? 'text-yellow-400' : 'text-green-400')}>
              {stats.actionsLastHour}/{stats.maxPerHour}
            </span>
          </div>
          <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div className={cn('h-full transition-all duration-500', hourColor)} style={{ width: `${Math.min(100, hourPct)}%` }} />
          </div>
        </div>

        {/* Per 10 min */}
        <div className="flex flex-col gap-0.5">
          <div className="flex justify-between items-center text-[10px]">
            <span className="text-gray-400 uppercase">Per 10 Min</span>
            <span className={cn('font-mono font-bold', tenMinPct >= 80 ? 'text-red-400' : tenMinPct >= 60 ? 'text-yellow-400' : 'text-green-400')}>
              {stats.actionsLastTenMin}/{stats.maxPerTenMin}
            </span>
          </div>
          <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div className={cn('h-full transition-all duration-500', tenMinColor)} style={{ width: `${Math.min(100, tenMinPct)}%` }} />
          </div>
        </div>

        {/* Cooldown */}
        <div className="flex items-center justify-between text-[10px] pt-0.5">
          <span className="text-gray-400 uppercase">Cooldown</span>
          {canAct ? (
            <span className="font-mono font-bold text-green-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Ready
            </span>
          ) : (
            <span className="font-mono font-bold text-yellow-400">{cooldownSecs}s</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function AutoForgeHUD() {
  const {
    isAutoForgeHUDOpen,
    setIsAutoForgeHUDOpen,
    autoForgeEnabled,
    lastAutoForgeDecision,
    autoForgeNextActionMs,
    autoForgeLastActionMs,
    config,
    updateConfig,
    autoForgeFollowup,
    autoForgeDryRun,
    setAutoForgeDryRun,
    autoForgeConfidenceThreshold,
    setAutoForgeConfidenceThreshold,
    engagementScore,
    streamLikelyOffline,
    bots,
    isAutoForgeThinking,
    autoForgeAutoCheckEnabled,
    setAutoForgeAutoCheckEnabled,
    autoForgeDecisionHistory,
  } = useAppStore();
  const multiBotActive = useAppStore(selectMultiBotActive);

  // The AutoForge HUD is a STUDIO-only surface. In CORE mode the user
  // manages AutoForge through the Core workspace's AutoForge panel instead.
  // Gate both the render and the open state so a stray open (hotkey H,
  // command palette, voice command) can't leave the HUD stuck "open"
  // invisibly and surprise the user when they later switch to STUDIO.
  const effectiveMode = useEffectiveMode();
  useEffect(() => {
    if (effectiveMode === 'core' && useAppStore.getState().isAutoForgeHUDOpen) {
      useAppStore.getState().setIsAutoForgeHUDOpen(false);
    }
  }, [effectiveMode]);

  const [now, setNow] = useState(Date.now());
  const [burstKey, setBurstKey] = useState(0);
  const [burstIntensity, setBurstIntensity] = useState(0);
  const [minimized, setMinimized] = useState(true);
  const [liteView, setLiteView] = useState(false);
  // Decision history pagination. The HUD shows the most recent decision by
  // default; Q/E page back/forward through the bounded history, W sends the
  // currently-viewed page's payload if it was never delivered.
  const [historyOffset, setHistoryOffset] = useState(0);
  // Pulse the collapse button for 3s on initial HUD show to draw attention.
  const [collapsePulse, setCollapsePulse] = useState(false);

  // Micro-check acceleration tracking: detect when the next-check timer is
  // shortened mid-cycle (activity spike, mention, manual cooldown) and flash
  // a visual cue so the user can see the bot "waking up" sooner.
  const [accelKey, setAccelKey] = useState(0);
  const prevNextMsRef = useRef(0);

  // Dry Run section expand state — Confidence Threshold slider is hidden by
  // default to save space for a lesser-used feature.
  const [dryRunExpanded, setDryRunExpanded] = useState(false);
  // Send Now button state for the decision card. Declared with the other
  // hooks (before the early return) to respect the Rules of Hooks.
  const [sendingPayload, setSendingPayload] = useState(false);

  useEffect(() => {
    if (!isAutoForgeHUDOpen) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isAutoForgeHUDOpen]);

  // Pulse the collapse/expand button for 3s when the HUD first opens so the
  // user notices they can expand it for the full view.
  useEffect(() => {
    if (!isAutoForgeHUDOpen) return;
    setCollapsePulse(true);
    const t = setTimeout(() => setCollapsePulse(false), 1750);
    return () => clearTimeout(t);
  }, [isAutoForgeHUDOpen]);

  useEffect(() => {
    const onExpand = () => {
      setMinimized(false);
      setLiteView(false);
    };
    window.addEventListener("tutorial-expand-hud", onExpand);
    return () => window.removeEventListener("tutorial-expand-hud", onExpand);
  }, []);

  // In multi-bot mode the legacy global pacing fields are NOT updated (the
  // legacy loop stands down). Derive next/last/decision from per-bot runtimes
  // so the HUD's NEXT CHECK timer and decision card stay accurate.
  const activeBots = multiBotActive ? bots.filter((b) => b.active && b.session) : [];

  const rawNext = multiBotActive
    ? activeBots.reduce<number>((min, b) => Math.min(min, b.runtime.autoForgeNextActionMs), Infinity)
    : (autoForgeNextActionMs ?? 0);
  const effectiveNextActionMs = rawNext === Infinity ? 0 : rawNext;

  // Processing state: true when any bot is actively running an AutoForge
  // check (the AI call is in-flight). In multi-bot mode, check per-bot
  // runtime flags; in legacy mode, check the global thinking flag.
  const isProcessing = multiBotActive
    ? activeBots.some((b) => b.runtime.isAutoForgeThinking)
    : isAutoForgeThinking;

  const effectiveLastActionMs = multiBotActive
    ? activeBots.reduce<number>((max, b) => Math.max(max, b.runtime.autoForgeLastActionMs ?? 0), 0)
    : (autoForgeLastActionMs ?? 0);

  // Most recent decision across bots (by timestamp), plus the bot that owns it
  // so the card can show who was chosen to speak and why.
  // In multi-bot mode we merge every bot's decision history into one
  // chronological list so Q/E can page across all bots.
  let effectiveDecision = lastAutoForgeDecision;
  let decisionBot: Bot | null = null;
  let mergedHistory: { decision: NonNullable<typeof lastAutoForgeDecision>; bot: Bot | null }[] = [];
  if (multiBotActive && activeBots.length > 0) {
    let bestTs = -1;
    for (const b of activeBots) {
      const d = b.runtime.lastAutoForgeDecision;
      const ts = d?.timestamp ?? b.runtime.autoForgeLastActionMs ?? 0;
      if (d && ts > bestTs) {
        bestTs = ts;
        effectiveDecision = d;
        decisionBot = b;
      }
      for (const hd of b.runtime.autoForgeDecisionHistory) {
        if (hd) mergedHistory.push({ decision: hd, bot: b });
      }
    }
    mergedHistory.sort((a, b) => (a.decision.timestamp ?? 0) - (b.decision.timestamp ?? 0));
  } else {
    mergedHistory = (autoForgeDecisionHistory ?? []).map((d) => ({ decision: d, bot: null }));
  }

  // Apply the pagination offset. Offset 0 = most recent; higher = older.
  // Clamp to the available range so a stale offset (e.g. after a bot was
  // removed) can't run off the end. Done in a useEffect (not during render)
  // to avoid React #310 (too many re-renders).
  const historyLen = mergedHistory.length;
  const clampedOffset = Math.min(historyOffset, Math.max(0, historyLen - 1));
  useEffect(() => {
    if (historyLen > 0 && clampedOffset !== historyOffset) {
      setHistoryOffset(clampedOffset);
    }
  }, [historyLen, clampedOffset, historyOffset]);
  const viewingHistory = historyLen > 0 && clampedOffset > 0;
  if (viewingHistory) {
    const entry = mergedHistory[historyLen - 1 - clampedOffset];
    if (entry) {
      effectiveDecision = entry.decision;
      decisionBot = entry.bot;
    }
  }

  // ── Micro-check acceleration cue ────────────────────────────────────────
  // Detect when the next-check timer was shortened mid-cycle (e.g. activity
  // spike, mention, or manual cooldown floor). When the scheduled time moves
  // earlier than what we previously saw, fire a one-shot flash so the user
  // can see the bot "waking up" sooner.
  useEffect(() => {
    if (!effectiveNextActionMs) return;
    const prev = prevNextMsRef.current;
    if (prev && effectiveNextActionMs < prev - 1000) {
      // Timer was pulled forward by > 1s — accelerate cue
      setAccelKey((k) => k + 1);
    }
    prevNextMsRef.current = effectiveNextActionMs;
  }, [effectiveNextActionMs]);

  // Q/W/E decision-history navigation. Q = older, E = newer, W = send the
  // currently-viewed page's payload if it was never delivered. App.tsx
  // dispatches custom events on keydown; the HUD listens here.
  useEffect(() => {
    if (!isAutoForgeHUDOpen) return;
    const onPrev = () => setHistoryOffset((o) => o + 1);
    const onNext = () => setHistoryOffset((o) => Math.max(0, o - 1));
    const onSend = () => {
      const channel = useAppStore.getState().streamMetadata.channelName;
      const payload = typeof effectiveDecision?.action_payload === "string"
        ? effectiveDecision.action_payload
        : "";
      if (!channel) { toast.error("Set a channel before sending."); return; }
      if (!payload) { toast.info("No message on this page to send."); return; }
      if (effectiveDecision?.decision === "deliberate_silence" || effectiveDecision?.decision === "meta_observation") {
        toast.info("This decision was a silence — nothing to send.");
        return;
      }
      const sent = multiBotActive
        ? (decisionBot?.runtime.sentMessages ?? [])
        : useAppStore.getState().sentMessages;
      if (sent.some((m) => m.message.toLowerCase().trim() === payload.toLowerCase().trim())) {
        toast.info("This message was already sent.");
        return;
      }
      setSendingPayload(true);
      sendManualMessage({
        message: payload,
        channel,
        botId: decisionBot?.id,
        source: "manual",
      })
        .then(() => {
          playSfx("forge_complete");
          toast.success(`Sent${decisionBot ? ` as @${decisionBot.session?.username}` : ""}`, {
            description: payload.slice(0, 60),
          });
        })
        .catch((err: any) => {
          toast.error("Send failed", { description: err?.message || String(err) });
        })
        .finally(() => setSendingPayload(false));
    };
    window.addEventListener("autoforge-history-prev", onPrev);
    window.addEventListener("autoforge-history-next", onNext);
    window.addEventListener("autoforge-history-send", onSend);
    return () => {
      window.removeEventListener("autoforge-history-prev", onPrev);
      window.removeEventListener("autoforge-history-next", onNext);
      window.removeEventListener("autoforge-history-send", onSend);
    };
  }, [isAutoForgeHUDOpen, effectiveDecision, decisionBot, multiBotActive]);

  if (!isAutoForgeHUDOpen) return null;
  if (effectiveMode === 'core') return null;

  const timeSinceLast = effectiveLastActionMs
    ? Math.max(0, Math.floor((now - effectiveLastActionMs) / 1000))
    : 0;

  const timeUntilNext = effectiveNextActionMs
    ? Math.max(0, Math.floor((effectiveNextActionMs - now) / 1000))
    : 0;

  // Progress bar: how close we are to firing (0% → 100% as time elapses).
  // Based on the gap between the last action and the scheduled next action.
  const totalCycleMs = effectiveNextActionMs && effectiveLastActionMs
    ? Math.max(1000, effectiveNextActionMs - effectiveLastActionMs)
    : 0;
  const elapsedMs = effectiveLastActionMs ? Math.max(0, now - effectiveLastActionMs) : 0;
  const cyclePct = totalCycleMs ? Math.min(100, Math.round((elapsedMs / totalCycleMs) * 100)) : 0;

  // NEXT CHECK paused: auto-scheduling is off, so the timer is meaningless.
  // Force buttons become the primary interaction — switch them to an amber
  // accent with a subtle pulse so the user knows they're "live".
  const nextCheckPaused = !autoForgeAutoCheckEnabled;
  const forceBtnClass = nextCheckPaused
    ? "text-[8px] bg-amber-500/25 hover:bg-amber-500/50 text-amber-200 px-1.5 py-0.5 rounded font-mono uppercase transition-colors shadow-[0_0_8px_rgba(234,179,8,0.25)] animate-pulse"
    : "text-[8px] bg-purple-500/20 hover:bg-purple-500/40 text-purple-200 px-1.5 py-0.5 rounded font-mono uppercase transition-colors";

  // NEXT CHECK display state — three distinct visual modes:
  // 1. Paused: auto-scheduling off (existing)
  // 2. Processing: a bot is actively running an AI check — animated brain +
  //    sweeping progress bar so the user can see work is in-flight
  // 3. Waiting: timer hit 0 but no bot is processing — the 15s interval
  //    hasn't fired yet. Subtle pulse so "0s stuck" reads as "waiting for
  //    tick" rather than "frozen"
  // 4. Countdown: normal timer (existing)
  const isWaiting = !nextCheckPaused && !isProcessing && timeUntilNext === 0;

  const decisionType = effectiveDecision?.decision || 'None';
  // Defensive: if a model returned reason/action_payload as a non-string
  // (e.g. a nested object), coerce to string so React never sees an object
  // child (error #31). The source fix is in autoforgeDecide, but this guard
  // also protects against persisted stale decisions from older sessions.
  const rawReason = effectiveDecision?.reason;
  const decisionReason = typeof rawReason === "string" ? rawReason : "Waiting for initial signal check...";
  const confidence = effectiveDecision?.confidence || 0;
  const activityLevel = effectiveDecision?.activityLevel || 0;
  const rawActionPayload = effectiveDecision?.action_payload;
  const safeActionPayload = typeof rawActionPayload === "string" ? rawActionPayload : "";

  // Multi-bot "why chosen" context for the decision card.
  const decisionBotUsername = decisionBot?.session?.username ?? null;
  const decisionPersonaFit = effectiveDecision?.personaFit;
  const decisionWasMentioned = effectiveDecision?.isMentioned === true;
  const decisionWasSent = decisionType !== 'None' && decisionType !== 'deliberate_silence' && decisionType !== 'meta_observation' && !!safeActionPayload;

  // Check if the action_payload was actually sent. The heuristic above only
  // checks that a decision was an action type — it doesn't verify the send
  // happened. When a bot decides to act but gets preempted (vision, manual
  // Forge) or queue-timed-out, the decision is stored but the message was
  // never sent. Compare the payload against recent sent messages so we can
  // show a "Send" button for unsent payloads.
  const recentSentMessages = multiBotActive
    ? (decisionBot?.runtime.sentMessages ?? [])
    : useAppStore.getState().sentMessages;
  const wasActuallySent = !!safeActionPayload && recentSentMessages.some(
    (m) => m.message.toLowerCase().trim() === safeActionPayload.toLowerCase().trim(),
  );
  const showSendButton = decisionWasSent && !wasActuallySent;

  return (
    <motion.div
      drag
      dragMomentum={false}
      dragElastic={0.1}
      data-tutorial="autoforge-hud"
      initial={{ opacity: 0, scale: 0.9, y: -50 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: -50 }}
      className="fixed z-40 top-5 right-5 flex flex-col bg-[#121217]/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl overflow-hidden cursor-move"
      style={{ width: 330 }}
    >
      {/* Header (Drag Handle) */}
      <div className="flex items-center justify-between p-2.5 border-b border-white/10 bg-black/40">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center">
            <Brain className={cn(
              "w-4 h-4 relative z-10",
              isProcessing ? "text-cyan-400 forge-processing-icon" : autoForgeEnabled ? "text-red-500" : "text-gray-500",
            )} />
            {autoForgeEnabled && !isProcessing && (
              <span className="absolute w-4 h-4 bg-red-500/30 rounded-full animate-ping" />
            )}
            {isProcessing && (
              <span className="absolute w-4 h-4 bg-cyan-500/30 rounded-full animate-ping" />
            )}
          </div>
          <span data-tutorial="autoforge-header" className="font-mono text-xs font-bold tracking-widest text-gray-300 uppercase">
            AutoForge{autoForgeDryRun && <span className="text-cyan-400 ml-1">·DRY</span>}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ThemedTooltip
            content={
              <div className="flex flex-col gap-0.5 max-w-[220px]">
                <span className="font-bold text-[11px] flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-green-400" />
                  NEXT CHECK {autoForgeAutoCheckEnabled ? "· Auto" : "· Paused"}
                </span>
                <span className="text-gray-400 font-normal text-[10px] leading-snug">
                  {autoForgeAutoCheckEnabled
                    ? "Auto-scheduling is on — bots check in on their own cadence. Toggle off to pause the timer and drive checks manually with the Force buttons."
                    : "Auto-scheduling is paused — use the Force buttons below to run a check whenever you want."}
                </span>
              </div>
            }
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAutoForgeAutoCheckEnabled(!autoForgeAutoCheckEnabled);
                playSfx('panel_collapse');
              }}
              aria-pressed={autoForgeAutoCheckEnabled}
              aria-label="Toggle NEXT CHECK auto-scheduling"
              className={cn(
                "p-1 rounded transition-colors",
                autoForgeAutoCheckEnabled
                  ? "text-green-400 bg-green-500/15 hover:bg-green-500/25"
                  : "text-gray-500 bg-white/5 hover:bg-white/10",
              )}
            >
              <Clock className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
          <ThemedTooltip content="View AutoForge Report">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); useAppStore.getState().setIsAutoForgeReportOpen(true); playSfx('report_open'); }}
              className="p-1 rounded text-gray-400 hover:text-orange-400 hover:bg-orange-500/20 transition-colors"
            >
              <ScrollText className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
          <ThemedTooltip content="Toggle Lite View">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLiteView(v => !v); playSfx('panel_collapse'); }}
              className={cn("p-1 rounded transition-colors", liteView ? "text-cyan-400 bg-cyan-500/20" : "text-gray-400 hover:text-white hover:bg-white/10")}
            >
              <Rows3 className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
          <button 
            type="button"
            onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); playSfx('panel_collapse'); }}
            className={cn(
              "p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors",
              collapsePulse && "forge-collapse-pulse",
            )}
          >
            {minimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
          <button 
            type="button"
            onClick={(e) => { e.stopPropagation(); setIsAutoForgeHUDOpen(false); playSfx('hud_close'); }}
            className="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {!minimized && liteView && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex flex-col gap-2 p-2.5 cursor-default"
            onPointerDownCapture={(e) => e.stopPropagation()}
          >
            {/* Lite: Next Check + Force */}
            <div className="flex items-center justify-between p-2 bg-white/5 rounded border border-white/5 relative overflow-hidden">
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  {isProcessing ? (
                    <Brain className="w-3 h-3 text-cyan-400 forge-processing-icon" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-purple-400" />
                  )} Next Check
                </span>
                <span className={cn(
                  "text-xs font-mono font-bold mt-0.5 transition-colors",
                  nextCheckPaused
                    ? "text-gray-500"
                    : isProcessing
                    ? "text-cyan-400"
                    : isWaiting
                    ? "text-gray-400 forge-waiting-pulse"
                    : cn(nextCheckColor(timeUntilNext), nextCheckGlow(timeUntilNext)),
                )}>
                  {nextCheckPaused
                    ? "Paused"
                    : isProcessing
                    ? "Processing..."
                    : isWaiting
                    ? "Waiting..."
                    : `${timeUntilNext}s`}
                </span>
                {/* Micro-check progress bar */}
                <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden mt-1.5 relative">
                  {isProcessing ? (
                    <div className="absolute inset-0 overflow-hidden">
                      <div className="absolute inset-y-0 w-1/2 bg-cyan-500 forge-processing-bar" />
                    </div>
                  ) : (
                    <div
                      className={cn("h-full transition-all duration-1000 ease-linear", nextCheckPaused ? "bg-gray-600" : isWaiting ? "bg-gray-500" : nextCheckBarColor(timeUntilNext))}
                      style={{ width: nextCheckPaused ? "100%" : isWaiting ? "100%" : `${cyclePct}%` }}
                    />
                  )}
                </div>
              </div>
              {/* Acceleration flash cue */}
              <AnimatePresence>
                {accelKey > 0 && (
                  <motion.div
                    key={accelKey}
                    initial={{ opacity: 0.9, scale: 0.5 }}
                    animate={{ opacity: 0, scale: 2.5 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.7, ease: "easeOut" }}
                    className="absolute left-2 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full pointer-events-none z-40"
                    style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.9) 0%, transparent 70%)' }}
                  />
                )}
              </AnimatePresence>
              {multiBotActive && activeBots.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 justify-end max-w-[60%]">
                  {activeBots.map((bot, idx) => (
                    <ThemedTooltip key={bot.id} content={`Force @${bot.session?.username ?? bot.id}`}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          playForceBurstSfx();
                          setBurstKey((k) => k + 1);
                          setBurstIntensity((i) => Math.min(i + 1, 5));
                          window.dispatchEvent(new CustomEvent("autoforge-force-check", { detail: { botId: bot.id } }));
                          setTimeout(() => setBurstIntensity(0), 30000);
                        }}
                        className={forceBtnClass}
                      >
                        #{idx + 1}
                      </button>
                    </ThemedTooltip>
                  ))}
                </div>
              ) : (
                <ThemedTooltip content="Force check now">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      playForceBurstSfx();
                      setBurstKey((k) => k + 1);
                      setBurstIntensity((i) => Math.min(i + 1, 5));
                      window.dispatchEvent(new Event("autoforge-force-check"));
                      setTimeout(() => setBurstIntensity(0), 30000);
                    }}
                    className={forceBtnClass}
                  >
                    Force
                  </button>
                </ThemedTooltip>
              )}
            </div>

            {/* Lite: Previous Cycle Decision */}
            <div className="flex flex-col">
              <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase mb-1.5 ml-0.5">Previous Cycle Decision</span>
              <div className="flex flex-col p-2 bg-blue-500/10 border border-blue-500/20 rounded gap-1.5 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-1 px-2 bg-blue-500/20 rounded-bl-lg">
                  <span className="text-[9px] text-blue-300 font-mono font-bold">CONF: {Math.round(confidence * 100)}%</span>
                </div>
                <span className="text-[10px] font-mono text-blue-400 font-bold uppercase">{decisionType}</span>
                {multiBotActive && decisionBotUsername && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[9px] font-mono font-bold text-[#c79bff] bg-[#9146FF]/15 border border-[#9146FF]/30 rounded px-1.5 py-0.5">
                      {decisionWasSent ? 'Sent by' : 'Decided by'} @{decisionBotUsername}
                    </span>
                    {typeof decisionPersonaFit === 'number' && (
                      <ThemedTooltip content="How well this bot's persona fits the moment">
                        <span className="text-[9px] font-mono text-gray-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                          FIT {Math.round(decisionPersonaFit * 100)}%
                        </span>
                      </ThemedTooltip>
                    )}
                    {decisionWasMentioned && (
                      <span className="text-[9px] font-mono text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded px-1.5 py-0.5">
                        @MENTIONED
                      </span>
                    )}
                  </div>
                )}
                <p className="text-xs text-gray-300 leading-relaxed italic pr-4">"{decisionReason}"</p>
                {safeActionPayload && (
                  <div className="mt-1 p-2 bg-black/50 rounded border border-white/5 text-[10px] font-mono text-white break-words">
                    {safeActionPayload}
                  </div>
                )}
                {showSendButton && (
                  <>
                    <span className="text-[9px] font-mono font-bold uppercase text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 self-start">
                      Pending — not sent
                    </span>
                    <button
                      type="button"
                      disabled={sendingPayload}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (sendingPayload) return;
                        setSendingPayload(true);
                        try {
                          const channel = useAppStore.getState().streamMetadata.channelName;
                          if (!channel) {
                            toast.error("Set a channel before sending.");
                            return;
                          }
                          await sendManualMessage({
                            message: safeActionPayload,
                            channel,
                            botId: decisionBot?.id,
                            source: "manual",
                          });
                          playSfx("forge_complete");
                          toast.success(`Sent${decisionBot ? ` as @${decisionBot.session?.username}` : ""}`, {
                            description: safeActionPayload.slice(0, 60),
                          });
                        } catch (err: any) {
                          toast.error("Send failed", { description: err?.message || String(err) });
                        } finally {
                          setSendingPayload(false);
                        }
                      }}
                      className={cn(
                        "mt-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded text-[10px] font-mono font-bold uppercase transition-colors border",
                        sendingPayload
                          ? "bg-white/5 border-white/10 text-gray-500 cursor-wait"
                          : "bg-emerald-500/20 hover:bg-emerald-500/40 border-emerald-500/30 text-emerald-300 hover:text-emerald-200",
                      )}
                    >
                      {sendingPayload ? "Sending..." : "Send Now"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
        {!minimized && !liteView && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex flex-col gap-3 p-3 cursor-default"
            onPointerDownCapture={(e) => e.stopPropagation()} // Allow clicking inside without dragging
          >
            
            {/* Status Grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col p-2 bg-white/5 rounded border border-white/5">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  <Activity className="w-3 h-3 text-blue-400" /> Status
                </span>
                <span className={cn("text-xs font-bold mt-0.5", autoForgeEnabled ? "text-red-400" : "text-gray-500")}>
                  {autoForgeEnabled ? "ACTIVE" : "DISABLED"}
                </span>
              </div>
              
              <div className="flex flex-col p-2 bg-white/5 rounded border border-white/5">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  <Zap className="w-3 h-3 text-yellow-400" /> Chat Energy
                </span>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="text-xs font-bold text-gray-200">LVL {activityLevel}</span>
                  <div className="flex gap-0.5 ml-1">
                    {[1, 2, 3, 4].map((l) => (
                      <div key={l} className={cn("w-1.5 h-3 rounded-full", l <= activityLevel ? "bg-yellow-400" : "bg-white/10")} />
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex flex-col p-2 bg-white/5 rounded border border-white/5">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-green-400" /> Last Action
                </span>
                <span className="text-xs font-mono text-gray-200 mt-0.5">
                  {effectiveLastActionMs ? `${timeSinceLast}s ago` : "Never"}
                </span>
              </div>

              <div className="flex flex-col p-2 bg-white/5 rounded border border-white/5 relative overflow-hidden">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  {isProcessing ? (
                    <Brain className="w-3 h-3 text-cyan-400 forge-processing-icon" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-purple-400" />
                  )} Next Check
                </span>
                <span className={cn(
                  "text-xs font-mono font-bold mt-0.5 transition-colors",
                  nextCheckPaused
                    ? "text-gray-500"
                    : isProcessing
                    ? "text-cyan-400"
                    : isWaiting
                    ? "text-gray-400 forge-waiting-pulse"
                    : cn(nextCheckColor(timeUntilNext), nextCheckGlow(timeUntilNext)),
                )}>
                  {nextCheckPaused
                    ? "Paused"
                    : isProcessing
                    ? "Processing..."
                    : isWaiting
                    ? "Waiting..."
                    : `${timeUntilNext}s`}
                </span>
                {/* Micro-check progress bar */}
                <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden mt-1.5 relative">
                  {isProcessing ? (
                    <div className="absolute inset-0 overflow-hidden">
                      <div className="absolute inset-y-0 w-1/2 bg-cyan-500 forge-processing-bar" />
                    </div>
                  ) : (
                    <div
                      className={cn("h-full transition-all duration-1000 ease-linear", nextCheckPaused ? "bg-gray-600" : isWaiting ? "bg-gray-500" : nextCheckBarColor(timeUntilNext))}
                      style={{ width: nextCheckPaused ? "100%" : isWaiting ? "100%" : `${cyclePct}%` }}
                    />
                  )}
                </div>
                {/* Acceleration flash cue */}
                <AnimatePresence>
                  {accelKey > 0 && (
                    <motion.div
                      key={accelKey}
                      initial={{ opacity: 0.9, scale: 0.5 }}
                      animate={{ opacity: 0, scale: 2.5 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.7, ease: "easeOut" }}
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full pointer-events-none z-40"
                      style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.9) 0%, transparent 70%)' }}
                    />
                  )}
                </AnimatePresence>
                {multiBotActive && activeBots.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {activeBots.map((bot, idx) => (
                      <ThemedTooltip key={bot.id} content={`Force @${bot.session?.username ?? bot.id}`}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            playForceBurstSfx();
                            setBurstKey((k) => k + 1);
                            setBurstIntensity((i) => Math.min(i + 1, 5));
                            window.dispatchEvent(new CustomEvent("autoforge-force-check", { detail: { botId: bot.id } }));
                            setTimeout(() => setBurstIntensity(0), 30000);
                          }}
                          className={forceBtnClass}
                        >
                          #{idx + 1}
                        </button>
                      </ThemedTooltip>
                    ))}
                  </div>
                ) : (
                  <ThemedTooltip content="Force check now">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        playForceBurstSfx();
                        setBurstKey((k) => k + 1);
                        setBurstIntensity((i) => Math.min(i + 1, 5));
                        window.dispatchEvent(new Event("autoforge-force-check"));
                        setTimeout(() => setBurstIntensity(0), 30000);
                      }}
                      className={cn("absolute bottom-2 right-2", forceBtnClass)}
                    >
                      Force
                    </button>
                  </ThemedTooltip>
                )}
                {/* Burst FX */}
                <AnimatePresence>
                  {burstKey > 0 && (
                    <motion.div
                      key={burstKey}
                      initial={{ opacity: 0.8, scale: 0 }}
                      animate={{ opacity: 0, scale: 3 + burstIntensity * 0.5 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                      className="absolute bottom-3.5 right-3.5 w-2 h-2 rounded-full pointer-events-none z-50"
                      style={{
                        background: burstIntensity >= 3
                          ? 'radial-gradient(circle, rgba(239,68,68,0.8) 0%, rgba(168,85,247,0.4) 50%, transparent 70%)'
                          : burstIntensity >= 1
                          ? 'radial-gradient(circle, rgba(168,85,247,0.8) 0%, rgba(168,85,247,0.3) 50%, transparent 70%)'
                          : 'radial-gradient(circle, rgba(168,85,247,0.6) 0%, transparent 60%)',
                        boxShadow: burstIntensity >= 2
                          ? '0 0 20px 4px rgba(239,68,68,0.6)'
                          : '0 0 12px 2px rgba(168,85,247,0.5)',
                      }}
                    />
                  )}
                </AnimatePresence>
                {burstKey > 0 && (
                  <motion.div
                    key={`ring-${burstKey}`}
                    initial={{ opacity: 0.6, scale: 0.5, border: '1px solid rgba(168,85,247,0.8)' }}
                    animate={{ opacity: 0, scale: 4 + burstIntensity }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    className="absolute bottom-3.5 right-3.5 w-6 h-6 rounded-full pointer-events-none z-40 border border-purple-400/60"
                  />
                )}
              </div>
            </div>

            {/* Engagement Score & Stream Status */}
            <div className="flex flex-col gap-2 p-2.5 bg-black/40 rounded border border-white/5">
              <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                <TrendingUp className="w-3 h-3 text-green-400" /> Engagement Score
              </span>
              {engagementScore ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className={cn("text-lg font-mono font-bold", engagementScore.overall >= 60 ? "text-green-400" : engagementScore.overall >= 30 ? "text-yellow-400" : "text-gray-500")}>
                      {engagementScore.overall}
                    </span>
                    <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div className={cn("h-full transition-all duration-1000", engagementScore.overall >= 60 ? "bg-green-500" : engagementScore.overall >= 30 ? "bg-yellow-500" : "bg-gray-600")} style={{ width: `${engagementScore.overall}%` }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1 text-[8px] font-mono text-gray-500">
                    <div className="flex flex-col items-center"><span className="text-gray-600">VEL</span><span className="text-gray-400">{engagementScore.velocityScore}</span></div>
                    <div className="flex flex-col items-center"><span className="text-gray-600">SENT</span><span className="text-gray-400">{engagementScore.sentimentScore}</span></div>
                    <div className="flex flex-col items-center"><span className="text-gray-600">DIV</span><span className="text-gray-400">{engagementScore.diversityScore}</span></div>
                    <div className="flex flex-col items-center"><span className="text-gray-600">REC</span><span className="text-gray-400">{engagementScore.recencyScore}</span></div>
                  </div>
                </>
              ) : (
                <span className="text-[10px] text-gray-600 font-mono">Awaiting data...</span>
              )}
              {streamLikelyOffline && (
                <div className="flex items-center gap-1.5 mt-1 pt-1.5 border-t border-white/5">
                  <Radio className="w-3 h-3 text-red-400 animate-pulse" />
                  <span className="text-[9px] text-red-400 font-mono font-bold uppercase">Stream appears offline</span>
                </div>
              )}
            </div>

            {/* Cooldown & Rate Limit Visual */}
            <RateLimitIndicator />

            {/* Context Token Budget */}
            <div className="flex flex-col gap-2 p-2.5 bg-black/40 rounded border border-white/5">
              <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                <Zap className="w-3 h-3 text-yellow-400" /> Context Token Budget
              </span>
              <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-[10px]">
                  <span className="text-gray-400 uppercase">Tokens</span>
                  <span className="text-gray-200 font-mono">{config.autoForgeContextTokens ?? 4000}</span>
                </div>
                <input
                  type="range"
                  min="500"
                  max="8192"
                  step="1"
                  value={config.autoForgeContextTokens ?? 4000}
                  onChange={(e) => updateConfig({ autoForgeContextTokens: parseInt(e.target.value, 10) })}
                  className="w-full h-1 accent-yellow-400 cursor-pointer"
                />
                <div className="flex justify-between text-[8px] text-gray-600 font-mono">
                  <span>500</span>
                  <span>8192</span>
                </div>
              </div>
            </div>

            {/* Dry Run Toggle & Confidence Threshold */}
            <div data-tutorial="dry-run" className="flex flex-col gap-1.5 p-2 bg-black/40 rounded border border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                    <FlaskConical className="w-3 h-3 text-cyan-400" /> Dry Run Mode
                  </span>
                  <ThemedTooltip
                    side="right"
                    content={
                      <div className="max-w-[220px] space-y-1">
                        <div className="font-bold text-cyan-300">Dry Run Mode</div>
                        <div>When ON, AutoForge runs its full decision pipeline but <span className="text-cyan-300 font-semibold">never sends messages</span> to chat.</div>
                        <div className="text-gray-400">Use it to preview what the bot would say, tune confidence thresholds, and test personas without spamming your channel.</div>
                      </div>
                    }
                  >
                    <HelpCircle className="w-3 h-3 text-gray-600 hover:text-cyan-400 transition-colors cursor-help" />
                  </ThemedTooltip>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); setDryRunExpanded(v => !v); playSfx('panel_collapse'); }}
                    className={cn("p-0.5 rounded transition-colors", dryRunExpanded ? "text-cyan-400 bg-cyan-500/10" : "text-gray-500 hover:text-white hover:bg-white/10")}
                  >
                    <ChevronDown className={cn("w-3 h-3 transition-transform", dryRunExpanded && "rotate-180")} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setAutoForgeDryRun(!autoForgeDryRun); playSfx(autoForgeDryRun ? 'autoforge_off' : 'autoforge_on'); }}
                    className={cn("text-[8px] px-2 py-0.5 rounded font-mono uppercase transition-colors", autoForgeDryRun ? "bg-cyan-500/30 text-cyan-200" : "bg-white/5 text-gray-500 hover:bg-white/10")}
                  >
                    {autoForgeDryRun ? "ON" : "OFF"}
                  </button>
                </div>
              </div>
              <AnimatePresence>
                {dryRunExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="flex flex-col gap-1 pt-1 border-t border-white/5 overflow-hidden"
                  >
                    <div className="flex justify-between items-center text-[10px]">
                      <span className="text-gray-400 uppercase">Confidence Threshold</span>
                      <span className="text-gray-200 font-mono">{Math.round(autoForgeConfidenceThreshold * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={autoForgeConfidenceThreshold}
                      onChange={(e) => setAutoForgeConfidenceThreshold(parseFloat(e.target.value))}
                      className="w-full h-1 accent-cyan-400 cursor-pointer"
                    />
                    <div className="flex justify-between text-[8px] text-gray-600 font-mono">
                      <span>0%</span>
                      <span>100%</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Last Decision Details */}
            <div className="flex flex-col">
              <div className="flex items-center justify-between mb-2 ml-1">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase">
                  {viewingHistory ? "Decision History" : "Previous Cycle Decision"}
                </span>
                {historyLen > 0 && (
                  <div className="flex items-center gap-1">
                    <ThemedTooltip content="Older decision (Q)">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setHistoryOffset((o) => o + 1); }}
                        disabled={clampedOffset >= historyLen - 1}
                        className="p-0.5 rounded text-gray-400 hover:text-cyan-300 hover:bg-cyan-500/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronDown className="w-3 h-3 rotate-90" />
                      </button>
                    </ThemedTooltip>
                    <span className="text-[9px] text-gray-500 font-mono font-bold tabular-nums">
                      {clampedOffset + 1}/{historyLen}
                    </span>
                    <ThemedTooltip content="Newer decision (E)">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setHistoryOffset((o) => Math.max(0, o - 1)); }}
                        disabled={clampedOffset <= 0}
                        className="p-0.5 rounded text-gray-400 hover:text-cyan-300 hover:bg-cyan-500/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronDown className="w-3 h-3 -rotate-90" />
                      </button>
                    </ThemedTooltip>
                  </div>
                )}
              </div>
              
              <div className="flex flex-col p-2.5 bg-blue-500/10 border border-blue-500/20 rounded gap-2 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-1 px-2 bg-blue-500/20 rounded-bl-lg">
                  <span className="text-[9px] text-blue-300 font-mono font-bold">CONF: {Math.round(confidence * 100)}%</span>
                </div>
                <span className="text-[10px] font-mono text-blue-400 font-bold uppercase">{decisionType}</span>
                {multiBotActive && decisionBotUsername && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn(
                      "text-[9px] font-mono font-bold rounded px-1.5 py-0.5 border",
                      wasActuallySent
                        ? "text-[#c79bff] bg-[#9146FF]/15 border-[#9146FF]/30"
                        : "text-amber-300 bg-amber-500/10 border-amber-500/30",
                    )}>
                      {wasActuallySent ? 'Sent by' : 'Unsent ·'} @{decisionBotUsername}
                    </span>
                    {typeof decisionPersonaFit === 'number' && (
                      <ThemedTooltip content="How well this bot's persona fits the moment (0–100%). Mentioned bots get +30%.">
                        <span className="text-[9px] font-mono text-gray-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                          FIT {Math.round(decisionPersonaFit * 100)}%
                        </span>
                      </ThemedTooltip>
                    )}
                    {decisionWasMentioned && (
                      <span className="text-[9px] font-mono text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded px-1.5 py-0.5">
                        @MENTIONED
                      </span>
                    )}
                  </div>
                )}
                <p className="text-xs text-gray-300 leading-relaxed italic pr-4">"{decisionReason}"</p>

                {effectiveDecision?.action_payload && (
                  <div className="mt-1 p-2 bg-black/50 rounded border border-white/5 text-[10px] font-mono text-white break-words">
                    {effectiveDecision.action_payload}
                  </div>
                )}

                {/* Manual send button — shown when the bot decided to act but
                    the message was never sent (preempted, queue timeout, lost
                    floor, etc.). Lets the user salvage the decision. */}
                {showSendButton && (
                  <button
                    type="button"
                    disabled={sendingPayload}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (sendingPayload) return;
                      setSendingPayload(true);
                      try {
                        const channel = useAppStore.getState().streamMetadata.channelName;
                        if (!channel) {
                          toast.error("Set a channel before sending.");
                          return;
                        }
                        await sendManualMessage({
                          message: safeActionPayload,
                          channel,
                          botId: decisionBot?.id,
                          source: "manual",
                        });
                        playSfx("forge_complete");
                        toast.success(`Sent${decisionBot ? ` as @${decisionBot.session?.username}` : ""}`, {
                          description: safeActionPayload.slice(0, 60),
                        });
                      } catch (err: any) {
                        toast.error("Send failed", { description: err?.message || String(err) });
                      } finally {
                        setSendingPayload(false);
                      }
                    }}
                    className={cn(
                      "mt-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded text-[10px] font-mono font-bold uppercase transition-colors border",
                      sendingPayload
                        ? "bg-white/5 border-white/10 text-gray-500 cursor-wait"
                        : "bg-emerald-500/20 hover:bg-emerald-500/40 border-emerald-500/30 text-emerald-300 hover:text-emerald-200",
                    )}
                  >
                    {sendingPayload ? (
                      <>
                        <span className="w-3 h-3 border border-emerald-400/40 border-t-emerald-300 rounded-full animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Send className="w-3 h-3" />
                        Send Now
                        <kbd className="ml-1 text-[8px] font-mono bg-emerald-500/20 border border-emerald-500/30 rounded px-1 py-0.5 text-emerald-200/80">W</kbd>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Follow-up Message Delivered */}
            <AnimatePresence>
              {autoForgeFollowup && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="flex flex-col overflow-hidden"
                >
                  <span className="text-[9px] text-purple-400 font-bold tracking-wider uppercase mb-2 ml-1 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" /> Follow-Up Delivered
                  </span>
                  <div className="flex flex-col p-2.5 bg-purple-500/10 border border-purple-500/30 rounded gap-2 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-1 px-2 bg-purple-500/20 rounded-bl-lg">
                      <span className="text-[9px] text-purple-300 font-mono font-bold">
                        {Math.round((now - autoForgeFollowup.deliveredAt) / 1000)}s ago
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Zap className="w-3 h-3 text-purple-400" />
                      <span className="text-[10px] font-mono text-purple-400 font-bold uppercase">Quick Follow-Up</span>
                    </div>
                    <div className="p-2 bg-black/50 rounded border border-white/5 text-[10px] font-mono text-white break-words">
                      {typeof autoForgeFollowup.message === "string" ? autoForgeFollowup.message : ""}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Single-bot Director Note input — only shown when multi-bot is
                OFF (multi-bot mode has its own DirectorNoteInput in the
                MultiBotPanel). Lets the streamer send private directives that
                are injected into the bot's next AutoForge decision. */}
            {!multiBotActive && <SingleBotDirectorNoteInput />}

          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Single-bot Director Note Input ─────────────────────────────────────────
// Mirrors the multi-bot DirectorNoteInput but targets the legacy single-bot
// store actions. Shown at the bottom of the expanded AutoForgeHUD when multi-
// bot mode is disabled. Notes are private — never sent to chat.
// Shared primitives (durations, expiry formatter, chip component) live in
// directorNoteShared.tsx.

function SingleBotDirectorNoteInput() {
  const directorNotes = useAppStore((s) => s.directorNotes);
  const addDirectorNote = useAppStore((s) => s.addDirectorNote);
  const removeDirectorNote = useAppStore((s) => s.removeDirectorNote);
  const reorderDirectorNotes = useAppStore((s) => s.reorderDirectorNotes);
  const addAutoForgeEvent = useAppStore((s) => s.addAutoForgeEvent);
  const [text, setText] = useState("");
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [showActive, setShowActive] = useState(false);

  const now = Date.now();
  const activeNotes = (directorNotes || [])
    .filter((n) => n.expiresAt == null || n.expiresAt > now)
    .slice(-8);
  const activeNoteIds = activeNotes.map((n) => n.id);

  const handleSend = () => {
    const message = text.trim();
    if (!message) return;
    addDirectorNote(message, durationMs);
    addAutoForgeEvent({
      timestamp: Date.now(),
      type: "director_note",
      severity: "high",
      summary: directorNoteSummary(message, durationMs),
      details: { source: "director", message, durationMs },
    });
    toast.success("Director note sent", {
      description: durationMs
        ? `Active for ${DIRECTOR_NOTE_DURATIONS.find((d) => d.ms === durationMs)?.label}.`
        : "Active until manually canceled.",
    });
    setText("");
  };

  return (
    <div className="shrink-0 border-t border-white/10 bg-gradient-to-b from-purple-950/20 to-black/30 p-2 flex flex-col gap-1.5 mt-1">
      <div className="flex items-center gap-1.5">
        <Megaphone className="w-3 h-3 text-purple-400 shrink-0" />
        <span className="text-[9px] uppercase tracking-wider text-purple-400 font-bold shrink-0">Director Note</span>
        <ThemedTooltip
          side="top"
          content={
            <div className="max-w-[220px] space-y-1">
              <div className="font-bold text-purple-300">Director Notes</div>
              <div>Private directives to your bot. <span className="text-purple-300 font-semibold">Never sent to chat</span> — injected into the bot's next AutoForge decision as a high-priority directive.</div>
              <div className="text-gray-400">Use for feedback, status updates, or things you want the bot to remember mid-stream. Timed notes auto-expire; "Until canceled" notes persist until you dismiss them.</div>
            </div>
          }
        >
          <span className="text-gray-600 hover:text-purple-400 transition-colors cursor-help text-[10px]">?</span>
        </ThemedTooltip>
        <button
          onClick={() => setShowActive((v) => !v)}
          className="ml-auto shrink-0 text-[9px] px-1.5 py-1 rounded border border-white/10 text-purple-300 hover:bg-purple-500/10 hover:border-purple-500/40 transition-colors"
          title={showActive ? "Hide active notes" : "Show active notes"}
        >
          {activeNotes.length > 0 ? `${activeNotes.length} active` : "none active"}
        </button>
      </div>
      <div className="flex items-stretch gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Direct your bot — e.g. 'tone it down', 'the raid is starting soon', 'remember this user likes X'…"
          rows={2}
          className="flex-1 min-w-0 resize-none text-[11px] leading-snug bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white outline-none focus:border-purple-500/50 placeholder:text-gray-600 forge-scroll"
        />
        <div className="flex flex-col gap-1 shrink-0">
          <select
            value={durationMs ?? "null"}
            onChange={(e) => setDurationMs(e.target.value === "null" ? null : Number(e.target.value))}
            className="text-[9px] bg-black/40 border border-white/10 rounded px-1 py-1 text-purple-300 outline-none focus:border-purple-500/50 w-[72px]"
            title="How long the note stays active"
          >
            {DIRECTOR_NOTE_DURATIONS.map((d) => (
              <option key={d.label} value={d.ms ?? "null"} className="bg-[#0F0F12] text-white">{d.label}</option>
            ))}
          </select>
          <ThemedTooltip content="Send director note (Enter)">
            <button
              onClick={handleSend}
              disabled={text.trim().length === 0}
              className={cn(
                "flex-1 flex items-center justify-center rounded-md border transition-colors",
                text.trim().length === 0
                  ? "bg-white/5 border-white/10 text-gray-600 cursor-not-allowed"
                  : "bg-purple-600 border-purple-500/60 text-white hover:bg-purple-500",
              )}
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
        </div>
      </div>
      {showActive && (
        activeNotes.length === 0 ? (
          <div className="text-[10px] text-gray-600 italic px-1 py-0.5">No active notes.</div>
        ) : (
          <Reorder.Group
            axis="y"
            values={activeNoteIds}
            onReorder={(newOrder) => reorderDirectorNotes(newOrder)}
            className="flex flex-col gap-1 max-h-32 overflow-y-auto forge-scroll"
          >
            {activeNotes.map((n, i) => (
              <Reorder.Item key={n.id} value={n.id} className="list-none cursor-grab active:cursor-grabbing">
                <DirectorNoteChip
                  text={n.text}
                  expiresAt={n.expiresAt}
                  onRemove={() => removeDirectorNote(n.id)}
                  priority={priorityBadge(i)}
                  draggable
                />
              </Reorder.Item>
            ))}
          </Reorder.Group>
        )
      )}
    </div>
  );
}
