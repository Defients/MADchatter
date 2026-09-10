import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore } from '../store';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { sendGuard } from '../lib/twitch';
import { kickSendManager } from '../lib/kick';
import { joystickSendManager } from '../lib/joystick';
import { playSfx } from '../lib/sfx';
import { SENTIMENT_DOT_COLORS } from '../lib/sentiment';
import type { SentimentLabel } from '../types';
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
    return saved ? parseInt(saved) : 0;
  });
  const dragRef = useRef<{ startX: number; startDockX: number } | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
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
      const newHeight = Math.max(DEFAULT_LOG_HEIGHT, resizeRef.current.startHeight + dy);
      setDragHeight(newHeight);
    };
    const onUp = () => {
      resizeRef.current = null;
      setIsDragging(false);
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
    const text = sentMessages.map((m) =>
      `[${formatClock(m.timestamp)}] [${m.source.toUpperCase()}] ${m.message}`
    ).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  return (
    <>
      {/* Collapsible Status Bar — bottom-left */}
      <div ref={dockRef} data-tutorial="statusbar" className="fixed bottom-0 z-40 flex flex-col" style={{ left: `${dockX}px` }}>
        <AnimatePresence>
          {showHistory && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
              style={dragHeight ? { maxHeight: `${dragHeight + 48}px` } : undefined}
            >
              <div
                className="w-80 max-h-64 bg-[#121217]/95 backdrop-blur-md border border-white/10 rounded-tr-xl shadow-2xl flex flex-col transition-[max-height] duration-300 ease-out"
                style={dragHeight ? { maxHeight: `${dragHeight}px`, transition: isDragging ? 'none' : undefined } : undefined}
              >
                {/* Drag-to-resize handle */}
                <div
                  onMouseDown={startResize}
                  className={cn(
                    "flex items-center justify-center h-5 cursor-row-resize select-none border-b border-white/5 bg-black/40 transition-colors",
                    isDragging ? "bg-white/10" : "hover:bg-white/5"
                  )}
                  title="Drag up to expand"
                >
                  <div className={cn("w-8 h-0.5 rounded-full transition-colors", isDragging ? "bg-white/40" : "bg-white/20")} />
                </div>

                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-black/40">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 font-mono flex items-center gap-1.5">
                    <History className="w-3 h-3" /> Sent Message Log
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleCopyHistory}
                      disabled={sentMessages.length === 0}
                      className="p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30"
                      title="Copy log"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={clearSentMessages}
                      disabled={sentMessages.length === 0}
                      className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-30"
                      title="Clear log"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1 forge-scroll">
                  {sentMessages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-6 gap-1">
                      <Send className="w-5 h-5 text-gray-700" />
                      <span className="text-[10px] text-gray-600 font-mono">No messages sent yet</span>
                    </div>
                  ) : (
                    [...sentMessages].reverse().map((msg) => (
                      <div key={msg.id} className="rounded-lg border p-2 bg-black/30 border-white/5 hover:border-white/10 transition-colors">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className={cn('text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border', SOURCE_COLORS[msg.source])}>
                            {SOURCE_LABELS[msg.source]}
                          </span>
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
        <div className="flex items-center gap-3 px-3 py-1.5 bg-[#121217]/95 backdrop-blur-md border border-white/10 border-b-0 rounded-tr-lg shadow-xl">
          {/* Drag Handle */}
          <div
            onMouseDown={startDrag}
            className="flex items-center cursor-grab active:cursor-grabbing text-gray-600 hover:text-gray-400 transition-colors -ml-1.5"
            title="Drag to reposition along bottom"
          >
            <GripHorizontal className="w-4 h-4" />
          </div>

          {/* Connection Indicators */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1" title={`Chat Read: ${tmiReadState}`}>
              {tmiReadState === 'connected' ? (
                <Wifi className={cn('w-3 h-3', readColor)} />
              ) : (
                <WifiOff className={cn('w-3 h-3', readColor)} />
              )}
              <span className={cn('text-[9px] font-mono font-bold uppercase', readColor)}>RX</span>
            </div>
            <div className="flex items-center gap-1" title={`Chat Send: ${tmiSendState}`}>
              <Send className={cn('w-3 h-3', sendColor)} />
              <span className={cn('text-[9px] font-mono font-bold uppercase', sendColor)}>TX</span>
            </div>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* Session Timer */}
          <div className="flex items-center gap-1" title="Session duration">
            <Clock className="w-3 h-3 text-gray-500" />
            <span className="text-[9px] font-mono text-gray-400 font-bold">{formatDuration(sessionDuration)}</span>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* Stats */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1" title="Messages received">
              <MessageSquare className="w-3 h-3 text-teal-500" />
              <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats.messagesReceived}</span>
            </div>
            <div className="flex items-center gap-1" title="Messages sent">
              <Send className="w-3 h-3 text-green-500" />
              <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats.messagesSent}</span>
            </div>
            <div className="flex items-center gap-1" title="Forge batches">
              <Flame className="w-3 h-3 text-orange-500" />
              <span className="text-[9px] font-mono text-gray-400 font-bold">{sessionStats.forgeCount}</span>
            </div>
          </div>

          <div className="w-px h-3 bg-white/10" />

          {/* AutoForge Action Count */}
          {enhancedStats.autoForgeActions > 0 && (
            <div className="flex items-center gap-1" title="AutoForge actions this session">
              <span className="text-[9px] font-mono text-indigo-400 font-bold">AF:{enhancedStats.autoForgeActions}</span>
            </div>
          )}

          <div className="w-px h-3 bg-white/10" />

          {/* B9: Mini Audio Visualizer */}
          {audioEnergy && (
            <div className="flex items-center gap-1.5" title={`Audio: ${audioEnergy.label} (RMS ${audioEnergy.rms.toFixed(2)})`}>
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
          )}

          {/* A10: Stream Health Score */}
          {streamHealth && (
            <div className="flex items-center gap-1" title={`Stream health: ${streamHealth.label} (${streamHealth.overall}/100)`}>
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
          )}

          <div className="w-px h-3 bg-white/10" />

          {/* Sentiment Indicator */}
          {sentimentSummary && sentimentSummary.readings.length > 0 && (
            <div className="flex items-center gap-1" title={`Chat sentiment: ${sentimentSummary.current} (${sentimentSummary.trend})`}>
              <span className={cn('w-2 h-2 rounded-full', SENTIMENT_DOT_COLORS[sentimentSummary.current as SentimentLabel])} />
              <span className="text-[9px] font-mono text-gray-400 font-bold uppercase">{sentimentSummary.current}</span>
              {sentimentSummary.trend === 'rising' && <span className="text-[8px] text-green-400">↑</span>}
              {sentimentSummary.trend === 'falling' && <span className="text-[8px] text-red-400">↓</span>}
            </div>
          )}

          {/* Message Queue Indicator */}
          {messageQueueDepth > 0 && (
            <div className="flex items-center gap-1" title={`${messageQueueDepth} queued messages awaiting retry`}>
              <span className="text-[9px] font-mono text-yellow-400 font-bold">Q:{messageQueueDepth}</span>
            </div>
          )}

          <div className="w-px h-3 bg-white/10" />

          {/* Rate Limit Indicator */}
          <div className="flex items-center gap-1" title="Send rate limit (messages per 30s)">
            <span className={cn('text-[9px] font-mono font-bold', rateUsed >= 15 ? 'text-red-400' : rateUsed >= 10 ? 'text-yellow-400' : 'text-gray-500')}>
              {rateUsed}/{platform === 'kick' ? '50' : platform === 'joystick' ? '20' : '20'}
            </span>
          </div>

          {/* Expand/Collapse History */}
          <button
            type="button"
            onClick={() => { setShowHistory(!showHistory); playSfx('history_toggle'); }}
            className="ml-1 p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
            title={showHistory ? 'Hide sent log' : 'Show sent log'}
          >
            {showHistory ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </>
  );
}
