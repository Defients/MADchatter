import React, { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { toast } from "sonner";
import { RULE_PRESETS, dryRunRule } from "../lib/ruleEngine";
import {
  X,
  Plus,
  Trash2,
  Zap,
  Bot,
  MessageSquare,
  Sparkles,
  Clock,
  Copy,
  Play,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  GitBranch,
  GripVertical,
  AlertCircle,
  CheckCircle2,
  Bell,
  Flame,
  Activity,
  Eye,
  TrendingUp,
  Volume2,
  RefreshCw,
} from "lucide-react";
import type {
  AutoForgeRule,
  RuleCondition,
  RuleConditionType,
  RuleAction,
  RuleActionType,
  RuleEngineContext,
  SentimentLabel,
} from "../types";

// ─── Condition metadata ──────────────────────────────────────────────────────

const CONDITION_META: Record<
  RuleConditionType,
  { label: string; icon: any; color: string; desc: string; needsValue: boolean; needsSentiment: boolean; needsHealth: boolean; needsKeyword: boolean; valueLabel: string; valuePlaceholder: string }
> = {
  chat_velocity_above: { label: "Chat Velocity Above", icon: Activity, color: "text-teal-400", desc: "Chat messages per minute exceed threshold", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "msg/min", valuePlaceholder: "25" },
  chat_velocity_below: { label: "Chat Velocity Below", icon: Activity, color: "text-teal-400", desc: "Chat messages per minute drop below threshold", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "msg/min", valuePlaceholder: "5" },
  sentiment_is: { label: "Sentiment Is", icon: Sparkles, color: "text-purple-400", desc: "Current chat sentiment matches the selected label", needsValue: false, needsSentiment: true, needsHealth: false, needsKeyword: false, valueLabel: "", valuePlaceholder: "" },
  sentiment_is_not: { label: "Sentiment Is Not", icon: Sparkles, color: "text-purple-400", desc: "Current chat sentiment does not match the selected label", needsValue: false, needsSentiment: true, needsHealth: false, needsKeyword: false, valueLabel: "", valuePlaceholder: "" },
  time_since_last_action_above: { label: "Time Since Last Action Above", icon: Clock, color: "text-blue-400", desc: "Time since the bot's last action exceeds threshold (seconds)", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "seconds", valuePlaceholder: "300" },
  time_since_last_action_below: { label: "Time Since Last Action Below", icon: Clock, color: "text-blue-400", desc: "Time since the bot's last action is under threshold (seconds)", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "seconds", valuePlaceholder: "60" },
  keyword_detected: { label: "Keyword Detected", icon: MessageSquare, color: "text-yellow-400", desc: "A specific keyword appears in recent chat messages", needsValue: false, needsSentiment: false, needsHealth: false, needsKeyword: true, valueLabel: "", valuePlaceholder: "" },
  keyword_not_detected: { label: "Keyword Not Detected", icon: MessageSquare, color: "text-yellow-400", desc: "A specific keyword does not appear in recent chat", needsValue: false, needsSentiment: false, needsHealth: false, needsKeyword: true, valueLabel: "", valuePlaceholder: "" },
  mention_detected: { label: "Bot Mentioned", icon: Bell, color: "text-orange-400", desc: "The bot's username is mentioned in chat", needsValue: false, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "", valuePlaceholder: "" },
  activity_spike: { label: "Activity Spike", icon: Zap, color: "text-red-400", desc: "Sudden burst of chat activity (10+ messages in under 2 minutes)", needsValue: false, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "", valuePlaceholder: "" },
  stream_health_is: { label: "Stream Health Is", icon: TrendingUp, color: "text-green-400", desc: "Stream health score matches the selected label", needsValue: false, needsSentiment: false, needsHealth: true, needsKeyword: false, valueLabel: "", valuePlaceholder: "" },
  hype_level_above: { label: "Hype Level Above", icon: Flame, color: "text-orange-400", desc: "Hype level exceeds threshold (0-3)", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "level (0-3)", valuePlaceholder: "2" },
  hype_level_below: { label: "Hype Level Below", icon: Flame, color: "text-orange-400", desc: "Hype level is under threshold (0-3)", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "level (0-3)", valuePlaceholder: "1" },
  unique_chatters_above: { label: "Unique Chatters Above", icon: Eye, color: "text-cyan-400", desc: "Number of unique chatters exceeds threshold", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "chatters", valuePlaceholder: "15" },
  viewer_count_above: { label: "Viewer Count Above", icon: Eye, color: "text-indigo-400", desc: "Viewer count exceeds threshold", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "viewers", valuePlaceholder: "100" },
  viewer_count_below: { label: "Viewer Count Below", icon: Eye, color: "text-indigo-400", desc: "Viewer count drops below threshold", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "viewers", valuePlaceholder: "50" },
  audio_energy_above: { label: "Audio Energy Above", icon: Volume2, color: "text-pink-400", desc: "Audio energy (RMS, 0-100) exceeds threshold", needsValue: true, needsSentiment: false, needsHealth: false, needsKeyword: false, valueLabel: "RMS (0-100)", valuePlaceholder: "40" },
};

const SENTIMENT_OPTIONS: SentimentLabel[] = ["positive", "negative", "hype", "wholesome", "toxic", "neutral"];
const HEALTH_OPTIONS = ["dead", "slow", "active", "healthy", "poppin"] as const;

// ─── Action metadata ─────────────────────────────────────────────────────────

const ACTION_META: Record<
  RuleActionType,
  { label: string; icon: any; color: string; desc: string; needsPayload: boolean; needsMood: boolean; needsTemplate: boolean; needsNotification: boolean; needsHype: boolean; payloadLabel: string; payloadPlaceholder: string }
> = {
  send_message: { label: "Send Message", icon: MessageSquare, color: "text-teal-400 bg-teal-500/10 border-teal-500/30", desc: "Send a specific message to chat", needsPayload: true, needsMood: false, needsTemplate: false, needsNotification: false, needsHype: false, payloadLabel: "Message", payloadPlaceholder: "e.g. Hey chat! 👋" },
  send_emote: { label: "Send Emote", icon: Sparkles, color: "text-purple-400 bg-purple-500/10 border-purple-500/30", desc: "Send an emote or short text to chat", needsPayload: true, needsMood: false, needsTemplate: false, needsNotification: false, needsHype: false, payloadLabel: "Emote", payloadPlaceholder: "e.g. Kappa" },
  change_mood: { label: "Change Mood", icon: Bot, color: "text-orange-400 bg-orange-500/10 border-orange-500/30", desc: "Lock the bot's mood to a specific value", needsPayload: false, needsMood: true, needsTemplate: false, needsNotification: false, needsHype: false, payloadLabel: "", payloadPlaceholder: "" },
  apply_template: { label: "Apply Template", icon: Copy, color: "text-blue-400 bg-blue-500/10 border-blue-500/30", desc: "Apply a saved Forge template", needsPayload: false, needsMood: false, needsTemplate: true, needsNotification: false, needsHype: false, payloadLabel: "", payloadPlaceholder: "" },
  trigger_full_forge: { label: "Trigger Full Forge", icon: Bot, color: "text-orange-400 bg-orange-500/10 border-orange-500/30", desc: "Trigger a full AI-generated Forge message", needsPayload: false, needsMood: false, needsTemplate: false, needsNotification: false, needsHype: false, payloadLabel: "", payloadPlaceholder: "" },
  notify_user: { label: "Notify User", icon: Bell, color: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30", desc: "Show a toast notification to the user", needsPayload: false, needsMood: false, needsTemplate: false, needsNotification: true, needsHype: false, payloadLabel: "", payloadPlaceholder: "" },
  set_hype_level: { label: "Set Hype Level", icon: Flame, color: "text-red-400 bg-red-500/10 border-red-500/30", desc: "Manually set the hype level (0-3)", needsPayload: false, needsMood: false, needsTemplate: false, needsNotification: false, needsHype: true, payloadLabel: "", payloadPlaceholder: "" },
  force_autoforge_check: { label: "Force AutoForge Check", icon: Zap, color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/30", desc: "Force an immediate AutoForge decision check", needsPayload: false, needsMood: false, needsTemplate: false, needsNotification: false, needsHype: false, payloadLabel: "", payloadPlaceholder: "" },
};

const MOOD_OPTIONS = ["happy", "calm", "excited", "sarcastic", "thoughtful", "chaotic", "wholesome", "mysterious"];

// ─── Component ───────────────────────────────────────────────────────────────

export function RuleBuilderOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    autoForgeRules,
    addAutoForgeRule,
    removeAutoForgeRule,
    updateAutoForgeRule,
    duplicateAutoForgeRule,
    clearRuleFireCounts,
    forgeTemplates,
    sentimentHistory,
    streamHealth,
    hypeLevel,
    audioEnergy,
    enhancedStats,
    streamMetadata,
  } = useAppStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(true);
  const [showPresets, setShowPresets] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const editingRule = useMemo(
    () => autoForgeRules.find((r) => r.id === editingId) || null,
    [autoForgeRules, editingId]
  );

  // Build a live context for dry-run testing
  const liveCtx: RuleEngineContext = useMemo(() => ({
    chatVelocity: enhancedStats.peakChatVelocity > 0 ? Math.round(enhancedStats.peakChatVelocity * 0.5) : 0,
    sentimentLabel: sentimentHistory.length > 0 ? sentimentHistory[sentimentHistory.length - 1].label : null,
    timeSinceLastActionMs: 60000,
    recentChatText: "",
    isMentioned: false,
    activitySpike: false,
    streamHealthLabel: streamHealth?.label ?? null,
    hypeLevel,
    uniqueChatters: enhancedStats.uniqueChatters,
    viewerCount: streamMetadata?.viewerCount ?? 0,
    audioEnergyRms: audioEnergy?.rms ?? 0,
  }), [enhancedStats, sentimentHistory, streamHealth, hypeLevel, audioEnergy, streamMetadata]);

  const handleAddPreset = useCallback((presetIdx: number) => {
    const preset = RULE_PRESETS[presetIdx];
    addAutoForgeRule(preset.rule);
    toast.success(`Added preset: ${preset.name}`);
    playSfx("memory_add");
  }, [addAutoForgeRule]);

  const handleCreateBlank = useCallback(() => {
    const blankRule: Omit<AutoForgeRule, "id" | "createdAt" | "lastFiredMs" | "fireCount"> = {
      name: "New Rule",
      description: "",
      enabled: true,
      conditions: [
        { id: `c-${Date.now()}`, type: "chat_velocity_above", value: 10 },
      ],
      conditionOperator: "and",
      actions: [
        { id: `a-${Date.now()}`, type: "send_message", payload: "", delayMs: 0 },
      ],
      cooldownMs: 60000,
      maxFires: 0,
    };
    addAutoForgeRule(blankRule);
    setTimeout(() => {
      const latest = useAppStore.getState().autoForgeRules;
      if (latest.length > 0) setEditingId(latest[latest.length - 1].id);
    }, 50);
    playSfx("hud_open");
  }, [addAutoForgeRule]);

  const handleTestRule = useCallback((rule: AutoForgeRule) => {
    setTestingId(rule.id);
    const { conditionResults, overall } = dryRunRule(rule, liveCtx);
    setTimeout(() => {
      setTestingId(null);
      const passed = conditionResults.filter((r) => r.passed).length;
      toast.info(
        overall ? "Rule would fire (conditions met)" : "Rule would NOT fire",
        { description: `${passed}/${conditionResults.length} conditions passed with current live data`, duration: 5000 }
      );
    }, 600);
  }, [liveCtx]);

  // ─── Step handlers ─────────────────────────────────────────────────────────

  const handleUpdateCondition = useCallback((ruleId: string, condId: string, updates: Partial<RuleCondition>) => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    const newConditions = rule.conditions.map((c) => (c.id === condId ? { ...c, ...updates } : c));
    updateAutoForgeRule(ruleId, { conditions: newConditions });
  }, [updateAutoForgeRule]);

  const handleAddCondition = useCallback((ruleId: string) => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    const newCond: RuleCondition = { id: `c-${Date.now()}`, type: "chat_velocity_above", value: 10 };
    updateAutoForgeRule(ruleId, { conditions: [...rule.conditions, newCond] });
  }, [updateAutoForgeRule]);

  const handleRemoveCondition = useCallback((ruleId: string, condId: string) => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    updateAutoForgeRule(ruleId, { conditions: rule.conditions.filter((c) => c.id !== condId) });
  }, [updateAutoForgeRule]);

  const handleUpdateAction = useCallback((ruleId: string, actId: string, updates: Partial<RuleAction>) => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    const newActions = rule.actions.map((a) => (a.id === actId ? { ...a, ...updates } : a));
    updateAutoForgeRule(ruleId, { actions: newActions });
  }, [updateAutoForgeRule]);

  const handleAddAction = useCallback((ruleId: string) => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    const newAction: RuleAction = { id: `a-${Date.now()}`, type: "send_message", payload: "", delayMs: 0 };
    updateAutoForgeRule(ruleId, { actions: [...rule.actions, newAction] });
  }, [updateAutoForgeRule]);

  const handleRemoveAction = useCallback((ruleId: string, actId: string) => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    updateAutoForgeRule(ruleId, { actions: rule.actions.filter((a) => a.id !== actId) });
  }, [updateAutoForgeRule]);

  const handleMoveAction = useCallback((ruleId: string, actId: string, direction: "up" | "down") => {
    const rule = useAppStore.getState().autoForgeRules.find((r) => r.id === ruleId);
    if (!rule) return;
    const idx = rule.actions.findIndex((a) => a.id === actId);
    if (idx === -1) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= rule.actions.length) return;
    const newActions = [...rule.actions];
    [newActions[idx], newActions[newIdx]] = [newActions[newIdx], newActions[idx]];
    updateAutoForgeRule(ruleId, { actions: newActions });
  }, [updateAutoForgeRule]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => { onClose(); playSfx("hud_close"); }}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#121217] border border-cyan-500/20 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden"
          >
            {/* ─── Header ──────────────────────────────────────────── */}
            <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/40">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30">
                  <GitBranch className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">AutoForge Rule Engine</h2>
                  <span className="text-[10px] text-gray-500">
                    {autoForgeRules.length} rule{autoForgeRules.length !== 1 ? "s" : ""} ·
                    {" "}{autoForgeRules.filter((r) => r.enabled).length} active ·
                    {" "}{autoForgeRules.reduce((s, r) => s + r.fireCount, 0)} total fires
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowPresets(!showPresets); setShowInstructions(false); }}
                  className={cn(
                    "text-[10px] px-2.5 py-1.5 rounded-lg border font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5",
                    showPresets
                      ? "bg-purple-500/20 text-purple-300 border-purple-500/40"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-purple-300 hover:border-purple-500/30"
                  )}
                >
                  <Sparkles className="w-3 h-3" /> Presets
                </button>
                <button
                  onClick={() => { setShowInstructions(!showInstructions); setShowPresets(false); }}
                  className={cn(
                    "text-[10px] px-2.5 py-1.5 rounded-lg border font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5",
                    showInstructions
                      ? "bg-blue-500/20 text-blue-300 border-blue-500/40"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-blue-300 hover:border-blue-500/30"
                  )}
                >
                  <Lightbulb className="w-3 h-3" /> Guide
                </button>
                {autoForgeRules.some((r) => r.fireCount > 0) && (
                  <button
                    onClick={() => { clearRuleFireCounts(); toast.success("Fire counts cleared"); }}
                    className="text-[10px] px-2.5 py-1.5 rounded-lg bg-white/5 text-gray-400 border border-white/10 hover:text-white font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                    title="Reset all fire counts and cooldowns"
                  >
                    <RefreshCw className="w-3 h-3" /> Reset
                  </button>
                )}
                <button
                  onClick={handleCreateBlank}
                  className="text-[10px] px-2.5 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                >
                  <Plus className="w-3 h-3" /> New Rule
                </button>
                <button
                  onClick={() => { onClose(); playSfx("hud_close"); }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ─── Instructions Panel ─────────────────────────────── */}
            <AnimatePresence>
              {showInstructions && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-b border-white/5 bg-blue-500/[0.03]"
                >
                  <div className="p-4 space-y-3">
                    <div className="flex items-center gap-2 text-blue-300">
                      <Lightbulb className="w-4 h-4" />
                      <span className="text-xs font-bold uppercase tracking-wider">How the Rule Engine Works</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-[11px] text-gray-400 leading-relaxed">
                      <div>
                        <p className="text-gray-300 font-bold mb-1">What is a rule?</p>
                        <p>A rule is an IF-THEN automation: <span className="text-cyan-400">IF</span> a set of conditions are met, <span className="text-orange-400">THEN</span> a set of actions execute. Rules are evaluated on every AutoForge check cycle (typically every 1-3 minutes).</p>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Condition operators</p>
                        <p>Conditions can be combined with <span className="text-cyan-400">AND</span> (all must pass) or <span className="text-cyan-400">OR</span> (any must pass). Use AND for precise targeting, OR for broader triggers.</p>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Available conditions</p>
                        <ul className="space-y-0.5">
                          <li><span className="text-teal-400">Chat velocity</span> — messages per minute</li>
                          <li><span className="text-purple-400">Sentiment</span> — positive/negative/hype/etc</li>
                          <li><span className="text-blue-400">Time since last action</span> — in seconds</li>
                          <li><span className="text-yellow-400">Keyword</span> — detected in recent chat</li>
                          <li><span className="text-orange-400">Mention</span> — bot username mentioned</li>
                          <li><span className="text-red-400">Activity spike</span> — sudden chat burst</li>
                          <li><span className="text-green-400">Stream health</span> — dead/slow/active/healthy/poppin</li>
                          <li><span className="text-orange-400">Hype level</span> — 0-3 scale</li>
                          <li><span className="text-cyan-400">Unique chatters</span> — distinct users</li>
                          <li><span className="text-indigo-400">Viewer count</span> — from platform</li>
                          <li><span className="text-pink-400">Audio energy</span> — RMS 0-100</li>
                        </ul>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Available actions</p>
                        <ul className="space-y-0.5">
                          <li><span className="text-teal-400">Send Message</span> — send exact text to chat</li>
                          <li><span className="text-purple-400">Send Emote</span> — send emote/short text</li>
                          <li><span className="text-orange-400">Change Mood</span> — lock bot mood</li>
                          <li><span className="text-blue-400">Apply Template</span> — use a Forge template</li>
                          <li><span className="text-orange-400">Trigger Full Forge</span> — AI generates message</li>
                          <li><span className="text-yellow-400">Notify User</span> — show toast notification</li>
                          <li><span className="text-red-400">Set Hype Level</span> — override hype level</li>
                          <li><span className="text-cyan-400">Force AutoForge Check</span> — immediate decision</li>
                        </ul>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Cooldowns & fire limits</p>
                        <p>Each rule has a cooldown (minimum time between fires) and an optional max fire count (0 = unlimited). Use these to prevent spamming actions.</p>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Testing</p>
                        <p>Use the <span className="text-green-400">Test</span> button to dry-run a rule against current live data. This shows which conditions would pass without executing any actions.</p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ─── Presets Panel ──────────────────────────────────── */}
            <AnimatePresence>
              {showPresets && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-b border-white/5 bg-purple-500/[0.03]"
                >
                  <div className="p-4 space-y-2">
                    <div className="flex items-center gap-2 text-purple-300 mb-2">
                      <Sparkles className="w-4 h-4" />
                      <span className="text-xs font-bold uppercase tracking-wider">Preset Rules — Click to Add</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {RULE_PRESETS.map((preset, idx) => (
                        <button
                          key={preset.name}
                          onClick={() => handleAddPreset(idx)}
                          className="text-left p-2.5 rounded-lg bg-black/30 border border-purple-500/20 hover:border-purple-500/40 hover:bg-purple-500/5 transition-colors group"
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <Plus className="w-3 h-3 text-purple-400 group-hover:text-purple-300" />
                            <span className="text-[11px] font-bold text-purple-300">{preset.name}</span>
                          </div>
                          <p className="text-[10px] text-gray-500 leading-snug mb-1.5">{preset.description}</p>
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-[8px] text-gray-600 uppercase">IF:</span>
                            {preset.rule.conditions.map((c, i) => {
                              const meta = CONDITION_META[c.type];
                              return (
                                <span key={i} className={cn("text-[8px] px-1 py-0.5 rounded border", meta.color, "border-current/30 bg-white/5")}>
                                  {meta.label}
                                </span>
                              );
                            })}
                            <span className="text-[8px] text-gray-600 uppercase ml-1">THEN:</span>
                            {preset.rule.actions.map((a, i) => {
                              const meta = ACTION_META[a.type];
                              return (
                                <span key={i} className={cn("text-[8px] px-1 py-0.5 rounded border", meta.color)}>
                                  {meta.label}
                                </span>
                              );
                            })}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ─── Rules List ─────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 analytics-scroll">
              {autoForgeRules.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <GitBranch className="w-10 h-10 text-cyan-500/20" />
                  <p className="text-sm text-gray-500">No rules yet</p>
                  <p className="text-[11px] text-gray-600 text-center max-w-xs">
                    Create IF-THEN automation rules to control the bot's behavior based on chat conditions. Browse presets to get started.
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={handleCreateBlank}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 font-bold flex items-center gap-1.5"
                    >
                      <Plus className="w-3 h-3" /> Create Blank
                    </button>
                    <button
                      onClick={() => setShowPresets(true)}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30 font-bold flex items-center gap-1.5"
                    >
                      <Sparkles className="w-3 h-3" /> Browse Presets
                    </button>
                  </div>
                </div>
              ) : (
                autoForgeRules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    isEditing={editingId === rule.id}
                    isTesting={testingId === rule.id}
                    forgeTemplates={forgeTemplates}
                    liveCtx={liveCtx}
                    onToggleEdit={() => setEditingId(editingId === rule.id ? null : rule.id)}
                    onToggleEnabled={() => updateAutoForgeRule(rule.id, { enabled: !rule.enabled })}
                    onTest={() => handleTestRule(rule)}
                    onDelete={() => { removeAutoForgeRule(rule.id); if (editingId === rule.id) setEditingId(null); }}
                    onDuplicate={() => duplicateAutoForgeRule(rule.id)}
                    onRename={(name) => updateAutoForgeRule(rule.id, { name })}
                    onDescription={(description) => updateAutoForgeRule(rule.id, { description })}
                    onSetOperator={(op) => updateAutoForgeRule(rule.id, { conditionOperator: op })}
                    onSetCooldown={(ms) => updateAutoForgeRule(rule.id, { cooldownMs: ms })}
                    onSetMaxFires={(n) => updateAutoForgeRule(rule.id, { maxFires: n })}
                    onUpdateCondition={(condId, updates) => handleUpdateCondition(rule.id, condId, updates)}
                    onAddCondition={() => handleAddCondition(rule.id)}
                    onRemoveCondition={(condId) => handleRemoveCondition(rule.id, condId)}
                    onUpdateAction={(actId, updates) => handleUpdateAction(rule.id, actId, updates)}
                    onAddAction={() => handleAddAction(rule.id)}
                    onRemoveAction={(actId) => handleRemoveAction(rule.id, actId)}
                    onMoveAction={(actId, dir) => handleMoveAction(rule.id, actId, dir)}
                  />
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Rule Card ───────────────────────────────────────────────────────────────

const RuleCard: React.FC<{
  rule: AutoForgeRule;
  isEditing: boolean;
  isTesting: boolean;
  forgeTemplates: { id: string; name: string }[];
  liveCtx: RuleEngineContext;
  onToggleEdit: () => void;
  onToggleEnabled: () => void;
  onTest: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onDescription: (desc: string) => void;
  onSetOperator: (op: "and" | "or") => void;
  onSetCooldown: (ms: number) => void;
  onSetMaxFires: (n: number) => void;
  onUpdateCondition: (condId: string, updates: Partial<RuleCondition>) => void;
  onAddCondition: () => void;
  onRemoveCondition: (condId: string) => void;
  onUpdateAction: (actId: string, updates: Partial<RuleAction>) => void;
  onAddAction: () => void;
  onRemoveAction: (actId: string) => void;
  onMoveAction: (actId: string, dir: "up" | "down") => void;
}> = ({
  rule,
  isEditing,
  isTesting,
  forgeTemplates,
  liveCtx,
  onToggleEdit,
  onToggleEnabled,
  onTest,
  onDelete,
  onDuplicate,
  onRename,
  onDescription,
  onSetOperator,
  onSetCooldown,
  onSetMaxFires,
  onUpdateCondition,
  onAddCondition,
  onRemoveCondition,
  onUpdateAction,
  onAddAction,
  onRemoveAction,
  onMoveAction,
}) => {
  const [localName, setLocalName] = useState(rule.name);
  const [localDesc, setLocalDesc] = useState(rule.description);

  // Dry-run for live status
  const dryRun = useMemo(() => dryRunRule(rule, liveCtx), [rule, liveCtx]);
  const passedCount = dryRun.conditionResults.filter((r) => r.passed).length;

  return (
    <div className={cn(
      "rounded-xl border transition-colors",
      isEditing ? "bg-cyan-500/[0.03] border-cyan-500/30" : "bg-white/[0.02] border-white/5 hover:border-white/10"
    )}>
      {/* Card header */}
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={onToggleEnabled}
          className={cn(
            "w-2.5 h-2.5 rounded-full shrink-0 transition-colors",
            rule.enabled ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]" : "bg-gray-600"
          )}
          title={rule.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
        />

        {isEditing ? (
          <input
            type="text"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={() => onRename(localName)}
            onKeyDown={(e) => { if (e.key === "Enter") onRename(localName); }}
            className="flex-1 text-sm font-bold text-white bg-black/40 border border-cyan-500/30 rounded px-2 py-0.5 focus:outline-none focus:border-cyan-500/50"
            autoFocus
          />
        ) : (
          <span className="flex-1 text-sm font-bold text-cyan-300 truncate">{rule.name}</span>
        )}

        {/* Fire count badge */}
        {rule.fireCount > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 font-mono font-bold shrink-0" title="Times this rule has fired">
            🔥 {rule.fireCount}
          </span>
        )}

        {/* Live status indicator */}
        {!isEditing && (
          <span className={cn(
            "text-[9px] px-1.5 py-0.5 rounded font-mono font-bold shrink-0",
            dryRun.overall ? "bg-green-500/15 text-green-300" : "bg-gray-500/10 text-gray-500"
          )} title={`${passedCount}/${rule.conditions.length} conditions currently met`}
          >
            {passedCount}/{rule.conditions.length}
          </span>
        )}

        <span className="text-[10px] text-gray-500 font-mono shrink-0">
          {rule.conditions.length}c · {rule.actions.length}a
        </span>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onTest}
            disabled={isTesting}
            className={cn(
              "p-1.5 rounded-lg transition-colors",
              isTesting ? "bg-cyan-500/20 text-cyan-300 animate-pulse" : "text-green-400 hover:bg-green-500/15"
            )}
            title="Dry-run test with current live data"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onToggleEdit}
            className={cn(
              "p-1.5 rounded-lg transition-colors",
              isEditing ? "bg-cyan-500/15 text-cyan-300" : "text-gray-500 hover:text-cyan-400 hover:bg-cyan-500/10"
            )}
            title={isEditing ? "Close editor" : "Edit rule"}
          >
            {isEditing ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onDuplicate}
            className="p-1.5 rounded-lg text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
            title="Duplicate rule"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Delete rule"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Collapsed preview */}
      {!isEditing && (
        <div className="px-3 pb-3 space-y-1.5">
          {rule.description && (
            <p className="text-[10px] text-gray-500 italic">{rule.description}</p>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] text-cyan-400 font-bold uppercase">IF</span>
            {rule.conditions.map((c, i) => {
              const meta = CONDITION_META[c.type];
              const Icon = meta.icon;
              const isMet = dryRun.conditionResults[i]?.passed;
              return (
                <span key={c.id} className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1",
                  isMet ? "bg-green-500/10 border-green-500/30 text-green-300" : "bg-white/5 border-white/10 text-gray-400"
                )}>
                  <Icon className="w-2.5 h-2.5" />
                  {meta.label}
                  {meta.needsValue && c.value !== undefined && `: ${c.value}`}
                  {meta.needsSentiment && c.sentimentLabel && `: ${c.sentimentLabel}`}
                  {meta.needsHealth && c.healthLabel && `: ${c.healthLabel}`}
                  {meta.needsKeyword && c.keyword && `: "${c.keyword}"`}
                </span>
              );
            })}
            <span className="text-[9px] text-gray-600 font-bold uppercase">{rule.conditionOperator}</span>
            <span className="text-[9px] text-orange-400 font-bold uppercase ml-1">THEN</span>
            {rule.actions.map((a) => {
              const meta = ACTION_META[a.type];
              const Icon = meta.icon;
              return (
                <span key={a.id} className={cn("text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1", meta.color)}>
                  <Icon className="w-2.5 h-2.5" />
                  {meta.label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Expanded editor */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-3">
              {/* Description */}
              <input
                type="text"
                value={localDesc}
                onChange={(e) => setLocalDesc(e.target.value)}
                onBlur={() => onDescription(localDesc)}
                placeholder="Description (optional) — what does this rule do?"
                className="w-full text-[11px] bg-black/30 border border-white/10 rounded px-2 py-1 text-gray-400 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/30"
              />

              {/* ─── Conditions Section ─── */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1">
                    <GitBranch className="w-3 h-3" /> Conditions
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] text-gray-600 uppercase">Match:</span>
                    <button
                      onClick={() => onSetOperator("and")}
                      className={cn("text-[9px] px-2 py-0.5 rounded font-bold", rule.conditionOperator === "and" ? "bg-cyan-500/20 text-cyan-300" : "text-gray-500 hover:text-cyan-400")}
                    >
                      ALL (AND)
                    </button>
                    <button
                      onClick={() => onSetOperator("or")}
                      className={cn("text-[9px] px-2 py-0.5 rounded font-bold", rule.conditionOperator === "or" ? "bg-cyan-500/20 text-cyan-300" : "text-gray-500 hover:text-cyan-400")}
                    >
                      ANY (OR)
                    </button>
                  </div>
                </div>
                {rule.conditions.map((cond) => {
                  const meta = CONDITION_META[cond.type];
                  const Icon = meta.icon;
                  const isMet = dryRun.conditionResults.find((r) => r.condition.id === cond.id)?.passed;
                  return (
                    <div key={cond.id} className={cn(
                      "flex items-center gap-2 p-2 rounded-lg border",
                      isMet ? "bg-green-500/[0.05] border-green-500/20" : "bg-black/30 border-white/5"
                    )}>
                      <span className={cn("shrink-0", isMet ? "text-green-400" : "text-gray-600")}>
                        <CheckCircle2 className="w-3 h-3" />
                      </span>
                      <Icon className={cn("w-3.5 h-3.5 shrink-0", meta.color)} />
                      <select
                        value={cond.type}
                        onChange={(e) => onUpdateCondition(cond.id, { type: e.target.value as RuleConditionType })}
                        className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-cyan-500/40 shrink-0"
                      >
                        {Object.entries(CONDITION_META).map(([key, m]) => (
                          <option key={key} value={key}>{m.label}</option>
                        ))}
                      </select>
                      {meta.needsValue && (
                        <div className="flex items-center gap-1 shrink-0">
                          <input
                            type="number"
                            value={cond.value ?? 0}
                            onChange={(e) => onUpdateCondition(cond.id, { value: parseFloat(e.target.value) || 0 })}
                            placeholder={meta.valuePlaceholder}
                            className="w-16 text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 font-mono focus:outline-none focus:border-cyan-500/40"
                          />
                          <span className="text-[9px] text-gray-600">{meta.valueLabel}</span>
                        </div>
                      )}
                      {meta.needsSentiment && (
                        <select
                          value={cond.sentimentLabel ?? "neutral"}
                          onChange={(e) => onUpdateCondition(cond.id, { sentimentLabel: e.target.value as SentimentLabel })}
                          className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-cyan-500/40 shrink-0"
                        >
                          {SENTIMENT_OPTIONS.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      )}
                      {meta.needsHealth && (
                        <select
                          value={cond.healthLabel ?? "dead"}
                          onChange={(e) => onUpdateCondition(cond.id, { healthLabel: e.target.value as any })}
                          className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-cyan-500/40 shrink-0"
                        >
                          {HEALTH_OPTIONS.map((h) => (
                            <option key={h} value={h}>{h}</option>
                          ))}
                        </select>
                      )}
                      {meta.needsKeyword && (
                        <input
                          type="text"
                          value={cond.keyword ?? ""}
                          onChange={(e) => onUpdateCondition(cond.id, { keyword: e.target.value })}
                          placeholder="keyword..."
                          className="flex-1 text-[10px] bg-black/40 border border-white/10 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-cyan-500/40"
                        />
                      )}
                      <span className="text-[9px] text-gray-600 flex-1 min-w-0 truncate">{meta.desc}</span>
                      <button
                        onClick={() => onRemoveCondition(cond.id)}
                        disabled={rule.conditions.length <= 1}
                        className="p-1 rounded text-gray-600 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={onAddCondition}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/50 transition-colors text-[10px] font-bold"
                >
                  <Plus className="w-3 h-3" /> Add Condition
                </button>
              </div>

              {/* ─── Actions Section ─── */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Actions
                  </span>
                </div>
                {rule.actions.map((action, i) => {
                  const meta = ACTION_META[action.type];
                  const Icon = meta.icon;
                  return (
                    <div key={action.id} className="flex items-start gap-2 p-2 rounded-lg bg-black/30 border border-white/5">
                      <div className="flex flex-col items-center gap-0.5 pt-1 shrink-0">
                        <GripVertical className="w-3 h-3 text-gray-600" />
                        <span className="text-[9px] text-gray-500 font-mono font-bold">{i + 1}</span>
                      </div>
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button
                          onClick={() => onMoveAction(action.id, "up")}
                          disabled={i === 0}
                          className="text-gray-600 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => onMoveAction(action.id, "down")}
                          disabled={i === rule.actions.length - 1}
                          className="text-gray-600 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </div>
                      <Icon className={cn("w-3.5 h-3.5 mt-1 shrink-0", meta.color)} />
                      <select
                        value={action.type}
                        onChange={(e) => onUpdateAction(action.id, { type: e.target.value as RuleActionType })}
                        className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-orange-500/40 shrink-0 mt-0.5"
                      >
                        {Object.entries(ACTION_META).map(([key, m]) => (
                          <option key={key} value={key}>{m.label}</option>
                        ))}
                      </select>
                      <div className="flex-1 min-w-0">
                        {meta.needsPayload && (
                          <input
                            type="text"
                            value={action.payload ?? ""}
                            onChange={(e) => onUpdateAction(action.id, { payload: e.target.value })}
                            placeholder={meta.payloadPlaceholder}
                            className="w-full text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-orange-500/40"
                          />
                        )}
                        {meta.needsMood && (
                          <select
                            value={action.mood ?? "happy"}
                            onChange={(e) => onUpdateAction(action.id, { mood: e.target.value })}
                            className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-orange-500/40"
                          >
                            {MOOD_OPTIONS.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        )}
                        {meta.needsTemplate && (
                          <select
                            value={action.templateId ?? ""}
                            onChange={(e) => onUpdateAction(action.id, { templateId: e.target.value })}
                            className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 focus:outline-none focus:border-orange-500/40"
                          >
                            <option value="">Select template...</option>
                            {forgeTemplates.map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        )}
                        {meta.needsNotification && (
                          <input
                            type="text"
                            value={action.notification ?? ""}
                            onChange={(e) => onUpdateAction(action.id, { notification: e.target.value })}
                            placeholder="Notification message..."
                            className="w-full text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-orange-500/40"
                          />
                        )}
                        {meta.needsHype && (
                          <input
                            type="number"
                            value={action.hypeLevel ?? 0}
                            onChange={(e) => onUpdateAction(action.id, { hypeLevel: parseInt(e.target.value) || 0 })}
                            min={0}
                            max={3}
                            className="w-16 text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 font-mono focus:outline-none focus:border-orange-500/40"
                          />
                        )}
                        <p className="text-[9px] text-gray-600 mt-0.5 leading-snug">{meta.desc}</p>
                      </div>
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <label className="text-[8px] text-gray-600 uppercase">Delay</label>
                        <div className="flex items-center gap-0.5">
                          <input
                            type="number"
                            value={action.delayMs / 1000}
                            onChange={(e) => onUpdateAction(action.id, { delayMs: Math.max(0, parseFloat(e.target.value) || 0) * 1000 })}
                            min={0}
                            step={0.5}
                            className="w-12 text-[10px] bg-black/40 border border-white/10 rounded px-1 py-1 text-gray-200 font-mono text-center focus:outline-none focus:border-orange-500/40"
                          />
                          <span className="text-[9px] text-gray-600">s</span>
                        </div>
                      </div>
                      <button
                        onClick={() => onRemoveAction(action.id)}
                        disabled={rule.actions.length <= 1}
                        className="p-1 rounded text-gray-600 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0 mt-1"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={onAddAction}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-orange-500/30 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/50 transition-colors text-[10px] font-bold"
                >
                  <Plus className="w-3 h-3" /> Add Action
                </button>
              </div>

              {/* ─── Cooldown & Fire Limit ─── */}
              <div className="flex items-center gap-4 p-2 rounded-lg bg-black/20 border border-white/5">
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-blue-400" />
                  <label className="text-[10px] text-gray-400 uppercase font-bold">Cooldown</label>
                  <input
                    type="number"
                    value={rule.cooldownMs / 1000}
                    onChange={(e) => onSetCooldown(Math.max(0, parseFloat(e.target.value) || 0) * 1000)}
                    min={0}
                    step={5}
                    className="w-16 text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-gray-200 font-mono focus:outline-none focus:border-blue-500/40"
                  />
                  <span className="text-[9px] text-gray-600">seconds</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <AlertCircle className="w-3 h-3 text-yellow-400" />
                  <label className="text-[10px] text-gray-400 uppercase font-bold">Max Fires</label>
                  <input
                    type="number"
                    value={rule.maxFires}
                    onChange={(e) => onSetMaxFires(Math.max(0, parseInt(e.target.value) || 0))}
                    min={0}
                    className="w-16 text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-gray-200 font-mono focus:outline-none focus:border-yellow-500/40"
                  />
                  <span className="text-[9px] text-gray-600">(0 = ∞)</span>
                </div>
                {rule.fireCount > 0 && (
                  <span className="text-[10px] text-orange-300 font-mono ml-auto">
                    Fired {rule.fireCount}x
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
