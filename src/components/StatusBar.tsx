import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
  Trash2,
  Copy,
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

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const SOURCE_COLORS: Record<string, string> = {
  manual: 'text-green-400 bg-green-500/10 border-green-500/20',
  autoforge: 'text-red-400 bg-red-500/10 border-red-500/20',
  followup: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
};

const SOURCE_LABELS: Record<string, string> = {
  manual: 'MANUAL',
  autoforge: 'AUTOFORGE',
  followup: 'FOLLOWUP',
};

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
  } = useAppStore();

  const platform = useAppStore((s) => s.platform);

  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [rateUsed, setRateUsed] = useState(0);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dockX, setDockX] = useState(() => {
    const saved = localStorage.getItem('forge-statusbar-x');
    const value = Number(saved);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const dragRef = useRef<{ startX: number; startDockX: number } | null>(null);

  // Conditional status segments — only the separator before each is shown if the segment is active
  const showAutoForge = enhancedStats.autoForgeActions > 0;
  const showAudio = !!audioEnergy;
  const showHealth = !!streamHealth;
  const showSentiment = !!sentimentSummary && sentimentSummary.readings.length > 0;
  const showQueue = messageQueueDepth > 0;
  const showAudioHealth = showAudio || showHealth;
  const showSentimentQueue = showSentiment || showQueue;
  const dockRef = useRef<HTMLDivElement>(null);
  // A saved position from a wider display must never hide the dock.
  useEffect(() => {
    const clampDock = () => {
      const width = dockRef.current?.offsetWidth ?? 0;
      setDockX(x => Math.max(0, Math.min(x, window.innerWidth - width)));
    };
    const observer = new ResizeObserver(clampDock);
    if (dockRef.current) observer.observe(dockRef.current);
    window.addEventListener('resize', clampDock);
    clampDock();
    return () => { observer.disconnect(); window.removeEventListener('resize', clampDock); };
  }, []);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const DEFAULT_LOG_HEIGHT = 256; // max-h-64 = 16rem = 256px

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const currentHeight = dragHeight ?? DEFAULT_LOG_HEIGHT;
    resizeRef.current = { startY: e.clientY, startHeight: currentHeight };
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const dy = resizeRef.current.startY - ev.clientY;
      const newHeight = Math.max(DEFAULT_LOG_HEIGHT, Math.min(window.innerHeight * 0.8, resizeRef.current.startHeight + dy));
      setDragHeight(newHeight);
    };
    const onUp = () => {
      resizeRef.current = null;
      setIsDragging(false);
      setDragHeight(null); // snap back to default like a rolled parchment
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [dragHeight]);

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
      const rateStatus = platform === 'kick' ? kickSendManager.getRateStatus() : platform === 'joystick' ? joystickSendManager.getRateStatus() : sendGuard.getRateStatus();
      setRateUsed(rateStatus.used);
    }, 1000);
    return () => clearInterval(interval);
  }, [platform]);

  useEffect(() => {
    localStorage.setItem('forge-statusbar-x', dockX.toString());
  }, [dockX]);

  // Merge global sentMessages with per-bot runtime.sentMessages so the log
  // shows multi-bot activity. Per-bot sends go to bots[].runtime.sentMessages,
  // not the global sentMessages list, so without this merge the log stays
  // empty in multi-bot mode.
  const allSent = useMemo(() => {
    type DisplayMsg = { id: string; message: string; channel?: string; timestamp: number; source: string; botName?: string };
    const global: DisplayMsg[] = sentMessages.map((m) => ({ ...m, botName: undefined }));
    const perBot: DisplayMsg[] = bots.flatMap((b) =>
      b.runtime.sentMessages.map((m) => ({ ...m, botName: b.session?.username }))
    );
    return [...global, ...perBot].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  }, [sentMessages, bots]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startDockX: dockX };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !dockRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dockWidth = dockRef.current.offsetWidth;
      const maxX = window.innerWidth - dockWidth;
      const newX = Math.max(0, Math.min(maxX, dragRef.current.startDockX + dx));
      setDockX(newX);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [dockX]);

  const sessionDuration = now - sessionStats.sessionStart;

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

  const handleCopyHistory = async () => {
    const text = allSent.map((m) =>
      `[${formatClock(m.timestamp)}] [${m.source.toUpperCase()}]${m.botName ? ` [${m.botName}]` : ''} ${m.message}`
    ).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

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
      {/* Collapsible Status Bar — bottom-left */}
      <div ref={dockRef} data-tutorial="statusbar" className="forge-status-dock fixed bottom-0 z-40 flex flex-col max-w-full" style={{ left: `${dockX}px` }}>
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
                className="w-80 h-full max-h-[calc(100vh-48px)] bg-[#121217]/95 backdrop-blur-md border border-white/10 rounded-tr-xl shadow-2xl flex flex-col"
              >
                {/* Drag-to-resize handle */}
                <ThemedTooltip content="Drag up to expand — release to snap back">
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

                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-black/40">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 font-mono flex items-center gap-1.5">
                    <History className="w-3 h-3" /> Sent Message Log
                  </span>
                  <div className="flex items-center gap-1">
                    <ThemedTooltip content="Copy log">
                      <button
                        type="button"
                        onClick={handleCopyHistory}
                        aria-label="Copy sent message log"
                        disabled={allSent.length === 0}
                        className="p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content="Clear log">
                      <button
                        type="button"
                        onClick={handleClearHistory}
                        aria-label="Clear sent message log"
                        disabled={allSent.length === 0}
                        className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-30"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </ThemedTooltip>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1 forge-scroll">
                  {allSent.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 gap-1">
                      <Send className="w-5 h-5 text-gray-700" />
                      <span className="text-[10px] text-gray-600 font-mono">No messages sent yet</span>
                    </div>
                  ) : (
                    allSent.map((msg) => (
                      <div key={msg.id} className="rounded-lg border p-2 bg-black/30 border-white/5 hover:border-white/10 transition-colors">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className={cn('text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border', SOURCE_COLORS[msg.source])}>
                            {SOURCE_LABELS[msg.source]}
                          </span>
                          {msg.botName && (
                            <span className="text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border text-[#c79bff] bg-[#9146FF]/10 border-[#9146FF]/20">
                              {msg.botName}
                            </span>
                          )}
                          <span className="text-[9px] font-mono text-gray-600">{formatClock(msg.timestamp)}</span>
                        </div>
                        <p className="text-[11px] text-gray-300 leading-snug break-words font-mono">{msg.message}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status Bar */}
        <div className="forge-status-surface flex items-center gap-3 px-3 py-1.5 bg-[#121217]/95 backdrop-blur-md border border-white/10 border-b-0 rounded-tr-lg shadow-xl">
          {/* Drag Handle */}
          <ThemedTooltip content="Drag to reposition along bottom">
            <div
              onMouseDown={startDrag}
              className="flex items-center cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 transition-colors -ml-1.5"
            >
              <GripHorizontal className="w-4 h-4" />
            </div>
          </ThemedTooltip>

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
                <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats.messagesReceived}</span>
              </div>
            </ThemedTooltip>
            <ThemedTooltip content="Messages sent">
              <div className="flex items-center gap-1">
                <Send className="w-3 h-3 text-green-500" />
                <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats.messagesSent}</span>
              </div>
            </ThemedTooltip>
            <ThemedTooltip content="Forge batches">
              <div className="flex items-center gap-1">
                <Flame className="w-3 h-3 text-orange-500" />
                <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats.forgeCount}</span>
              </div>
            </ThemedTooltip>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* AutoForge Action Count */}
          {showAutoForge && (
            <ThemedTooltip content="AutoForge actions this session">
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-mono text-indigo-400 font-bold">AF:{enhancedStats.autoForgeActions}</span>
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

          {/* Rate Limit Indicator */}
          <ThemedTooltip content="Send rate limit (messages per 30s)">
            <div className="flex items-center gap-1">
              <span className={cn('text-[9px] font-mono font-bold', rateUsed >= 15 ? 'text-red-400' : rateUsed >= 10 ? 'text-yellow-400' : 'text-gray-500')}>
                {rateUsed}/{platform === 'kick' ? '50' : platform === 'joystick' ? '20' : '20'}
              </span>
            </div>
          </ThemedTooltip>

          {/* Expand/Collapse History */}
          <ThemedTooltip content={showHistory ? 'Hide sent log' : 'Show sent log'}>
            <button
              type="button"
              onClick={() => { setShowHistory(!showHistory); playSfx('history_toggle'); }}
              aria-label={showHistory ? 'Hide sent message log' : 'Show sent message log'}
              aria-expanded={showHistory}
              className="ml-1 p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
            >
              {showHistory ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </ThemedTooltip>
        </div>
      </div>
    </>
  );
}
