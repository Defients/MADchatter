/**
 * CoreMode — the minimal operational surface for MADchatter.
 *
 * Core Mode is not a tutorial skin or crippled interface. It is a fully
 * supported minimal operating mode that experienced users may legitimately
 * prefer forever. It shows everything required to:
 *   - connect to a platform/channel
 *   - configure a working AI
 *   - select/configure basic personality
 *   - view relevant chat context
 *   - Forge
 *   - inspect candidate responses
 *   - send a response
 *   - activate AutoForge
 *
 * Advanced controls (R34L, AutoMemory config, rate limits, context token
 * budget, dry run, confidence threshold, templates, mood lock, Multi-Bot,
 * Director Notes, expanded AutoForge HUD, analytics, debugging) are hidden
 * but NOT disabled — the underlying systems continue running with their
 * existing/default configuration.
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Flame,
  Loader2,
  Zap,
  AlertTriangle,
  Tv,
  Cpu,
  Sparkles,
  PartyPopper,
} from "lucide-react";
import { useAppStore } from "../store";
import { useCoreReadiness, type CoreStage } from "../hooks/useCoreReadiness";
import { useStudioAvailable, useEffectiveMode } from "../hooks/useMediaQuery";
import { getActiveProvider, getKeys, hasAnyApiKey } from "../lib/keys";
import { checkOllamaHealth, getCachedOllamaHealth, type OllamaHealthState } from "../lib/ollamaHealth";
import { getCoreProviderSummary as getProviderSummary } from "../lib/coreProviderSummary";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";

// ─── Interface Mode Toggle ───────────────────────────────────────────────

export function InterfaceModeToggle() {
  // effectiveMode is what actually renders (CORE when STUDIO is unavailable).
  const interfaceMode = useEffectiveMode();
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const studioAvailable = useStudioAvailable();

  return (
    <div className="flex items-center gap-0.5 bg-black/40 rounded border border-white/5 p-0.5" role="group" aria-label="Interface mode">
      <button
        type="button"
        onClick={() => setInterfaceMode("core")}
        aria-pressed={interfaceMode === "core"}
        className={cn(
          "px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded transition-colors",
          interfaceMode === "core"
            ? "bg-orange-500/30 text-orange-300 border border-orange-500/30"
            : "text-gray-600 hover:text-gray-400"
        )}
      >
        Core
      </button>
      <button
        type="button"
        onClick={() => setInterfaceMode("studio")}
        aria-pressed={interfaceMode === "studio"}
        // aria-disabled (not disabled): stays focusable/clickable so a tap
        // surfaces the "larger screen" gate instead of silently doing nothing.
        aria-disabled={!studioAvailable}
        title={studioAvailable ? undefined : "STUDIO needs a larger screen"}
        className={cn(
          "px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded transition-colors",
          interfaceMode === "studio"
            ? "bg-cyan-500/30 text-cyan-300 border border-cyan-500/30"
            : studioAvailable
              ? "text-gray-600 hover:text-gray-400"
              : "text-gray-700 cursor-not-allowed"
        )}
      >
        Studio
      </button>
    </div>
  );
}

// ─── Ollama detection hook ────────────────────────────────────────────────

type OllamaDetection = "detecting" | "available" | "unavailable";

function useOllamaDetection(): OllamaDetection {
  const [state, setState] = useState<OllamaDetection>("detecting");

  useEffect(() => {
    let cancelled = false;
    const keys = getKeys();
    const baseUrl = keys.customBaseUrl || "http://localhost:11434/v1";

    // Quick check: if the user already has Ollama configured, consider it available
    // without a fresh health check (the health check runs on Forge).
    if (keys.customBaseUrl && keys.customModel) {
      const cached = getCachedOllamaHealth(keys.customBaseUrl, keys.customModel);
      if (cached && cached.state === "ready") {
        if (!cancelled) setState("available");
        return;
      }
    }

    // Lightweight detection: try to reach the Ollama models endpoint.
    checkOllamaHealth(baseUrl, keys.customModel || "")
      .then((result) => {
        if (cancelled) return;
        if (result.state === "ready" || result.state === "model_unavailable") {
          setState("available");
        } else {
          setState("unavailable");
        }
      })
      .catch(() => {
        if (!cancelled) setState("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// ─── Provider summary ─────────────────────────────────────────────────────

// ─── Stage indicator ──────────────────────────────────────────────────────

const STAGE_ORDER: CoreStage[] = ["platform", "ai", "personality", "forge", "send", "autoforge", "operational"];

const STAGE_LABELS: Record<CoreStage, string> = {
  platform: "Platform",
  ai: "AI",
  personality: "Personality",
  forge: "Forge",
  send: "Send",
  autoforge: "AutoForge",
  operational: "Live",
};

function StageDot({ stage, currentStage, operational }: { stage: CoreStage; currentStage: CoreStage; operational: boolean }) {
  const order = STAGE_ORDER.indexOf(stage);
  const currentOrder = STAGE_ORDER.indexOf(currentStage);
  const isComplete = operational || order < currentOrder;
  const isCurrent = stage === currentStage && !operational;
  const isAutoForge = stage === "autoforge";

  // AutoForge is optional — show as a hollow diamond, not a required step
  if (isAutoForge) {
    return (
      <div
        className={cn(
          "w-2 h-2 rotate-45 border transition-all",
          isComplete
            ? "bg-orange-400 border-orange-400"
            : "bg-transparent border-gray-700"
        )}
        title={`${STAGE_LABELS[stage]} (optional)`}
      />
    );
  }

  return (
    <div
      className={cn(
        "w-2 h-2 rounded-full transition-all",
        isComplete
          ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
          : isCurrent
            ? "bg-orange-400 ring-2 ring-orange-400/30 animate-pulse"
            : "bg-gray-700"
      )}
      title={STAGE_LABELS[stage]}
    />
  );
}

// ─── Core Launchpad ───────────────────────────────────────────────────────

export function CoreLaunchpad() {
  const readiness = useCoreReadiness();
  const [expanded, setExpanded] = useState(!readiness.operational);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const activationCelebrated = useAppStore((s) => s.activationCelebrated);
  const setActivationCelebrated = useAppStore((s) => s.setActivationCelebrated);
  const platform = useAppStore((s) => s.platform);
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);

  // Auto-expand the Launchpad when not operational; collapse when operational.
  useEffect(() => {
    if (readiness.operational) {
      setExpanded(false);
    } else {
      setExpanded(true);
    }
  }, [readiness.operational]);

  // ─── Activation celebration ──────────────────────────────────────────
  // Fires once when the user first reaches operational state.
  useEffect(() => {
    if (readiness.operational && !activationCelebrated) {
      setActivationCelebrated(true);
      // Respect prefers-reduced-motion
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!prefersReduced) {
        // Fire a one-shot confetti via the existing easter-egg system
        // (lightweight, no new dependency)
        const event = new CustomEvent("core-activation-celebration");
        window.dispatchEvent(event);
      }
      toast.success("MADchatter is live.", {
        description: "Keep Core focused, or open Studio for the full control surface.",
        duration: 6000,
      });
    }
  }, [readiness.operational, activationCelebrated, setActivationCelebrated]);

  const providerSummary = getProviderSummary();

  const stageItems: { key: CoreStage; label: string; done: boolean; detail: string }[] = [
    {
      key: "platform",
      label: "Platform",
      done: readiness.platformReady,
      detail: streamMetadata.channelName
        ? `${platform.charAt(0).toUpperCase() + platform.slice(1)} · @${streamMetadata.channelName}`
        : "Not connected",
    },
    {
      key: "ai",
      label: "AI",
      done: readiness.aiReady,
      detail: providerSummary.configured
        ? `${providerSummary.label}${providerSummary.model ? " · " + providerSummary.model : ""}`
        : "Not configured",
    },
    {
      key: "personality",
      label: "Personality",
      done: readiness.personalityReady,
      detail: "Persona selected",
    },
    {
      key: "forge",
      label: "Forge",
      done: readiness.forgeReady,
      detail: readiness.forgeReady ? "First Forge done" : "Not yet forged",
    },
    {
      key: "send",
      label: "Send",
      done: readiness.sendReady,
      detail: readiness.sendReady ? "Message sent" : "Not yet sent",
    },
    {
      key: "autoforge",
      label: "AutoForge",
      done: readiness.autoForgeComplete,
      detail: readiness.autoForgeComplete
        ? autoForgeEnabled
          ? autoForgeDryRun
            ? "Dry run active"
            : "Active"
          : "Enabled before"
        : "Optional",
    },
  ];

  // ─── Multi-Bot awareness ──────────────────────────────────────────────
  const multiBotActive = useAppStore((s) => s.multiBotEnabled && s.bots.filter((b) => b.active && b.session).length >= 2);

  return (
    <div className="border-b border-white/5 bg-[#121217]/60 backdrop-blur-sm">
      {/* Compact readiness bar — always visible */}
      <div className="px-3 py-2 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {STAGE_ORDER.map((stage) => (
            <StageDot
              key={stage}
              stage={stage}
              currentStage={readiness.stage}
              operational={readiness.operational}
            />
          ))}
        </div>
        <span className="text-[10px] font-mono text-gray-500 shrink-0">
          {readiness.operational
            ? "Ready"
            : `${readiness.essentialReadyCount}/${readiness.essentialTotal} ready`}
        </span>
        <span className="text-[11px] font-bold text-gray-300 truncate flex-1">
          {readiness.nextAction}
        </span>
        {multiBotActive && (
          <span className="text-[9px] font-bold uppercase font-mono px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30 shrink-0">
            Multi-Bot
          </span>
        )}
        {autoForgeEnabled && (
          <span
            className={cn(
              "text-[9px] font-bold uppercase font-mono px-1.5 py-0.5 rounded border shrink-0 flex items-center gap-1",
              autoForgeDryRun
                ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                : "bg-orange-500/15 text-orange-300 border-orange-500/30"
            )}
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", autoForgeDryRun ? "bg-amber-400" : "bg-orange-400 animate-pulse")} />
            {autoForgeDryRun ? "Dry Run" : "AutoForge"}
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse readiness details" : "Expand readiness details"}
          className="text-gray-500 hover:text-gray-300 transition-colors shrink-0"
        >
          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>

      {/* Expanded readiness details */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {stageItems.map((item) => (
                <div
                  key={item.key}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-lg border text-xs",
                    item.done
                      ? "bg-emerald-500/5 border-emerald-500/20 text-gray-300"
                      : item.key === "autoforge"
                        ? "bg-white/5 border-white/5 text-gray-500"
                        : "bg-orange-500/5 border-orange-500/20 text-gray-300"
                  )}
                >
                  <span
                    className={cn(
                      "w-4 h-4 rounded-full flex items-center justify-center shrink-0",
                      item.done
                        ? "bg-emerald-500/20 text-emerald-400"
                        : item.key === "autoforge"
                          ? "bg-white/5 text-gray-600"
                          : "bg-orange-500/20 text-orange-400"
                    )}
                  >
                    {item.done ? <Check className="w-3 h-3" /> : item.key === "autoforge" ? <Zap className="w-2.5 h-2.5" /> : <span className="text-[9px] font-bold">{STAGE_ORDER.indexOf(item.key) + 1}</span>}
                  </span>
                  <div className="min-w-0">
                    <div className="font-bold text-[11px]">{item.label}</div>
                    <div className="text-[9px] text-gray-500 truncate">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Studio discovery — only after operational */}
            {readiness.operational && (
              <div className="px-3 pb-3">
                <button
                  type="button"
                  onClick={() => setInterfaceMode("studio")}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition-all text-xs font-bold"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Explore Studio
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Core Tuning Controls ─────────────────────────────────────────────────

export function CoreTuningControls() {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const setAutoForgeEnabled = useAppStore((s) => s.setAutoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const isForging = useAppStore((s) => s.isForging);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const readiness = useCoreReadiness();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const providerSummary = getProviderSummary();

  const handleForge = () => {
    if (isForging) return;
    window.dispatchEvent(new CustomEvent("forge-trigger"));
  };

  const handleAutoForgeToggle = () => {
    const newVal = !autoForgeEnabled;
    setAutoForgeEnabled(newVal);
    toast.success(`AutoForge is now ${newVal ? "enabled" : "disabled"}`);
    playSfx(newVal ? "autoforge_on" : "autoforge_off");
    useAppStore.getState().addAutoForgeEvent({
      timestamp: Date.now(),
      type: "enable_disable",
      severity: "medium",
      summary: `AutoForge ${newVal ? "enabled" : "disabled"}`,
      details: { enabled: newVal },
    });
  };

  const personas = [
    { value: "Gremlin", label: "Gremlin", desc: "Troll" },
    { value: "Hype", label: "Hype Beast", desc: "Energy" },
    { value: "Analyst", label: "Analyst", desc: "Smart" },
    { value: "Short", label: "One-Worder", desc: "Clean" },
    { value: "Questioner", label: "Questioner", desc: "Curious" },
    { value: "Support", label: "Support", desc: "Warm" },
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* ─── Status summary ─────────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-white/5 space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5 text-gray-400">
            <Tv className="w-3 h-3" />
            <span className="font-bold text-gray-300">{useAppStore.getState().platform.charAt(0).toUpperCase() + useAppStore.getState().platform.slice(1)}</span>
            {useAppStore.getState().streamMetadata.channelName && (
              <span className="text-gray-500">· @{useAppStore.getState().streamMetadata.channelName}</span>
            )}
          </span>
          <span className={cn("flex items-center gap-1", readiness.platformReady ? "text-emerald-400" : "text-gray-600")}>
            <span className={cn("w-1.5 h-1.5 rounded-full", readiness.platformReady ? "bg-emerald-400" : "bg-gray-600")} />
            {readiness.platformReady ? "Connected" : "Not connected"}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5 text-gray-400">
            <Cpu className="w-3 h-3" />
            <span className="font-bold text-gray-300">{providerSummary.label}</span>
            {providerSummary.model && <span className="text-gray-500">· {providerSummary.model}</span>}
          </span>
          <span className={cn("flex items-center gap-1", readiness.aiReady ? "text-emerald-400" : "text-gray-600")}>
            <span className={cn("w-1.5 h-1.5 rounded-full", readiness.aiReady ? "bg-emerald-400" : "bg-gray-600")} />
            {readiness.aiReady ? "Ready" : providerSummary.configured ? "Configured" : "Not set"}
          </span>
        </div>
      </div>

      {/* ─── Persona ────────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 space-y-1.5">
        <div className="flex items-center gap-1 text-xs font-bold text-gray-300">
          <Bot className="w-3.5 h-3.5 text-gray-400" />
          Persona
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {personas.map((p) => {
            const active = config.primaryProfile === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  if (active) {
                    updateConfig({ primaryProfile: "none" });
                  } else {
                    updateConfig({ primaryProfile: p.value });
                    toast.success(`Profile set to ${p.label}!`);
                  }
                }}
                className={cn(
                  "flex flex-col items-center justify-center py-1.5 px-1 rounded-lg border text-[10px] font-bold transition-all",
                  active
                    ? "bg-orange-500/20 border-orange-500/50 text-orange-200 shadow-[0_0_12px_rgba(249,115,22,0.2)]"
                    : "bg-[#0a0a0f] border-white/5 text-gray-400 hover:border-orange-500/30 hover:bg-orange-500/5"
                )}
              >
                <span className="text-[11px]">{p.label}</span>
                <span className="text-[9px] font-mono opacity-60">{p.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Humor + Chaos sliders ──────────────────────────────────── */}
      <div className="px-3 py-2 space-y-3 border-t border-white/5">
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
            <span>Humor</span>
            <span className={cn(
              "font-mono text-[10px] px-2 py-0.5 rounded border",
              config.humorLevel === 100
                ? "text-yellow-400 bg-red-500/20 border-red-500/50 font-black"
                : "text-orange-400 bg-orange-500/10 border-orange-500/20"
            )}>
              {config.humorLevel === 100 ? "🔥 100%" : `${config.humorLevel}%`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={config.humorLevel}
            onChange={(e) => updateConfig({ humorLevel: parseInt(e.target.value) })}
            className="w-full accent-orange-500 cursor-pointer"
            aria-label="Humor level"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
            <span>Chaos</span>
            <span className={cn(
              "font-mono text-[10px] px-2 py-0.5 rounded border",
              config.chaosLevel === 100
                ? "text-fuchsia-300 bg-purple-500/20 border-purple-500/50 font-black"
                : "text-purple-400 bg-purple-500/10 border-purple-500/20"
            )}>
              {config.chaosLevel === 100 ? "🌀 100%" : `${config.chaosLevel}%`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={config.chaosLevel}
            onChange={(e) => updateConfig({ chaosLevel: parseInt(e.target.value) })}
            className="w-full accent-purple-500 cursor-pointer"
            aria-label="Chaos level"
          />
        </div>
      </div>

      {/* ─── Forge button ───────────────────────────────────────────── */}
      <div className="px-3 py-2.5 border-t border-white/5">
        <button
          type="button"
          onClick={handleForge}
          disabled={isForging || !readiness.aiReady}
          className={cn(
            "group relative w-full px-6 py-3 rounded-xl border font-bold text-sm transition-all overflow-hidden",
            isForging
              ? "bg-orange-500/10 border-orange-500/30 text-orange-300 forge-btn-glow"
              : readiness.aiReady
                ? "bg-gradient-to-r from-orange-500/20 to-red-500/20 border-orange-500/30 hover:border-orange-400/50 text-orange-300 hover:text-orange-200 shadow-lg hover:shadow-orange-500/10"
                : "bg-white/5 border-white/5 text-gray-600 cursor-not-allowed"
          )}
          aria-label="Forge chat variants"
        >
          {isForging && (
            <span className="absolute inset-0 overflow-hidden pointer-events-none">
              <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent forge-btn-shimmer" />
            </span>
          )}
          {isForging ? (
            <Loader2 className="w-4 h-4 inline-block mr-2 animate-spin" />
          ) : (
            <Flame className={cn("w-4 h-4 inline-block mr-2", !isForging && "group-hover:animate-pulse")} />
          )}
          {isForging ? "Forging..." : hasForgedOnce ? "Forge" : "Forge First Batch"}
        </button>
        {!readiness.aiReady && (
          <p className="text-[9px] text-gray-600 mt-1.5 text-center">
            Configure AI to enable Forge
          </p>
        )}
      </div>

      {/* ─── AutoForge ──────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 border-t border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className={cn("w-4 h-4", autoForgeEnabled ? "text-orange-400" : "text-gray-500")} />
            <div>
              <div className="text-xs font-bold text-gray-300">AutoForge</div>
              <div className="text-[9px] text-gray-500">
                {autoForgeEnabled
                  ? autoForgeDryRun
                    ? "Dry run — no real sends"
                    : "Let MADchatter decide when to speak"
                  : "Let MADchatter decide when to speak"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleAutoForgeToggle}
            role="switch"
            aria-checked={autoForgeEnabled}
            aria-label="Toggle AutoForge"
            className={cn(
              "relative w-10 h-5 rounded-full border transition-all shrink-0",
              autoForgeEnabled
                ? "bg-orange-500/30 border-orange-500/50"
                : "bg-black/40 border-white/10"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all",
                autoForgeEnabled
                  ? "left-5 bg-orange-400 shadow-[0_0_8px_rgba(249,115,22,0.5)]"
                  : "left-0.5 bg-gray-600"
              )}
            />
          </button>
        </div>
        {autoForgeEnabled && autoForgeDryRun && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[9px] text-amber-400">
            <AlertTriangle className="w-3 h-3" />
            Dry run is on — messages won't actually send. Toggle off in Studio.
          </div>
        )}
      </div>

      {/* ─── Advanced disclosure ────────────────────────────────────── */}
      <div className="border-t border-white/5">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold text-gray-500 hover:text-gray-300 transition-colors"
        >
          <span>Advanced</span>
          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", advancedOpen && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {advancedOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3 space-y-2">
                <AdvancedRow label="R34L Typing" value={`${useAppStore.getState().r34lEnabled ? "On" : "Off"}${useAppStore.getState().r34lLearningFrozen ? " · Frozen" : ""}`} />
                <AdvancedRow label="AutoMemory" value={useAppStore.getState().autoMemoryConfig?.enabled ? "On" : "Off"} />
                <AdvancedRow label="Context Tokens" value={`${useAppStore.getState().config.autoForgeContextTokens || 4000}`} />
                <AdvancedRow label="Dry Run" value={autoForgeDryRun ? "On" : "Off"} />
                <AdvancedRow label="Multi-Bot" value={useAppStore.getState().multiBotEnabled ? "On" : "Off"} />
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => useAppStore.getState().setInterfaceMode("studio")}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition-all text-[11px] font-bold"
                  >
                    Open Studio for full controls
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function AdvancedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-400 font-mono">{value}</span>
    </div>
  );
}

// ─── Activation celebration overlay ──────────────────────────────────────

export function CoreActivationCelebration() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handler = () => {
      setShow(true);
      setTimeout(() => setShow(false), 3000);
    };
    window.addEventListener("core-activation-celebration", handler);
    return () => window.removeEventListener("core-activation-celebration", handler);
  }, []);

  if (!show) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-[100] flex items-center justify-center">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 1.5, opacity: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="flex flex-col items-center gap-2"
      >
        <PartyPopper className="w-12 h-12 text-orange-400 drop-shadow-[0_0_12px_rgba(249,115,22,0.6)]" />
        <span className="text-2xl font-black text-orange-300 tracking-wider drop-shadow-[0_0_8px_rgba(249,115,22,0.4)]">
          MADchatter is live
        </span>
      </motion.div>
    </div>
  );
}
