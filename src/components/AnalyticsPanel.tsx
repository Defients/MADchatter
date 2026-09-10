import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useAppStore } from '../store';
import { BarChart3, X, Activity, MessageSquare, Bot, Clock, Users, Zap, Gauge, HeartPulse, Flame, Trophy, ScrollText, TrendingUp, Target, Trash2, CheckCircle2, Download, Activity as ActivityIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { playSfx } from '../lib/sfx';
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'motion/react';
import { actionRateLimiter } from '../lib/actionRateLimiter';
import { SENTIMENT_COLORS } from '../lib/sentiment';
import type { SentimentLabel, GoalType, SessionGoal } from '../types';

// B1: Animated number counter
function AnimatedNumber({ value, format }: { value: number; format?: (v: number) => string }) {
  const motionValue = useMotionValue(0);
  const rounded = useTransform(motionValue, (latest) => format ? format(latest) : Math.round(latest).toString());
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(motionValue, value, { duration: 0.6, ease: "easeOut" });
    const unsubscribe = rounded.on("change", (v) => {
      if (ref.current) ref.current.textContent = v;
    });
    return () => { controls.stop(); unsubscribe(); };
  }, [value]);

  return <span ref={ref} className="tabular-nums">{format ? format(0) : "0"}</span>;
}

function StatCard({ icon: Icon, label, value, sublabel, accent }: { icon: any; label: string; value: string | number; sublabel?: string; accent?: string }) {
  const theme = useAppStore((s) => s.theme);
  // B7: Theme-aware icon colors
  const iconColor = accent || (theme === 'cosmotech' ? 'text-cyan-400' : theme === 'corrupture' ? 'text-red-400' : 'text-gray-400');
  const isNumeric = typeof value === 'number';
  return (
    <div className="flex flex-col gap-1 p-2.5 bg-white/[0.03] rounded-lg border border-white/5">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("w-3 h-3", iconColor)} />
        <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      </div>
      <span className="text-lg font-bold text-white tabular-nums leading-none">
        {isNumeric ? <AnimatedNumber value={value as number} /> : value}
      </span>
      {sublabel && <span className="text-[10px] text-gray-500">{sublabel}</span>}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function AnalyticsPanel() {
  const {
    analyticsPanelOpen,
    setAnalyticsPanelOpen,
    enhancedStats,
    actionHistory,
    rateLimitConfig,
    resetEnhancedStats,
    sentimentSummary,
    chatActivityBuckets,
    chatterStats,
    clearChatterStats,
    decisionLog,
    clearDecisionLog,
    sessionGoals,
    addSessionGoal,
    updateSessionGoal,
    removeSessionGoal,
    clearSessionGoals,
    sentimentHistory,
    goalEvaluationResults,
    providerFallbackHistory,
    streamHealth,
    actionAccuracy,
    clearActionAccuracy,
  } = useAppStore();

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!analyticsPanelOpen) return;
    // Refresh provider fallback history when panel opens
    useAppStore.getState().refreshProviderFallbackHistory();
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [analyticsPanelOpen]);

  const [leaderboardSort, setLeaderboardSort] = useState<'messages' | 'positive' | 'mentions'>('messages');
  const [decisionFilter, setDecisionFilter] = useState<'all' | 'action' | 'silence' | 'followup'>('all');
  const [decisionSearch, setDecisionSearch] = useState('');
  const [showAddGoal, setShowAddGoal] = useState(false);
  const [newGoalType, setNewGoalType] = useState<GoalType>('mentionResponseRate');
  const [newGoalTarget, setNewGoalTarget] = useState('80');

  // Memoize sorted chatters and max count to avoid recompute on every render
  const sortedChatters = useMemo(() =>
    Object.values(chatterStats)
      .sort((a, b) => {
        if (leaderboardSort === 'positive') return b.positiveCount - a.positiveCount;
        if (leaderboardSort === 'mentions') return b.mentionCount - a.mentionCount;
        return b.messageCount - a.messageCount;
      })
      .slice(0, 15),
    [chatterStats, leaderboardSort]
  );
  const maxChatterCount = useMemo(() =>
    Math.max(...Object.values(chatterStats).map(c =>
      leaderboardSort === 'positive' ? c.positiveCount : leaderboardSort === 'mentions' ? c.mentionCount : c.messageCount
    ), 1),
    [chatterStats, leaderboardSort]
  );

  if (!analyticsPanelOpen) return null;

  const sessionDuration = now - enhancedStats.sessionStart;
  const rateStats = actionRateLimiter.getStats();

  // Compute goal progress
  const goalProgress = (goal: SessionGoal): { current: number; pct: number; met: boolean } => {
    let current = 0;
    let pct = 0;
    let met = false;
    const totalDecisions = enhancedStats.autoForgeActions + enhancedStats.silenceDecisions + enhancedStats.followupActions;
    switch (goal.type) {
      case 'mentionResponseRate':
        current = enhancedStats.mentionsDetected > 0 ? Math.round((enhancedStats.autoForgeActions / enhancedStats.mentionsDetected) * 100) : 0;
        pct = Math.min(100, (current / goal.target) * 100);
        met = current >= goal.target;
        break;
      case 'minActionsPerHour':
        current = rateStats.actionsLastHour;
        pct = Math.min(100, (current / goal.target) * 100);
        met = current >= goal.target;
        break;
      case 'positiveSentimentRatio': {
        const positive = sentimentHistory.filter(r => r.label === 'positive' || r.label === 'hype' || r.label === 'wholesome').length;
        current = sentimentHistory.length > 0 ? Math.round((positive / sentimentHistory.length) * 100) : 0;
        pct = Math.min(100, (current / goal.target) * 100);
        met = current >= goal.target;
        break;
      }
      case 'maxSilenceRatio': {
        current = totalDecisions > 0 ? Math.round((enhancedStats.silenceDecisions / totalDecisions) * 100) : 0;
        pct = Math.min(100, ((goal.target - current) / goal.target) * 100);
        met = current <= goal.target;
        break;
      }
      case 'minMessagesSent':
        current = enhancedStats.messagesSent;
        pct = Math.min(100, (current / goal.target) * 100);
        met = current >= goal.target;
        break;
      case 'maxAvgResponseMs':
        current = enhancedStats.avgResponseTimeMs;
        pct = Math.min(100, ((goal.target - current) / goal.target) * 100);
        met = current <= goal.target;
        break;
    }
    return { current, pct: Math.max(0, pct), met };
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={() => { setAnalyticsPanelOpen(false); playSfx('hud_close'); }}
      >
        <motion.div
          onClick={(e) => e.stopPropagation()}
          className="bg-[#121217] border border-white/10 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto analytics-scroll"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/40 sticky top-0 z-10">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-indigo-400" />
              <h2 className="text-lg font-bold text-white">Analytics Dashboard</h2>
              <span className="text-[10px] text-gray-500 ml-2">{formatDuration(sessionDuration)}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const s = useAppStore.getState();
                  const report = {
                    sessionStart: new Date(s.enhancedStats.sessionStart).toISOString(),
                    sessionDuration: formatDuration(now - s.enhancedStats.sessionStart),
                    stats: s.enhancedStats,
                    topChatters: Object.values(s.chatterStats).sort((a, b) => b.messageCount - a.messageCount).slice(0, 10),
                    sentimentSummary: s.sentimentSummary,
                    decisionLog: s.decisionLog.slice(-50),
                    actionHistory: s.actionHistory.slice(-50),
                    streamEvents: s.streamEvents,
                    goals: s.goalEvaluationResults,
                    providerFallbacks: s.providerFallbackHistory,
                    actionAccuracy: s.actionAccuracy,
                    streamHealth: s.streamHealth,
                  };
                  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `madchatter-session-${Date.now()}.json`;
                  a.click(); URL.revokeObjectURL(url);
                  playSfx('hud_open');
                }}
                className="text-[10px] text-gray-400 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20 transition-colors flex items-center gap-1"
                title="Export session report"
              >
                <Download className="w-3 h-3" /> Report
              </button>
              <button
                onClick={() => { resetEnhancedStats(); playSfx('clear_context'); }}
                className="text-[10px] text-gray-400 hover:text-white px-2 py-1 rounded border border-white/10 hover:border-white/20 transition-colors"
              >
                Reset Stats
              </button>
              <button
                onClick={() => { setAnalyticsPanelOpen(false); playSfx('hud_close'); }}
                className="text-gray-400 hover:text-white p-1 rounded hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-4">
            {/* Session Goals */}
            <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                  <Target className="w-3.5 h-3.5 text-indigo-400" />
                  Session Goals
                  {sessionGoals.length > 0 && <span className="text-[9px] text-gray-500 ml-1">{sessionGoals.filter(g => goalProgress(g).met).length}/{sessionGoals.filter(g => g.enabled).length} met</span>}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowAddGoal(!showAddGoal)}
                    className="text-[9px] text-indigo-400 hover:text-indigo-300 font-bold uppercase"
                  >
                    {showAddGoal ? 'Cancel' : '+ Add Goal'}
                  </button>
                  {sessionGoals.length > 0 && (
                    <button onClick={() => clearSessionGoals()} className="text-[9px] text-gray-500 hover:text-red-400">clear</button>
                  )}
                </div>
              </div>

              {showAddGoal && (
                <div className="flex items-center gap-1.5 pb-1 flex-wrap">
                  <select
                    value={newGoalType}
                    onChange={(e) => setNewGoalType(e.target.value as GoalType)}
                    className="text-[10px] px-1.5 py-1 rounded bg-black/30 border border-white/10 text-gray-200 outline-none focus:border-indigo-500/40"
                  >
                    <option value="mentionResponseRate">Mention Response %</option>
                    <option value="minActionsPerHour">Min Actions/Hr</option>
                    <option value="positiveSentimentRatio">Positive Sentiment %</option>
                    <option value="maxSilenceRatio">Max Silence %</option>
                    <option value="minMessagesSent">Min Messages Sent</option>
                    <option value="maxAvgResponseMs">Max Avg Response (ms)</option>
                  </select>
                  <input
                    type="number"
                    value={newGoalTarget}
                    onChange={(e) => setNewGoalTarget(e.target.value)}
                    className="w-16 text-[10px] px-1.5 py-1 rounded bg-black/30 border border-white/10 text-gray-200 outline-none focus:border-indigo-500/40"
                  />
                  <button
                    onClick={() => {
                      const target = parseInt(newGoalTarget, 10);
                      if (isNaN(target) || target <= 0) return;
                      const labels: Record<GoalType, string> = {
                        mentionResponseRate: `Respond to ${target}% of mentions`,
                        minActionsPerHour: `Min ${target} actions/hour`,
                        positiveSentimentRatio: `Keep ${target}% positive sentiment`,
                        maxSilenceRatio: `Keep silence under ${target}%`,
                        minMessagesSent: `Send at least ${target} messages`,
                        maxAvgResponseMs: `Keep avg response under ${target}ms`,
                      };
                      addSessionGoal({ type: newGoalType, label: labels[newGoalType], target, enabled: true });
                      setShowAddGoal(false);
                    }}
                    className="text-[9px] px-2 py-1 rounded bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/30 font-bold uppercase"
                  >
                    Add
                  </button>
                </div>
              )}

              {sessionGoals.length > 0 ? (
                <div className="space-y-1.5">
                  {sessionGoals.map((goal) => {
                    if (!goal.enabled) return null;
                    const { current, pct, met } = goalProgress(goal);
                    const barColor = met ? 'bg-green-500' : pct >= 75 ? 'bg-yellow-500' : pct >= 50 ? 'bg-orange-500' : 'bg-red-500';
                    const unit = goal.type === 'maxAvgResponseMs' ? 'ms' : goal.type === 'minMessagesSent' || goal.type === 'minActionsPerHour' ? '' : '%';
                    return (
                      <div key={goal.id} className="group flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between text-[10px] mb-0.5">
                            <span className={cn('truncate', met ? 'text-green-400 font-bold' : 'text-gray-300')}>{goal.label}</span>
                            <span className="text-gray-500 tabular-nums shrink-0 ml-2">
                              {current}{unit} / {goal.target}{unit}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div className={cn('h-full transition-all duration-500', barColor)} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        {met && <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />}
                        <button
                          onClick={() => removeSessionGoal(goal.id)}
                          className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[10px] text-gray-500">No goals set. Add a goal to track your session targets.</div>
              )}
            </div>

            {/* Core Stats Grid */}
            <div className="grid grid-cols-4 gap-2">
              <StatCard icon={MessageSquare} label="Messages In" value={enhancedStats.messagesReceived} />
              <StatCard icon={Bot} label="Messages Out" value={enhancedStats.messagesSent} />
              <StatCard icon={Zap} label="AutoForge" value={enhancedStats.autoForgeActions} sublabel={`${enhancedStats.silenceDecisions} silences`} />
              <StatCard icon={Users} label="Chatters" value={enhancedStats.uniqueChatters} />
            </div>

            <div className="grid grid-cols-4 gap-2">
              <StatCard icon={Activity} label="Mentions" value={enhancedStats.mentionsDetected} />
              <StatCard icon={Zap} label="Spikes" value={enhancedStats.spikesDetected} />
              <StatCard icon={Gauge} label="Peak Velocity" value={enhancedStats.peakChatVelocity} sublabel="lines/min" />
              <StatCard icon={Clock} label="Avg Response" value={`${enhancedStats.avgResponseTimeMs}ms`} />
            </div>

            {/* D1: Cost & Token Stats */}
            <div className="grid grid-cols-4 gap-2">
              <StatCard icon={Flame} label="Total Tokens" value={enhancedStats.totalTokensUsed.toLocaleString()} sublabel="session total" />
              <StatCard icon={Zap} label="Est. Cost" value={`$${enhancedStats.estimatedCost.toFixed(4)}`} sublabel="session total" />
              <StatCard icon={Bot} label="Fallbacks" value={enhancedStats.providerFallbacks} sublabel="provider switches" />
              <StatCard icon={Clock} label="Session" value={formatDuration(now - enhancedStats.sessionStart)} />
            </div>

            {/* A10: Stream Health Score */}
            {streamHealth && (
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                    <ActivityIcon className="w-3.5 h-3.5 text-green-400" />
                    Stream Health
                  </span>
                  <span className={cn(
                    "text-[10px] font-bold uppercase px-2 py-0.5 rounded",
                    streamHealth.label === "poppin" && "bg-green-500/20 text-green-400",
                    streamHealth.label === "healthy" && "bg-teal-500/20 text-teal-400",
                    streamHealth.label === "active" && "bg-blue-500/20 text-blue-400",
                    streamHealth.label === "slow" && "bg-yellow-500/20 text-yellow-400",
                    streamHealth.label === "dead" && "bg-red-500/20 text-red-400",
                  )}>
                    {streamHealth.label} · {streamHealth.overall}/100
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-2 text-center">
                  {[
                    { label: "Velocity", val: streamHealth.velocityScore, color: "bg-indigo-500" },
                    { label: "Sentiment", val: streamHealth.sentimentScore, color: "bg-pink-500" },
                    { label: "Diversity", val: streamHealth.diversityScore, color: "bg-teal-500" },
                    { label: "Mentions", val: streamHealth.mentionScore, color: "bg-orange-500" },
                    { label: "Visual", val: streamHealth.visualScore, color: "bg-purple-500" },
                  ].map((m) => (
                    <div key={m.label} className="flex flex-col gap-1">
                      <div className="h-12 bg-white/5 rounded flex items-end overflow-hidden">
                        <motion.div
                          className={cn("w-full rounded-t", m.color)}
                          initial={{ height: 0 }}
                          animate={{ height: `${m.val}%` }}
                          transition={{ duration: 0.5, ease: "easeOut" }}
                        />
                      </div>
                      <span className="text-[8px] text-gray-500 uppercase">{m.label}</span>
                      <span className="text-[9px] text-gray-400 font-mono">{m.val}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* A9: AutoForge Accuracy Metrics */}
            {actionAccuracy.length > 0 && (
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                    <Target className="w-3.5 h-3.5 text-cyan-400" />
                    AutoForge Accuracy
                  </span>
                  <button onClick={() => { clearActionAccuracy(); playSfx('clear_context'); }} className="text-[9px] text-gray-500 hover:text-red-400">clear</button>
                </div>
                <div className="space-y-1.5">
                  {actionAccuracy.map((entry) => (
                    <div key={entry.actionType} className="flex items-center gap-2 text-[10px]">
                      <span className="text-gray-400 w-28 truncate font-mono">{entry.actionType}</span>
                      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            entry.accuracyPct >= 70 ? "bg-green-500/60" : entry.accuracyPct >= 40 ? "bg-yellow-500/60" : "bg-red-500/60"
                          )}
                          style={{ width: `${entry.accuracyPct}%` }}
                        />
                      </div>
                      <span className="text-gray-500 w-16 tabular-nums text-right">
                        {entry.engaged}/{entry.total} ({entry.accuracyPct}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* D3: Provider Fallback History */}
            {providerFallbackHistory.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-gray-400">
                  <Bot className="w-3 h-3" />
                  <span className="text-[10px] uppercase tracking-wide">Provider Fallback History</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 forge-scroll">
                  {providerFallbackHistory.slice(-10).reverse().map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10px] text-gray-500 bg-white/[0.02] rounded px-2 py-1">
                      <span className="text-orange-400 font-mono">{entry.fromProvider}</span>
                      <span className="text-gray-600">→</span>
                      <span className="text-cyan-400 font-mono">{entry.toProvider}</span>
                      <span className="text-gray-600 truncate flex-1">{entry.reason}</span>
                      <span className="text-gray-700">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* D2: Goal Evaluation Results */}
            {goalEvaluationResults.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-gray-400">
                  <Target className="w-3 h-3" />
                  <span className="text-[10px] uppercase tracking-wide">Goal Evaluation (Live)</span>
                </div>
                <div className="space-y-1">
                  {goalEvaluationResults.map((goal, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10px]">
                      <span className={cn("w-4 h-4 rounded-full flex items-center justify-center", goal.met ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-500")}>
                        {goal.met ? "✓" : "○"}
                      </span>
                      <span className="text-gray-300 flex-1 truncate">{goal.label || goal.goalType}</span>
                      <span className="text-gray-500 font-mono">{goal.current}/{goal.target}</span>
                      <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all", goal.met ? "bg-green-500" : "bg-yellow-500")}
                          style={{ width: `${Math.round(goal.progress * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action Distribution */}
            <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
              <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                <Bot className="w-3.5 h-3.5 text-indigo-400" />
                Action Distribution
              </span>
              {Object.keys(enhancedStats.actionDistribution).length > 0 ? (
                <div className="space-y-1.5">
                  {Object.entries(enhancedStats.actionDistribution)
                    .sort((a, b) => b[1] - a[1])
                    .map(([action, count]) => {
                      const total = Object.values(enhancedStats.actionDistribution).reduce((s, v) => s + v, 0);
                      const pct = (count / total) * 100;
                      return (
                        <div key={action} className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400 w-28 truncate">{action}</span>
                          <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-indigo-500/60 rounded-full transition-all duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-gray-500 w-6 tabular-nums text-right">{count}</span>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="text-[10px] text-gray-500">No actions recorded yet.</div>
              )}
            </div>

            {/* Rate Limiting */}
            <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
              <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5 text-indigo-400" />
                Rate Limiting
              </span>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-1.5 bg-white/[0.02] rounded">
                  <div className="text-sm font-bold text-white tabular-nums">{rateStats.actionsLastHour}/{rateStats.maxPerHour}</div>
                  <div className="text-[9px] text-gray-500">per hour</div>
                </div>
                <div className="p-1.5 bg-white/[0.02] rounded">
                  <div className="text-sm font-bold text-white tabular-nums">{rateStats.actionsLastTenMin}/{rateStats.maxPerTenMin}</div>
                  <div className="text-[9px] text-gray-500">per 10 min</div>
                </div>
                <div className="p-1.5 bg-white/[0.02] rounded">
                  <div className="text-sm font-bold text-white tabular-nums">{rateStats.msUntilNextAllowed > 0 ? Math.ceil(rateStats.msUntilNextAllowed / 1000) + 's' : 'Ready'}</div>
                  <div className="text-[9px] text-gray-500">cooldown</div>
                </div>
              </div>
            </div>

            {/* Sentiment Distribution */}
            {sentimentSummary && sentimentSummary.readings.length > 0 && (
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                  <HeartPulse className="w-3.5 h-3.5 text-pink-400" />
                  Sentiment Distribution
                  <span className={cn('ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase', SENTIMENT_COLORS[sentimentSummary.current as SentimentLabel])}>
                    {sentimentSummary.current}
                  </span>
                  {sentimentSummary.trend === 'rising' && <span className="text-green-400 text-[10px]">↑</span>}
                  {sentimentSummary.trend === 'falling' && <span className="text-red-400 text-[10px]">↓</span>}
                  {sentimentSummary.trend === 'stable' && <span className="text-gray-500 text-[10px]">→</span>}
                </span>
                <div className="space-y-1.5">
                  {(Object.entries(sentimentSummary.distribution) as [SentimentLabel, number][]) 
                    .filter(([, count]) => count > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, count]) => {
                      const total = sentimentSummary.readings.length;
                      const pct = (count / total) * 100;
                      const colors: Record<SentimentLabel, string> = {
                        positive: 'bg-green-500/60',
                        negative: 'bg-red-500/60',
                        hype: 'bg-orange-500/60',
                        wholesome: 'bg-pink-500/60',
                        toxic: 'bg-red-700/60',
                        neutral: 'bg-gray-500/60',
                      };
                      return (
                        <div key={label} className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400 w-20 capitalize">{label}</span>
                          <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                            <div className={cn('h-full rounded-full transition-all duration-500', colors[label])} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500 w-6 tabular-nums text-right">{count}</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Recent Action History */}
            {actionHistory.length > 0 && (
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-indigo-400" />
                  Recent Actions
                </span>
                <div className="space-y-1 max-h-40 overflow-y-auto analytics-scroll">
                  {actionHistory.slice(-10).reverse().map((entry) => (
                    <div key={entry.id} className="flex items-center gap-2 text-[10px] py-1 border-b border-white/[0.02] last:border-0">
                      <span className="text-gray-500 tabular-nums w-12">{formatDuration(now - entry.timestamp)} ago</span>
                      <span className={cn(
                        "px-1.5 py-0.5 rounded font-mono",
                        entry.actionType === 'full_forge' && 'bg-indigo-500/20 text-indigo-300',
                        entry.actionType === 'short_reaction' && 'bg-blue-500/20 text-blue-300',
                        entry.actionType === 'emote_only' && 'bg-amber-500/20 text-amber-300',
                        entry.actionType === 'quick_followup' && 'bg-purple-500/20 text-purple-300',
                        entry.actionType === 'joke_callback' && 'bg-pink-500/20 text-pink-300',
                      )}>
                        {entry.actionType}
                      </span>
                      <span className="text-gray-400 truncate flex-1">{entry.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Chat Activity Trend */}
            <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
              <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                <Flame className="w-3.5 h-3.5 text-orange-400" />
                Chat Activity Trend
                <span className="text-[9px] text-gray-500 ml-1">last 60 min</span>
              </span>
              {chatActivityBuckets.length > 2 ? (
                (() => {
                  const maxCount = Math.max(...chatActivityBuckets.map(b => b.count), 1);
                  const w = 100;
                  const h = 56;
                  const n = chatActivityBuckets.length;
                  const stepX = w / (n - 1);
                  const points = chatActivityBuckets.map((b, i) => ({
                    x: i * stepX,
                    y: h - (b.count / maxCount) * (h - 4) - 2,
                    count: b.count,
                    ts: b.timestamp,
                    action: b.autoForgeAction,
                  }));
                  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
                  const areaD = `${pathD} L ${w} ${h} L 0 ${h} Z`;
                  const last5 = points.slice(-5);
                  const avgLast = last5.reduce((s, p) => s + p.count, 0) / last5.length;
                  const first5 = points.slice(0, Math.min(5, n - 5));
                  const avgFirst = first5.length > 0 ? first5.reduce((s, p) => s + p.count, 0) / first5.length : avgLast;
                  const trendSlope = (avgLast - avgFirst) / Math.max(n - 5, 1);
                  const projSteps = 5;
                  const projPoints: { x: number; y: number }[] = [];
                  const lastPoint = points[points.length - 1];
                  let projCount = avgLast;
                  for (let i = 1; i <= projSteps; i++) {
                    projCount = Math.max(0, projCount + trendSlope);
                    const px = w + i * (stepX * 0.5);
                    const py = h - (projCount / maxCount) * (h - 4) - 2;
                    projPoints.push({ x: px, y: py });
                  }
                  const projPathD = `M ${lastPoint.x.toFixed(2)} ${lastPoint.y.toFixed(2)} ` + projPoints.map(p => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
                  const projEnd = projPoints[projPoints.length - 1];
                  const trendDir = trendSlope > 0.1 ? 'rising' : trendSlope < -0.1 ? 'falling' : 'stable';
                  return (
                    <>
                      <div className="relative w-full">
                        <svg viewBox="-2 -2 128 62" preserveAspectRatio="none" className="w-full h-16">
                          <defs>
                            <linearGradient id="activityArea" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="rgba(99,102,241,0.4)" />
                              <stop offset="100%" stopColor="rgba(99,102,241,0.02)" />
                            </linearGradient>
                            <linearGradient id="projArea" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="rgba(251,146,60,0.25)" />
                              <stop offset="100%" stopColor="rgba(251,146,60,0.01)" />
                            </linearGradient>
                          </defs>
                          <path d={areaD} fill="url(#activityArea)" />
                          <path d={pathD} fill="none" stroke="rgba(99,102,241,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          <path d={projPathD} fill="none" stroke="rgba(251,146,60,0.6)" strokeWidth="1.2" strokeDasharray="2 2" strokeLinecap="round" />
                          <circle cx={projEnd.x} cy={projEnd.y} r="1.5" fill="rgba(251,146,60,0.8)" />
                          {points.filter(p => p.action).map((p, i) => (
                            <circle key={i} cx={p.x} cy={p.y} r="1.2" fill="rgba(251,146,60,0.9)" />
                          ))}
                        </svg>
                      </div>
                      <div className="flex items-center gap-3 text-[9px] text-gray-500">
                        <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-indigo-400/70" /> chat</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-0.5 rounded bg-orange-400/60" style={{ borderTop: '1px dashed' }} /> projection</span>
                        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-orange-400" /> AutoForge</span>
                        <span className={cn('ml-auto flex items-center gap-0.5 font-bold', trendDir === 'rising' ? 'text-green-400' : trendDir === 'falling' ? 'text-red-400' : 'text-gray-500')}>
                          <TrendingUp className={cn('w-2.5 h-2.5', trendDir === 'falling' && 'rotate-180')} />
                          {trendDir}
                        </span>
                      </div>
                    </>
                  );
                })()
              ) : (
                <div className="text-[10px] text-gray-500">Not enough data for trend yet.</div>
              )}
            </div>

            {/* Chatter Leaderboard */}
            {Object.keys(chatterStats).length > 0 && (
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                    <Trophy className="w-3.5 h-3.5 text-amber-400" />
                    Chatter Leaderboard
                  </span>
                  <div className="flex items-center gap-1">
                    {(['messages', 'positive', 'mentions'] as const).map((sort) => (
                      <button
                        key={sort}
                        onClick={() => setLeaderboardSort(sort)}
                        className={cn(
                          "text-[9px] px-1.5 py-0.5 rounded transition-colors",
                          leaderboardSort === sort ? "bg-amber-500/20 text-amber-300" : "text-gray-500 hover:text-gray-300"
                        )}
                      >
                        {sort}
                      </button>
                    ))}
                    <button
                      onClick={() => { clearChatterStats(); playSfx('clear_context'); }}
                      className="text-[9px] text-gray-500 hover:text-red-400 ml-1"
                    >
                      clear
                    </button>
                  </div>
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto analytics-scroll">
                  {sortedChatters.map((chatter, i) => {
                      const rank = i + 1;
                      const medalColor = rank === 1 ? "text-amber-400" : rank === 2 ? "text-gray-300" : rank === 3 ? "text-orange-700" : "text-gray-600";
                      const sortValue = leaderboardSort === 'positive' ? chatter.positiveCount : leaderboardSort === 'mentions' ? chatter.mentionCount : chatter.messageCount;
                      const barPct = (sortValue / maxChatterCount) * 100;
                      return (
                        <div key={chatter.username} className="flex items-center gap-2 text-[10px] py-1 border-b border-white/[0.02] last:border-0">
                          <span className={cn("font-bold w-4 text-center", medalColor)}>{rank}</span>
                          <span className="text-gray-300 font-semibold w-24 truncate">{chatter.username}</span>
                          <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-500/50 rounded-full transition-all duration-500" style={{ width: `${barPct}%` }} />
                          </div>
                          <span className="text-gray-500 tabular-nums w-8 text-right">
                            {leaderboardSort === 'positive' ? `${chatter.positiveCount}+` : leaderboardSort === 'mentions' ? `${chatter.mentionCount}m` : chatter.messageCount}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Decision Log */}
            {decisionLog.length > 0 && (
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                    <ScrollText className="w-3.5 h-3.5 text-cyan-400" />
                    Decision Log
                    <span className="text-[9px] text-gray-500 ml-1">{decisionLog.length} entries</span>
                  </span>
                  <div className="flex items-center gap-1 flex-wrap">
                    {(['all', 'action', 'silence', 'followup'] as const).map((filter) => (
                      <button
                        key={filter}
                        onClick={() => setDecisionFilter(filter)}
                        className={cn(
                          "text-[9px] px-1.5 py-0.5 rounded transition-colors",
                          decisionFilter === filter ? "bg-cyan-500/20 text-cyan-300" : "text-gray-500 hover:text-gray-300"
                        )}
                      >
                        {filter}
                      </button>
                    ))}
                    <input
                      type="text"
                      value={decisionSearch}
                      onChange={(e) => setDecisionSearch(e.target.value)}
                      placeholder="search..."
                      className="text-[9px] px-1.5 py-0.5 rounded bg-black/30 border border-white/10 text-gray-300 placeholder:text-gray-600 outline-none focus:border-cyan-500/40 w-20"
                    />
                    <button
                      onClick={() => {
                        const json = JSON.stringify(decisionLog, null, 2);
                        const blob = new Blob([json], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = `autoforge-decisions-${Date.now()}.json`;
                        a.click(); URL.revokeObjectURL(url);
                      }}
                      className="text-[9px] text-gray-500 hover:text-cyan-400 ml-1"
                    >
                      export
                    </button>
                    <button
                      onClick={() => { clearDecisionLog(); playSfx('clear_context'); }}
                      className="text-[9px] text-gray-500 hover:text-red-400"
                    >
                      clear
                    </button>
                  </div>
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto analytics-scroll">
                  {decisionLog
                    .filter((e) => (decisionFilter === 'all' || e.decision === decisionFilter) && (decisionSearch === '' || e.reasoning.toLowerCase().includes(decisionSearch.toLowerCase()) || (e.action || '').toLowerCase().includes(decisionSearch.toLowerCase())))
                    .slice(-30)
                    .reverse()
                    .map((entry) => (
                      <div key={entry.id} className="flex items-start gap-2 text-[10px] py-1 border-b border-white/[0.02] last:border-0">
                        <span className="text-gray-500 tabular-nums w-12 shrink-0">{formatDuration(now - entry.timestamp)} ago</span>
                        <span className={cn(
                          "px-1.5 py-0.5 rounded font-mono shrink-0",
                          entry.decision === 'action' && 'bg-green-500/20 text-green-300',
                          entry.decision === 'silence' && 'bg-gray-500/20 text-gray-400',
                          entry.decision === 'followup' && 'bg-blue-500/20 text-blue-300',
                        )}>
                          {entry.decision}
                        </span>
                        {entry.outcome && (
                          <span className={cn(
                            "px-1 py-0.5 rounded text-[8px] shrink-0",
                            entry.outcome === 'sent' && 'bg-green-600/20 text-green-400',
                            entry.outcome === 'failed' && 'bg-red-600/20 text-red-400',
                            entry.outcome === 'queued' && 'bg-amber-600/20 text-amber-400',
                          )}>
                            {entry.outcome}
                          </span>
                        )}
                        <span className="text-gray-400 truncate flex-1" title={entry.reasoning}>{entry.reasoning}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
