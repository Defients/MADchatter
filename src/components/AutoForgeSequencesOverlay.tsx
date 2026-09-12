import React, { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { getPlatformSendFn } from "../lib/platformSend";
import { toast } from "sonner";
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
  Layers,
  GripVertical,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import type { AutoForgeSequence, AutoForgeSequenceStep } from "../types";
import { ThemedTooltip } from "./ui/tooltip";

// ─── Action type metadata ────────────────────────────────────────────────────

const ACTION_META: Record<
  AutoForgeSequenceStep["actionType"],
  { label: string; icon: any; color: string; desc: string; needsPayload: boolean; payloadPlaceholder: string }
> = {
  full_forge: {
    label: "Full Forge",
    icon: Bot,
    color: "text-orange-400 bg-orange-500/10 border-orange-500/30",
    desc: "Generate a full co-pilot Forge message using AI. The bot will create variants, rank them, and send the best one. Use this for substantive conversational contributions.",
    needsPayload: false,
    payloadPlaceholder: "(no payload needed — AI generates the message)",
  },
  short_reaction: {
    label: "Short Reaction",
    icon: MessageSquare,
    color: "text-teal-400 bg-teal-500/10 border-teal-500/30",
    desc: "Send a short reaction message. Provide the exact text to send. Best for quick chat responses, callouts, or commentary.",
    needsPayload: true,
    payloadPlaceholder: "e.g. nice play!",
  },
  emote_only: {
    label: "Emote Only",
    icon: Sparkles,
    color: "text-purple-400 bg-purple-500/10 border-purple-500/30",
    desc: "Send a single emote or very short text. Provide the emote name or short text. Best for reactions, hype, and visual responses.",
    needsPayload: true,
    payloadPlaceholder: "e.g. Kappa or LULW",
  },
  quick_followup: {
    label: "Quick Follow-up",
    icon: Zap,
    color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/30",
    desc: "Send a follow-up message after a delay. Provide the exact text. The bot will wait for the specified delay before sending. Best for two-part jokes or elaborations.",
    needsPayload: true,
    payloadPlaceholder: "e.g. but seriously though",
  },
};

// ─── Preset sequences ────────────────────────────────────────────────────────

interface Preset {
  name: string;
  description: string;
  steps: Omit<AutoForgeSequenceStep, "id">[];
}

const PRESETS: Preset[] = [
  {
    name: "Hype Burst",
    description: "A rapid 3-emote hype sequence to celebrate a big moment. Sends three emotes in quick succession.",
    steps: [
      { actionType: "emote_only", payload: "PogChamp", delayMs: 0 },
      { actionType: "emote_only", payload: "KEKW", delayMs: 1200 },
      { actionType: "emote_only", payload: "catJAM", delayMs: 1200 },
    ],
  },
  {
    name: "Greeting + Engage",
    description: "Greet the chat with a short reaction, then follow up with a full AI-generated Forge message to start a conversation.",
    steps: [
      { actionType: "short_reaction", payload: "hey chat! 👋", delayMs: 0 },
      { actionType: "full_forge", delayMs: 3000 },
    ],
  },
  {
    name: "Joke Two-Parter",
    description: "Set up a joke with a short reaction, then deliver the punchline as a quick follow-up after a brief pause.",
    steps: [
      { actionType: "short_reaction", payload: "did you know...", delayMs: 0 },
      { actionType: "quick_followup", payload: "...neither does the bot! 😂", delayMs: 2500 },
    ],
  },
  {
    name: "Emote Cascade",
    description: "A slow-building 4-emote cascade that ramps up energy. Good for building hype during a quiet moment.",
    steps: [
      { actionType: "emote_only", payload: "monkaS", delayMs: 0 },
      { actionType: "emote_only", payload: "Pepega", delayMs: 1500 },
      { actionType: "emote_only", payload: "OMEGALUL", delayMs: 1500 },
      { actionType: "emote_only", payload: "Kreygasm", delayMs: 1500 },
    ],
  },
  {
    name: "React + Forge + Follow-up",
    description: "A full engagement sequence: react to chat, generate a substantive Forge message, then follow up with a lighter comment.",
    steps: [
      { actionType: "short_reaction", payload: "oh that's interesting", delayMs: 0 },
      { actionType: "full_forge", delayMs: 2000 },
      { actionType: "quick_followup", payload: "anyway, back to the game", delayMs: 4000 },
    ],
  },
  {
    name: "Quiet Check-in",
    description: "A gentle single Forge message to re-engage during a quiet chat period. Best used when chat is slow.",
    steps: [
      { actionType: "full_forge", delayMs: 0 },
    ],
  },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function AutoForgeSequencesOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    autoForgeSequences,
    addAutoForgeSequence,
    removeAutoForgeSequence,
    updateAutoForgeSequence,
    duplicateAutoForgeSequence,
    platform,
    streamMetadata,
    bots,
    multiBotEnabled,
  } = useAppStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(true);
  const [showPresets, setShowPresets] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  // Bot identity for sequence sends. null = legacy singleton (single-bot
  // mode). In multi-bot mode, defaults to the first active+authenticated bot.
  const activeBots = multiBotEnabled ? bots.filter((b) => b.active && b.session) : [];
  const [runAsBotId, setRunAsBotId] = useState<string | null>(null);

  const editingSeq = useMemo(
    () => autoForgeSequences.find((s) => s.id === editingId) || null,
    [autoForgeSequences, editingId]
  );

  const handleAddPreset = useCallback((preset: Preset) => {
    const steps: AutoForgeSequenceStep[] = preset.steps.map((s, i) => ({
      ...s,
      id: `step-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
    }));
    addAutoForgeSequence({ name: preset.name, steps, enabled: true });
    toast.success(`Added preset: ${preset.name}`);
    playSfx("memory_add");
  }, [addAutoForgeSequence]);

  const handleCreateBlank = useCallback(() => {
    const step: AutoForgeSequenceStep = {
      id: `step-${Date.now()}-0`,
      actionType: "short_reaction",
      payload: "",
      delayMs: 0,
    };
    addAutoForgeSequence({ name: "New Sequence", steps: [step], enabled: true });
    // Open editor for the new sequence
    setTimeout(() => {
      const latest = useAppStore.getState().autoForgeSequences;
      if (latest.length > 0) setEditingId(latest[latest.length - 1].id);
    }, 50);
    playSfx("hud_open");
  }, [addAutoForgeSequence]);

  const handleRunSequence = useCallback(async (seq: AutoForgeSequence) => {
    if (!seq.enabled) {
      toast.error("Sequence is disabled. Enable it first.");
      return;
    }
    const channel = streamMetadata?.channelName;
    if (!channel) {
      toast.error("No channel connected. Connect to a platform first.");
      return;
    }
    // Resolve the bot identity for sends. In multi-bot mode, use the
    // selected bot (or default to the first active bot). In legacy mode,
    // botId is undefined → singleton send path.
    const selectedBotId = multiBotEnabled
      ? (runAsBotId ?? activeBots[0]?.id)
      : undefined;
    const selectedBot = selectedBotId ? bots.find((b) => b.id === selectedBotId) : null;
    if (multiBotEnabled && !selectedBot) {
      toast.error("No active bot selected. Activate a bot to run sequences.");
      return;
    }
    setRunningId(seq.id);
    playSfx("autoforge_action");
    toast.info(`Running sequence: ${seq.name}${selectedBot ? ` as @${selectedBot.session?.username}` : ""}`, { description: `${seq.steps.length} steps` });

    const sendFn = getPlatformSendFn(platform, selectedBotId);
    for (const step of seq.steps) {
      // Wait for the cumulative delay
      if (step.delayMs > 0) {
        await new Promise((r) => setTimeout(r, step.delayMs));
      }

      if (step.actionType === "full_forge") {
        // For full_forge, trigger a targeted AutoForge force-check so the
        // selected bot generates + sends via its own identity.
        toast.info(`Step: Full Forge — triggering AI generation...`);
        if (selectedBotId) {
          window.dispatchEvent(new CustomEvent("autoforge-force-check", { detail: { botId: selectedBotId } }));
        } else {
          window.dispatchEvent(new CustomEvent("autoforge-force-check"));
        }
      } else if (step.payload) {
        try {
          await sendFn(channel, step.payload);
          toast.success(`Sent: ${step.payload.slice(0, 50)}`);
        } catch (e: any) {
          toast.error(`Send failed: ${e.message || e}`);
        }
      }
    }

    setRunningId(null);
    toast.success(`Sequence complete: ${seq.name}`);
  }, [platform, streamMetadata, setRunningId, multiBotEnabled, activeBots, bots, runAsBotId]);

  const handleUpdateStep = useCallback((seqId: string, stepId: string, updates: Partial<AutoForgeSequenceStep>) => {
    const seq = useAppStore.getState().autoForgeSequences.find((s) => s.id === seqId);
    if (!seq) return;
    const newSteps = seq.steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s));
    updateAutoForgeSequence(seqId, { steps: newSteps });
  }, [updateAutoForgeSequence]);

  const handleAddStep = useCallback((seqId: string) => {
    const seq = useAppStore.getState().autoForgeSequences.find((s) => s.id === seqId);
    if (!seq) return;
    const newStep: AutoForgeSequenceStep = {
      id: `step-${Date.now()}-${seq.steps.length}`,
      actionType: "short_reaction",
      payload: "",
      delayMs: 2000,
    };
    updateAutoForgeSequence(seqId, { steps: [...seq.steps, newStep] });
  }, [updateAutoForgeSequence]);

  const handleRemoveStep = useCallback((seqId: string, stepId: string) => {
    const seq = useAppStore.getState().autoForgeSequences.find((s) => s.id === seqId);
    if (!seq) return;
    updateAutoForgeSequence(seqId, { steps: seq.steps.filter((s) => s.id !== stepId) });
  }, [updateAutoForgeSequence]);

  const handleMoveStep = useCallback((seqId: string, stepId: string, direction: "up" | "down") => {
    const seq = useAppStore.getState().autoForgeSequences.find((s) => s.id === seqId);
    if (!seq) return;
    const idx = seq.steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= seq.steps.length) return;
    const newSteps = [...seq.steps];
    [newSteps[idx], newSteps[newIdx]] = [newSteps[newIdx], newSteps[idx]];
    updateAutoForgeSequence(seqId, { steps: newSteps });
  }, [updateAutoForgeSequence]);

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
            className="bg-[#121217] border border-orange-500/20 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden"
          >
            {/* ─── Header ──────────────────────────────────────────── */}
            <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/40">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-orange-500/15 border border-orange-500/30">
                  <Layers className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">AutoForge Sequences</h2>
                  <span className="text-[10px] text-gray-500">
                    {autoForgeSequences.length} sequence{autoForgeSequences.length !== 1 ? "s" : ""} ·
                    {" "}{autoForgeSequences.filter((s) => s.enabled).length} active
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {multiBotEnabled && activeBots.length > 0 && (
                  <ThemedTooltip content="Bot identity for sequence sends">
                    <select
                      value={runAsBotId ?? activeBots[0]?.id ?? ""}
                      onChange={(e) => setRunAsBotId(e.target.value || null)}
                      className="text-[10px] px-2 py-1.5 rounded-lg border border-white/10 bg-black/40 text-gray-300 font-mono focus:outline-none focus:border-orange-500/40"
                    >
                      {activeBots.map((b) => (
                        <option key={b.id} value={b.id}>@{b.session?.username ?? b.label}</option>
                      ))}
                    </select>
                  </ThemedTooltip>
                )}
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
                <button
                  onClick={handleCreateBlank}
                  className="text-[10px] px-2.5 py-1.5 rounded-lg bg-orange-500/20 text-orange-300 border border-orange-500/40 hover:bg-orange-500/30 font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                >
                  <Plus className="w-3 h-3" /> New
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
                      <span className="text-xs font-bold uppercase tracking-wider">How AutoForge Sequences Work</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-[11px] text-gray-400 leading-relaxed">
                      <div>
                        <p className="text-gray-300 font-bold mb-1">What is a sequence?</p>
                        <p>A sequence is a pre-planned series of AutoForge actions that execute in order, each with its own delay. They let you choreograph multi-step bot behaviors — like a hype burst, a joke two-parter, or a react-then-engage flow.</p>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Action types</p>
                        <ul className="space-y-0.5">
                          <li><span className="text-orange-400 font-bold">Full Forge</span> — AI generates a full message</li>
                          <li><span className="text-teal-400 font-bold">Short Reaction</span> — send exact text</li>
                          <li><span className="text-purple-400 font-bold">Emote Only</span> — send an emote/short text</li>
                          <li><span className="text-cyan-400 font-bold">Quick Follow-up</span> — delayed follow-up text</li>
                        </ul>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">How to use</p>
                        <ol className="list-decimal list-inside space-y-0.5">
                          <li>Create a blank sequence or add a preset</li>
                          <li>Edit steps — set action type, payload, and delay</li>
                          <li>Toggle enabled/disabled with the dot</li>
                          <li>Test with the Play button</li>
                          <li>Sequences persist across sessions</li>
                        </ol>
                      </div>
                      <div>
                        <p className="text-gray-300 font-bold mb-1">Tips</p>
                        <ul className="space-y-0.5">
                          <li>Use longer delays (2-4s) between substantive steps</li>
                          <li>Emote-only steps can have short delays (1-1.5s)</li>
                          <li>Full Forge steps trigger real AI generation</li>
                          <li>Rate limits still apply per action type</li>
                          <li>Duplicate a sequence to experiment safely</li>
                        </ul>
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
                      <span className="text-xs font-bold uppercase tracking-wider">Preset Sequences — Click to Add</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {PRESETS.map((preset) => (
                        <button
                          key={preset.name}
                          onClick={() => handleAddPreset(preset)}
                          className="text-left p-2.5 rounded-lg bg-black/30 border border-purple-500/20 hover:border-purple-500/40 hover:bg-purple-500/5 transition-colors group"
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <Plus className="w-3 h-3 text-purple-400 group-hover:text-purple-300" />
                            <span className="text-[11px] font-bold text-purple-300">{preset.name}</span>
                            <span className="text-[9px] text-gray-600 ml-auto">{preset.steps.length} steps</span>
                          </div>
                          <p className="text-[10px] text-gray-500 leading-snug">{preset.description}</p>
                          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                            {preset.steps.map((s, i) => {
                              const meta = ACTION_META[s.actionType];
                              const Icon = meta.icon;
                              return (
                                <span key={i} className={cn("text-[8px] px-1 py-0.5 rounded border flex items-center gap-0.5", meta.color)}>
                                  <Icon className="w-2 h-2" />
                                  {s.payload ? s.payload.slice(0, 15) : meta.label}
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

            {/* ─── Sequences List ─────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 analytics-scroll">
              {autoForgeSequences.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Layers className="w-10 h-10 text-orange-500/20" />
                  <p className="text-sm text-gray-500">No sequences yet</p>
                  <p className="text-[11px] text-gray-600 text-center max-w-xs">
                    Create a new sequence from scratch, or browse presets to get started with pre-built multi-action plans.
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={handleCreateBlank}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-orange-500/20 text-orange-300 border border-orange-500/40 hover:bg-orange-500/30 font-bold flex items-center gap-1.5"
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
                autoForgeSequences.map((seq) => (
                  <SequenceCard
                    key={seq.id}
                    seq={seq}
                    isEditing={editingId === seq.id}
                    isRunning={runningId === seq.id}
                    onToggleEdit={() => setEditingId(editingId === seq.id ? null : seq.id)}
                    onToggleEnabled={() => updateAutoForgeSequence(seq.id, { enabled: !seq.enabled })}
                    onRun={() => handleRunSequence(seq)}
                    onDelete={() => { removeAutoForgeSequence(seq.id); if (editingId === seq.id) setEditingId(null); }}
                    onDuplicate={() => duplicateAutoForgeSequence(seq.id)}
                    onRename={(name) => updateAutoForgeSequence(seq.id, { name })}
                    onUpdateStep={(stepId, updates) => handleUpdateStep(seq.id, stepId, updates)}
                    onAddStep={() => handleAddStep(seq.id)}
                    onRemoveStep={(stepId) => handleRemoveStep(seq.id, stepId)}
                    onMoveStep={(stepId, dir) => handleMoveStep(seq.id, stepId, dir)}
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

// ─── Sequence Card ───────────────────────────────────────────────────────────

const SequenceCard: React.FC<{
  seq: AutoForgeSequence;
  isEditing: boolean;
  isRunning: boolean;
  onToggleEdit: () => void;
  onToggleEnabled: () => void;
  onRun: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onUpdateStep: (stepId: string, updates: Partial<AutoForgeSequenceStep>) => void;
  onAddStep: () => void;
  onRemoveStep: (stepId: string) => void;
  onMoveStep: (stepId: string, direction: "up" | "down") => void;
}> = ({
  seq,
  isEditing,
  isRunning,
  onToggleEdit,
  onToggleEnabled,
  onRun,
  onDelete,
  onDuplicate,
  onRename,
  onUpdateStep,
  onAddStep,
  onRemoveStep,
  onMoveStep,
}) => {
  const [localName, setLocalName] = useState(seq.name);
  const totalDelay = seq.steps.reduce((s, step) => s + step.delayMs, 0);

  return (
    <div className={cn(
      "rounded-xl border transition-colors",
      isEditing ? "bg-orange-500/[0.03] border-orange-500/30" : "bg-white/[0.02] border-white/5 hover:border-white/10"
    )}>
      {/* Card header */}
      <div className="flex items-center gap-2 p-3">
        <ThemedTooltip content={seq.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}>
          <button
            onClick={onToggleEnabled}
            className={cn(
              "w-2.5 h-2.5 rounded-full shrink-0 transition-colors",
              seq.enabled ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]" : "bg-gray-600"
            )}
          />
        </ThemedTooltip>

        {isEditing ? (
          <input
            type="text"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={() => onRename(localName)}
            onKeyDown={(e) => { if (e.key === "Enter") onRename(localName); }}
            className="flex-1 text-sm font-bold text-white bg-black/40 border border-orange-500/30 rounded px-2 py-0.5 focus:outline-none focus:border-orange-500/50"
            autoFocus
          />
        ) : (
          <span className="flex-1 text-sm font-bold text-orange-300 truncate">{seq.name}</span>
        )}

        <span className="text-[10px] text-gray-500 font-mono shrink-0">
          {seq.steps.length} step{seq.steps.length !== 1 ? "s" : ""} · {(totalDelay / 1000).toFixed(1)}s
        </span>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <ThemedTooltip content={isRunning ? "Running..." : "Test run sequence"}>
            <button
              onClick={onRun}
              disabled={isRunning || !seq.enabled}
              className={cn(
                "p-1.5 rounded-lg transition-colors",
                isRunning
                  ? "bg-orange-500/20 text-orange-300 animate-pulse"
                  : seq.enabled
                    ? "text-green-400 hover:bg-green-500/15"
                    : "text-gray-600 cursor-not-allowed"
              )}
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
          <ThemedTooltip content={isEditing ? "Close editor" : "Edit sequence"}>
            <button
              onClick={onToggleEdit}
              className={cn(
                "p-1.5 rounded-lg transition-colors",
                isEditing ? "bg-orange-500/15 text-orange-300" : "text-gray-500 hover:text-orange-400 hover:bg-orange-500/10"
              )}
            >
              {isEditing ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </ThemedTooltip>
          <ThemedTooltip content="Duplicate sequence">
            <button
              onClick={onDuplicate}
              className="p-1.5 rounded-lg text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
          <ThemedTooltip content="Delete sequence">
            <button
              onClick={onDelete}
              className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </ThemedTooltip>
        </div>
      </div>

      {/* Step preview (collapsed) */}
      {!isEditing && (
        <div className="px-3 pb-3 flex items-center gap-1.5 flex-wrap">
          {seq.steps.map((step, i) => {
            const meta = ACTION_META[step.actionType];
            const Icon = meta.icon;
            return (
              <div key={step.id} className="flex items-center gap-1.5">
                {i > 0 && step.delayMs > 0 && (
                  <span className="text-[9px] text-gray-600 font-mono flex items-center gap-0.5">
                    <Clock className="w-2 h-2" /> {(step.delayMs / 1000).toFixed(1)}s
                  </span>
                )}
                <span className={cn("text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1", meta.color)}>
                  <Icon className="w-2.5 h-2.5" />
                  {step.payload ? step.payload.slice(0, 20) : meta.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Step editor (expanded) */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2">
              {seq.steps.map((step, i) => {
                const meta = ACTION_META[step.actionType];
                const Icon = meta.icon;
                return (
                  <div key={step.id} className="flex items-start gap-2 p-2 rounded-lg bg-black/30 border border-white/5">
                    {/* Drag handle + index */}
                    <div className="flex flex-col items-center gap-0.5 pt-1 shrink-0">
                      <GripVertical className="w-3 h-3 text-gray-600" />
                      <span className="text-[9px] text-gray-500 font-mono font-bold">{i + 1}</span>
                    </div>

                    {/* Move buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        onClick={() => onMoveStep(step.id, "up")}
                        disabled={i === 0}
                        className="text-gray-600 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onMoveStep(step.id, "down")}
                        disabled={i === seq.steps.length - 1}
                        className="text-gray-600 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Action type selector */}
                    <div className="flex flex-col gap-1 shrink-0">
                      <select
                        value={step.actionType}
                        onChange={(e) => onUpdateStep(step.id, { actionType: e.target.value as AutoForgeSequenceStep["actionType"] })}
                        className="text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-gray-200 font-mono focus:outline-none focus:border-orange-500/40"
                      >
                        {Object.entries(ACTION_META).map(([key, m]) => (
                          <option key={key} value={key}>{m.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Payload input */}
                    <div className="flex-1 min-w-0">
                      {meta.needsPayload ? (
                        <input
                          type="text"
                          value={step.payload || ""}
                          onChange={(e) => onUpdateStep(step.id, { payload: e.target.value })}
                          placeholder={meta.payloadPlaceholder}
                          className="w-full text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-orange-500/40"
                        />
                      ) : (
                        <p className="text-[10px] text-gray-500 italic py-1">{meta.payloadPlaceholder}</p>
                      )}
                      {/* Action description */}
                      <p className="text-[9px] text-gray-600 mt-0.5 leading-snug">{meta.desc}</p>
                    </div>

                    {/* Delay input */}
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <label className="text-[8px] text-gray-600 uppercase">Delay</label>
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          value={step.delayMs / 1000}
                          onChange={(e) => onUpdateStep(step.id, { delayMs: Math.max(0, parseFloat(e.target.value) || 0) * 1000 })}
                          min={0}
                          step={0.5}
                          className="w-12 text-[10px] bg-black/40 border border-white/10 rounded px-1 py-1 text-gray-200 font-mono text-center focus:outline-none focus:border-orange-500/40"
                        />
                        <span className="text-[9px] text-gray-600">s</span>
                      </div>
                    </div>

                    {/* Delete step */}
                    <ThemedTooltip content="Remove step">
                      <button
                        onClick={() => onRemoveStep(step.id)}
                        disabled={seq.steps.length <= 1}
                        className="p-1 rounded text-gray-600 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </ThemedTooltip>
                  </div>
                );
              })}

              {/* Add step button */}
              <button
                onClick={onAddStep}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-orange-500/30 text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/50 transition-colors text-[11px] font-bold"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Step
              </button>

              {/* Summary */}
              <div className="flex items-center gap-3 text-[10px] text-gray-500 pt-1">
                <span className="flex items-center gap-1">
                  <Layers className="w-3 h-3" /> {seq.steps.length} steps
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Total: {(totalDelay / 1000).toFixed(1)}s
                </span>
                {seq.enabled ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <CheckCircle2 className="w-3 h-3" /> Active
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-gray-600">
                    <AlertCircle className="w-3 h-3" /> Disabled
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
