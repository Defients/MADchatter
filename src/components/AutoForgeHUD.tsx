import React, { useEffect, useState } from 'react';
import { useAppStore, selectMultiBotActive } from '../store';
import type { Bot } from '../types';
import { Activity, Brain, Clock, Zap, X, Minimize2, Maximize2, Sparkles, ScrollText, Gauge, Rows3, FlaskConical, Radio, TrendingUp } from 'lucide-react';
import { cn } from '../lib/utils';
import { playSfx, playForceBurstSfx } from '../lib/sfx';
import { actionRateLimiter } from '../lib/actionRateLimiter';
import { motion, AnimatePresence } from 'motion/react';
import { ThemedTooltip } from './ui/tooltip';

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
  } = useAppStore();
  const multiBotActive = useAppStore(selectMultiBotActive);

  const [now, setNow] = useState(Date.now());
  const [burstKey, setBurstKey] = useState(0);
  const [burstIntensity, setBurstIntensity] = useState(0);
  const [minimized, setMinimized] = useState(true);
  const [liteView, setLiteView] = useState(false);

  useEffect(() => {
    if (!isAutoForgeHUDOpen) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isAutoForgeHUDOpen]);

  useEffect(() => {
    const onExpand = () => {
      setMinimized(false);
      setLiteView(false);
    };
    window.addEventListener("tutorial-expand-hud", onExpand);
    return () => window.removeEventListener("tutorial-expand-hud", onExpand);
  }, []);

  if (!isAutoForgeHUDOpen) return null;

  // In multi-bot mode the legacy global pacing fields are NOT updated (the
  // legacy loop stands down). Derive next/last/decision from per-bot runtimes
  // so the HUD's NEXT CHECK timer and decision card stay accurate.
  const activeBots = multiBotActive ? bots.filter((b) => b.active && b.session) : [];

  const rawNext = multiBotActive
    ? activeBots.reduce<number>((min, b) => Math.min(min, b.runtime.autoForgeNextActionMs), Infinity)
    : (autoForgeNextActionMs ?? 0);
  const effectiveNextActionMs = rawNext === Infinity ? 0 : rawNext;

  const effectiveLastActionMs = multiBotActive
    ? activeBots.reduce<number>((max, b) => Math.max(max, b.runtime.autoForgeLastActionMs ?? 0), 0)
    : (autoForgeLastActionMs ?? 0);

  // Most recent decision across bots (by timestamp), plus the bot that owns it
  // so the card can show who was chosen to speak and why.
  let effectiveDecision = lastAutoForgeDecision;
  let decisionBot: Bot | null = null;
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
    }
  }

  const timeSinceLast = effectiveLastActionMs
    ? Math.max(0, Math.floor((now - effectiveLastActionMs) / 1000))
    : 0;

  const timeUntilNext = effectiveNextActionMs
    ? Math.max(0, Math.floor((effectiveNextActionMs - now) / 1000))
    : 0;

  const decisionType = effectiveDecision?.decision || 'None';
  const decisionReason = effectiveDecision?.reason || 'Waiting for initial signal check...';
  const confidence = effectiveDecision?.confidence || 0;
  const activityLevel = effectiveDecision?.activityLevel || 0;

  // Multi-bot "why chosen" context for the decision card.
  const decisionBotUsername = decisionBot?.session?.username ?? null;
  const decisionPersonaFit = effectiveDecision?.personaFit;
  const decisionWasMentioned = effectiveDecision?.isMentioned === true;
  const decisionWasSent = decisionType !== 'None' && decisionType !== 'deliberate_silence' && decisionType !== 'meta_observation' && !!effectiveDecision?.action_payload;
  
  return (
    <motion.div
      drag
      dragMomentum={false}
      dragElastic={0.1}
      data-tutorial="autoforge-hud"
      initial={{ opacity: 0, scale: 0.9, y: -50 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: -50 }}
      className="fixed z-50 top-5 right-5 flex flex-col bg-[#121217]/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl overflow-hidden cursor-move"
      style={{ width: 330 }}
    >
      {/* Header (Drag Handle) */}
      <div className="flex items-center justify-between p-2.5 border-b border-white/10 bg-black/40">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center">
            <Brain className={cn("w-4 h-4 relative z-10", autoForgeEnabled ? "text-red-500" : "text-gray-500")} />
            {autoForgeEnabled && (
              <span className="absolute w-4 h-4 bg-red-500/30 rounded-full animate-ping" />
            )}
          </div>
          <span data-tutorial="autoforge-header" className="font-mono text-xs font-bold tracking-widest text-gray-300 uppercase">
            AutoForge{autoForgeDryRun && <span className="text-cyan-400 ml-1">·DRY</span>}
          </span>
        </div>
        <div className="flex items-center gap-1">
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
            className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
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
            <div className="flex items-center justify-between p-2 bg-white/5 rounded border border-white/5 relative">
              <div className="flex flex-col">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-purple-400" /> Next Check
                </span>
                <span className="text-xs font-mono text-purple-300 font-bold mt-0.5">
                  {timeUntilNext}s
                </span>
              </div>
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
                  className="text-[8px] bg-purple-500/20 hover:bg-purple-500/40 text-purple-200 px-1.5 py-0.5 rounded font-mono uppercase transition-colors"
                >
                  Force
                </button>
              </ThemedTooltip>
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
                {effectiveDecision?.action_payload && (
                  <div className="mt-1 p-2 bg-black/50 rounded border border-white/5 text-[10px] font-mono text-white break-words">
                    {effectiveDecision.action_payload}
                  </div>
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

              <div className="flex flex-col p-2 bg-white/5 rounded border border-white/5 relative">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-purple-400" /> Next Check
                </span>
                <span className="text-xs font-mono text-purple-300 font-bold mt-0.5">
                  {timeUntilNext}s
                </span>
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
                    className="absolute bottom-2 right-2 text-[8px] bg-purple-500/20 hover:bg-purple-500/40 text-purple-200 px-1.5 py-0.5 rounded font-mono uppercase transition-colors"
                  >
                    Force
                  </button>
                </ThemedTooltip>
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
                  max="8000"
                  step="500"
                  value={config.autoForgeContextTokens ?? 4000}
                  onChange={(e) => updateConfig({ autoForgeContextTokens: parseInt(e.target.value, 10) })}
                  className="w-full h-1 accent-yellow-400 cursor-pointer"
                />
                <div className="flex justify-between text-[8px] text-gray-600 font-mono">
                  <span>500</span>
                  <span>8K</span>
                </div>
              </div>
            </div>

            {/* Dry Run Toggle & Confidence Threshold */}
            <div className="flex flex-col gap-1.5 p-2 bg-black/40 rounded border border-white/5">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase flex items-center gap-1.5">
                  <FlaskConical className="w-3 h-3 text-cyan-400" /> Dry Run Mode
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); setAutoForgeDryRun(!autoForgeDryRun); playSfx(autoForgeDryRun ? 'autoforge_off' : 'autoforge_on'); }}
                  className={cn("text-[8px] px-2 py-0.5 rounded font-mono uppercase transition-colors", autoForgeDryRun ? "bg-cyan-500/30 text-cyan-200" : "bg-white/5 text-gray-500 hover:bg-white/10")}
                >
                  {autoForgeDryRun ? "ON" : "OFF"}
                </button>
              </div>
              <div className="flex flex-col gap-1 pt-1 border-t border-white/5">
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
              </div>
            </div>

            {/* Last Decision Details */}
            <div className="flex flex-col">
              <span className="text-[9px] text-gray-500 font-bold tracking-wider uppercase mb-2 ml-1">Previous Cycle Decision</span>
              
              <div className="flex flex-col p-2.5 bg-blue-500/10 border border-blue-500/20 rounded gap-2 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-1 px-2 bg-blue-500/20 rounded-bl-lg">
                  <span className="text-[9px] text-blue-300 font-mono font-bold">CONF: {Math.round(confidence * 100)}%</span>
                </div>
                <span className="text-[10px] font-mono text-blue-400 font-bold uppercase">{decisionType}</span>
                {multiBotActive && decisionBotUsername && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[9px] font-mono font-bold text-[#c79bff] bg-[#9146FF]/15 border border-[#9146FF]/30 rounded px-1.5 py-0.5">
                      {decisionWasSent ? 'Sent by' : 'Decided by'} @{decisionBotUsername}
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
                      {autoForgeFollowup.message}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
