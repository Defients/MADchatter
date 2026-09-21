import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { sendGuard } from '../lib/twitch';
import { kickSendManager } from '../lib/kick';
import { joystickSendManager } from '../lib/joystick';
import { playSfx } from '../lib/sfx';
import { SENTIMENT_DOT_COLORS } from '../lib/sentiment';
import type { SentimentLabel } from '../types';
import { ThemedTooltip } from "./ui/tooltip";
import { useStudioAvailable, useEffectiveMode } from '../hooks/useMediaQuery';
import { useNowTick, subscribeSecondTick } from '../hooks/useNowTick';
import { selectMergedSentMessages } from '../lib/sentHistory';
import { SentMessageHistory } from './SentMessageHistory';
import {
  Wifi,
  WifiOff,
  Send,
  MessageSquare,
  Flame,
  Clock,
  ChevronDown,
  ChevronUp,
  History,
  GripHorizontal,
} from 'lucide-react';

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function StatusBar() {
  const {
    sessionStats,
    tmiReadState,
    tmiSendState,
    sentMessages,
    clearSentMessages,
    streamMetadata,
    enhancedStats,
    analyticsPanelOpen,
    setAnalyticsPanelOpen,
    sentimentSummary,
    messageQueueDepth,
    audioEnergy,
    streamHealth,
    bots,
  } = useAppStore(useShallow((s) => ({
    sessionStats: s.sessionStats,
    tmiReadState: s.tmiReadState,
    tmiSendState: s.tmiSendState,
    sentMessages: s.sentMessages ?? [],
    clearSentMessages: s.clearSentMessages,
    streamMetadata: s.streamMetadata,
    enhancedStats: s.enhancedStats,
    analyticsPanelOpen: s.analyticsPanelOpen,
    setAnalyticsPanelOpen: s.setAnalyticsPanelOpen,
    sentimentSummary: s.sentimentSummary,
    messageQueueDepth: s.messageQueueDepth,
    audioEnergy: s.audioEnergy,
    streamHealth: s.streamHealth,
    bots: s.bots ?? [],
  })));

  const platform = useAppStore((s) => s.platform);

  // Mobile Core: narrow viewport in core mode. The sent log header absorbs
  // the rate counter and becomes the drag handle to expand the log to the
  // top of the screen (the tiny 5px resize handle is hard to grab on a phone).
  // NOTE: both hooks must be called unconditionally — `useEffectiveMode` is a
  // hook (it calls useAppStore + useStudioAvailable). Chaining it behind a
  // `&&` short-circuit would change the hook count between renders and trip
  // React's "Should have a queue" invariant.
  const studioAvailable = useStudioAvailable();
  const effectiveMode = useEffectiveMode();
  const isMobileCore = !studioAvailable && effectiveMode === 'core';

  // Shared app clock — feeds the session-duration label (hooks/useNowTick).
  const now = useNowTick();
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [rateUsed, setRateUsed] = useState(0);
  const [rateMax, setRateMax] = useState(20);
  const [dragHeight, setDragHeight] = useState<number | null>(() => {
    const saved = localStorage.getItem('forge-statusbar-log-height');
    const parsed = saved ? parseFloat(saved) : NaN;
    return Number.isFinite(parsed) && parsed >= 108 ? parsed : null;
  });
  const [isDragging, setIsDragging] = useState(false);
  // Mobile Core: double-tap the grip handle to horizontally collapse the
  // status info (everything right of the grip). Toggled only by double-tap;
  // a single tap/drag still repositions the bar. Persisted per session.
  const [infoCollapsed, setInfoCollapsed] = useState(() => {
    try { return localStorage.getItem('forge-statusbar-collapsed') === '1'; } catch { return false; }
  });
  const lastTapRef = useRef(0);
  const [dockX, setDockX] = useState(() => {
    const saved = localStorage.getItem('forge-statusbar-x');
    const value = Number(saved);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const [dockY, setDockY] = useState(() => {
    const saved = localStorage.getItem('forge-statusbar-y');
    const value = Number(saved);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  });
  const dragRef = useRef<{ startX: number; startY: number; startDockX: number; startDockY: number } | null>(null);

  // Conditional status segments — only the separator before each is shown if the segment is active
  // Defensive: store fields can be undefined during state transitions / migrations.
  const showAutoForge = !!(enhancedStats && enhancedStats.autoForgeActions > 0);
  const showAudio = !!audioEnergy;
  const showHealth = !!streamHealth;
  const showSentiment = !!sentimentSummary && !!(sentimentSummary.readings && sentimentSummary.readings.length > 0);
  const showQueue = messageQueueDepth > 0;
  const showAudioHealth = showAudio || showHealth;
  const showSentimentQueue = showSentiment || showQueue;
  const dockRef = useRef<HTMLDivElement>(null);
  // A saved position from a wider/smaller display must never hide the dock.
  useEffect(() => {
    const clampDock = () => {
      const width = dockRef.current?.offsetWidth ?? 0;
      const height = dockRef.current?.offsetHeight ?? 0;
      setDockX(x => Math.max(0, Math.min(x, Math.max(0, window.innerWidth - width))));
      setDockY(y => Math.max(0, Math.min(y, Math.max(0, window.innerHeight - height))));
    };
    const observer = new ResizeObserver(clampDock);
    if (dockRef.current) observer.observe(dockRef.current);
    window.addEventListener('resize', clampDock);
    clampDock();
    return () => { observer.disconnect(); window.removeEventListener('resize', clampDock); };
  }, []);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const DEFAULT_LOG_HEIGHT = 256; // max-h-64 = 16rem = 256px

  const startResize = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const currentHeight = dragHeight ?? DEFAULT_LOG_HEIGHT;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    resizeRef.current = { startY: clientY, startHeight: currentHeight };
    setIsDragging(true);
    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!resizeRef.current) return;
      const cy = 'touches' in ev ? ev.touches[0].clientY : (ev as MouseEvent).clientY;
      const dy = resizeRef.current.startY - cy;
      const newHeight = Math.max(108, Math.min(window.innerHeight - 48, resizeRef.current.startHeight + dy));
      setDragHeight(newHeight);
    };
    const onUp = () => {
      resizeRef.current = null;
      setIsDragging(false);
      // Persist the dragged height so the log stays where the user left it.
      setDragHeight((h) => {
        if (h != null) localStorage.setItem('forge-statusbar-log-height', h.toString());
        return h;
      });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }, [dragHeight]);

  // Local send-rate read. getRateStatus() prunes the manager's window as a
  // side effect — it is a read-with-maintenance, not a pure getter — so it
  // must not run during render. It rides the shared 1s clock (useNowTick)
  // instead of owning an interval, and re-reads whenever the platform changes.
  useEffect(() => {
    const readRate = () => {
      const rateStatus = platform === 'kick' ? kickSendManager.getRateStatus() : platform === 'joystick' ? joystickSendManager.getRateStatus() : sendGuard.getRateStatus();
      setRateUsed(rateStatus.used);
      setRateMax(rateStatus.max);
    };
    readRate();
    return subscribeSecondTick(readRate);
  }, [platform]);

  useEffect(() => {
    localStorage.setItem('forge-statusbar-x', dockX.toString());
  }, [dockX]);

  useEffect(() => {
    localStorage.setItem('forge-statusbar-y', dockY.toString());
  }, [dockY]);

  useEffect(() => {
    try { localStorage.setItem('forge-statusbar-collapsed', infoCollapsed ? '1' : '0'); } catch { /* private mode */ }
  }, [infoCollapsed]);

  // Merge global sentMessages with per-bot runtime.sentMessages so the log
  // shows multi-bot activity. Per-bot sends go to bots[].runtime.sentMessages,
  // not the global sentMessages list, so without this merge the log stays
  // empty in multi-bot mode.
  const allSent = useMemo(
    () => selectMergedSentMessages(sentMessages, bots),
    [sentMessages, bots],
  );

  const startDrag = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    // Double-tap on the grip (mobile core only) toggles horizontal collapse
    // of the status info. Detected before drag setup so the second tap never
    // starts a drag. A single tap still falls through to the drag handler
    // (which is a no-op without pointer movement).
    if (isMobileCore) {
      const t = Date.now();
      if (t - lastTapRef.current < 320) {
        lastTapRef.current = 0;
        setInfoCollapsed((c) => !c);
        playSfx('history_toggle');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      lastTapRef.current = t;
    }
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragRef.current = { startX: clientX, startY: clientY, startDockX: dockX, startDockY: dockY };
    const onMove = (ev: MouseEvent | TouchEvent) => {
      if (!dragRef.current || !dockRef.current) return;
      const ex = 'touches' in ev ? ev.touches[0].clientX : (ev as MouseEvent).clientX;
      const ey = 'touches' in ev ? ev.touches[0].clientY : (ev as MouseEvent).clientY;
      const dx = ex - dragRef.current.startX;
      // Dragging up (ey < startY) raises the bar: bottom offset increases.
      const dy = dragRef.current.startY - ey;
      const dockWidth = dockRef.current.offsetWidth;
      const dockHeight = dockRef.current.offsetHeight;
      const maxX = Math.max(0, window.innerWidth - dockWidth);
      const maxY = Math.max(0, window.innerHeight - dockHeight);
      setDockX(Math.max(0, Math.min(maxX, dragRef.current.startDockX + dx)));
      setDockY(Math.max(0, Math.min(maxY, dragRef.current.startDockY + dy)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }, [dockX, dockY, isMobileCore]);

  const sessionDuration = now - (sessionStats?.sessionStart ?? now);



  const readColor = {
    connected: 'text-green-400',
    connecting: 'text-yellow-400 animate-pulse',
    disconnected: 'text-gray-600',
    error: 'text-red-400',
  }[tmiReadState];

  const sendColor = {
    connected: 'text-green-400',
    connecting: 'text-yellow-400 animate-pulse',
    disconnected: 'text-gray-600',
    error: 'text-red-400',
  }[tmiSendState];

  const handleClearHistory = () => {
    clearSentMessages();
    // Also clear per-bot sent messages so the merged log actually empties.
    const state = useAppStore.getState();
    for (const bot of state.bots) {
      state.clearBotSentMessages(bot.id);
    }
  };

  return (
    <>
      {/* Collapsible Status Bar — bottom-left, draggable (2D on touch) */}
      <div ref={dockRef} data-tutorial="statusbar" className="forge-status-dock fixed z-40 flex flex-col max-w-full touch-none" style={{ left: `${dockX}px`, bottom: `${dockY}px` }}>
        <AnimatePresence>
          {showHistory && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: dragHeight ?? 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={isDragging ? { duration: 0 } : { height: { duration: 0.3, ease: 'easeOut' }, opacity: { duration: 0.2 } }}
              className="overflow-hidden"
            >
              <div
                className="w-80 h-full max-h-[calc(100vh-48px)] bg-[#121217]/95 backdrop-blur-md border border-white/10 border-t-0 rounded-br-lg shadow-2xl flex flex-col"
              >
                {/* Drag-to-resize handle */}
                <ThemedTooltip content="Drag up to expand — height persists">
                  <div
                    onMouseDown={startResize}
                    className={cn(
                      "flex items-center justify-center h-5 cursor-row-resize select-none border-b border-white/5 bg-black/40 transition-colors",
                      isDragging ? "bg-white/10" : "hover:bg-white/5"
                    )}
                  >
                    <div className={cn("w-8 h-0.5 rounded-full transition-colors", isDragging ? "bg-white/40" : "bg-white/20")} />
                  </div>
                </ThemedTooltip>

                <div
                  onMouseDown={isMobileCore ? startResize : undefined}
                  onTouchStart={isMobileCore ? startResize : undefined}
                  className={cn(
                    "flex items-center justify-between px-3 py-2 border-b border-white/5 bg-black/40",
                    isMobileCore && "cursor-row-resize select-none touch-none",
                  )}
                >
                  <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 font-mono flex items-center gap-1.5">
                    <History className="w-3 h-3" /> Sent Message Log
                    {/* On mobile core, the rate counter lives here (moved out of
                        the status bar row to free up horizontal space). */}
                    {isMobileCore && (
                      <span className={cn('ml-1 text-[9px] font-mono font-bold', rateUsed >= 15 ? 'text-red-400' : rateUsed >= 10 ? 'text-yellow-400' : 'text-gray-500')}>
                        {rateUsed}/{rateMax}
                      </span>
                    )}
                  </span>
                </div>
                <SentMessageHistory messages={allSent} onClear={handleClearHistory} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status Bar */}
        <div className="forge-status-surface flex items-center gap-3 px-3 py-1.5 bg-[#121217]/95 backdrop-blur-md border border-white/10 border-b-0 rounded-tr-lg shadow-xl">
          {/* Drag Handle — 2D reposition (mouse + touch). On mobile core this
              is how the bar is lifted up/down the screen. */}
          <ThemedTooltip content={isMobileCore ? "Drag to reposition · Double-tap to collapse" : "Drag to reposition"}>
            <div
              onMouseDown={startDrag}
              onTouchStart={startDrag}
              className={cn(
                "flex items-center cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 transition-colors -ml-1.5 shrink-0",
                isMobileCore && "p-1.5 -m-1.5 touch-none",
              )}
            >
              <GripHorizontal className="w-4 h-4" />
            </div>
          </ThemedTooltip>

          {/* Status info — horizontally collapsible on mobile core via
              double-tap on the grip. Animated width + opacity. On desktop
              the bar is always fully expanded (infoCollapsed is ignored). */}
          <motion.div
            animate={isMobileCore && infoCollapsed ? { width: 0, opacity: 0 } : { width: 'auto', opacity: 1 }}
            transition={{ duration: 0.28, ease: 'easeInOut' }}
            className="flex items-center gap-3 overflow-hidden whitespace-nowrap min-w-0"
          >
          {/* Connection Indicators */}
          <div className="flex items-center gap-2">
            <ThemedTooltip content={`Chat Read: ${tmiReadState}`}>
              <div className="flex items-center gap-1">
                {tmiReadState === 'connected' ? (
                  <Wifi className={cn('w-3 h-3', readColor)} />
                ) : (
                  <WifiOff className={cn('w-3 h-3', readColor)} />
                )}
                <span className={cn('text-[9px] font-mono font-bold uppercase', readColor)}>RX</span>
              </div>
            </ThemedTooltip>
            <ThemedTooltip content={`Chat Send: ${tmiSendState}`}>
              <div className="flex items-center gap-1">
                <Send className={cn('w-3 h-3', sendColor)} />
                <span className={cn('text-[9px] font-mono font-bold uppercase', sendColor)}>TX</span>
              </div>
            </ThemedTooltip>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* Session Timer */}
          <ThemedTooltip content="Session duration">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-gray-500" />
              <span className="text-[9px] font-mono text-gray-400 font-bold">{formatDuration(sessionDuration)}</span>
            </div>
          </ThemedTooltip>

          <div className="w-px h-3 bg-white/10" />

          {/* Stats */}
          <div className="flex items-center gap-2.5">
            <ThemedTooltip content="Messages received">
              <div className="flex items-center gap-1">
                <MessageSquare className="w-3 h-3 text-teal-500" />
                <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats?.messagesReceived ?? 0}</span>
              </div>
            </ThemedTooltip>
            <ThemedTooltip content="Messages sent">
              <div className="flex items-center gap-1">
                <Send className="w-3 h-3 text-green-500" />
                <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats?.messagesSent ?? 0}</span>
              </div>
            </ThemedTooltip>
            <ThemedTooltip content="Forge batches">
              <div className="flex items-center gap-1">
                <Flame className="w-3 h-3 text-orange-500" />
                <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats?.forgeCount ?? 0}</span>
              </div>
            </ThemedTooltip>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* AutoForge Action Count */}
          {showAutoForge && (
            <ThemedTooltip content="AutoForge actions this session">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-mono text-indigo-400 font-bold">AF:{enhancedStats?.autoForgeActions ?? 0}</span>
              </div>
            </ThemedTooltip>
          )}

          {showAudioHealth && (showAutoForge ? <div className="w-px h-3 bg-white/10" /> : null)}

          {/* B9: Mini Audio Visualizer */}
          {showAudio && (
            <ThemedTooltip content={`Audio: ${audioEnergy.label} (RMS ${audioEnergy.rms.toFixed(2)})`}>
              <div className="flex items-center gap-1.5">
                <div className="flex items-end gap-0.5 h-3">
                  {[0, 1, 2, 3].map((i) => {
                    const baseHeight = (audioEnergy.rms * 100) * (0.5 + i * 0.2);
                    const height = Math.min(100, Math.max(8, baseHeight));
                    return (
                      <motion.div
                        key={i}
                        className={cn(
                          "w-0.5 rounded-full",
                          audioEnergy.label === "spike" ? "bg-red-400" :
                          audioEnergy.label === "loud" ? "bg-orange-400" :
                          audioEnergy.label === "normal" ? "bg-teal-400" :
                          audioEnergy.label === "quiet" ? "bg-blue-400" : "bg-gray-600"
                        )}
                        animate={{ height: `${height}%` }}
                        transition={{ duration: 0.15 }}
                  />
                    );
                  })}
                </div>
                <span className="text-[9px] font-mono text-gray-500 uppercase">{audioEnergy.label[0]}</span>
              </div>
            </ThemedTooltip>
          )}

          {showHealth && (
            <ThemedTooltip content={`Stream health: ${streamHealth.label} (${streamHealth.overall}/100)`}>
              <div className="flex items-center gap-1">
                <span className={cn(
                  "w-2 h-2 rounded-full",
                  streamHealth.label === "poppin" && "bg-green-400 animate-pulse",
                  streamHealth.label === "healthy" && "bg-teal-400",
                  streamHealth.label === "active" && "bg-blue-400",
                  streamHealth.label === "slow" && "bg-yellow-400",
                  streamHealth.label === "dead" && "bg-red-400",
                )} />
                <span className="text-[9px] font-mono text-gray-400 font-bold">{streamHealth.overall}</span>
              </div>
            </ThemedTooltip>
          )}

          {showSentimentQueue && (showAutoForge || showAudioHealth) && <div className="w-px h-3 bg-white/10" />}

          {/* Sentiment Indicator */}
          {showSentiment && (
            <ThemedTooltip content={`Chat sentiment: ${sentimentSummary.current} (${sentimentSummary.trend})`}>
              <div className="flex items-center gap-1">
                <span className={cn('w-2 h-2 rounded-full', SENTIMENT_DOT_COLORS[sentimentSummary.current as SentimentLabel])} />
                <span className="text-[9px] font-mono text-gray-400 font-bold uppercase">{sentimentSummary.current}</span>
                {sentimentSummary.trend === 'rising' && <span className="text-[8px] text-green-400">↑</span>}
                {sentimentSummary.trend === 'falling' && <span className="text-[8px] text-red-400">↓</span>}
              </div>
            </ThemedTooltip>
          )}

          {showQueue && (
            <ThemedTooltip content={`${messageQueueDepth} queued messages awaiting retry`}>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-mono text-yellow-400 font-bold">Q:{messageQueueDepth}</span>
              </div>
            </ThemedTooltip>
          )}

          {(showAutoForge || showAudioHealth || showSentimentQueue) && <div className="w-px h-3 bg-white/10" />}

          {/* Expand/Collapse History — placed left of the rate counter so it
              isn't the extreme edge-most control (easier to hit on mobile). */}
          <ThemedTooltip content={showHistory ? 'Hide sent log' : 'Show sent log'}>
            <button
              type="button"
              onClick={() => { setShowHistory(!showHistory); playSfx('history_toggle'); }}
              aria-label={showHistory ? 'Hide sent message log' : 'Show sent message log'}
              aria-expanded={showHistory}
              className="p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
            >
              {showHistory ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </ThemedTooltip>

          {/* Rate Limit Indicator — hidden on mobile core (moved into the sent
              log header to free up horizontal space in the bar). */}
          {!isMobileCore && (
            <ThemedTooltip content="Send rate limit (messages per 30s)">
              <div className="flex items-center gap-1">
                <span className={cn('text-[9px] font-mono font-bold', rateUsed >= 15 ? 'text-red-400' : rateUsed >= 10 ? 'text-yellow-400' : 'text-gray-500')}>
                  {rateUsed}/{rateMax}
                </span>
              </div>
            </ThemedTooltip>
          )}
          </motion.div>
        </div>
      </div>
    </>
  );
}
