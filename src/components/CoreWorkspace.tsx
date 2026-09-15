/**
 * CoreWorkspace — the centered, panel-free Core Mode layout.
 *
 * Core Mode is a distinct operating mode, not "Studio with fewer buttons."
 * It replaces the 3-panel layout with a single centered column that adapts
 * its hierarchy based on readiness:
 *
 *   SETUP       — Launchpad is hero (Platform/AI/Persona not all ready)
 *   ACTIVATING  — TheForge is hero, Launchpad compresses to a strip
 *   OPERATIONAL — Compact readiness strip + TheForge (all essential ready)
 *
 * Chat Pulse is always visible inline (below on narrow, side-by-side on wide).
 * Stream/Audio/Visual/Memory live in a compact bottom utility dock that opens
 * the existing floating widget system on click.
 *
 * Advanced settings are a cog icon near the readiness strip — NOT in the dock.
 * The dock = contextual senses/resources. Advanced = behavioral configuration.
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Activity,
  AlertTriangle,
  AudioLines,
  Bot,
  Brain,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Eye,
  Flame,
  FlaskConical,
  Gauge,
  GripHorizontal,
  Loader2,
  LogIn,
  LogOut,
  MessageCircle,
  MessageSquare,
  MonitorUp,
  Moon,
  Plug,
  Send,
  Settings,
  Sparkles,
  Tv,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store";
import type { Platform } from "../lib/kick";
import { sendManualMessage } from "../lib/manualSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { useCoreReadiness, type CorePhase } from "../hooks/useCoreReadiness";
import { TheForge } from "./TheForge";
import { VersionBadge } from "./VersionBadge";
import { PersonaPortrait } from "./PersonaPortrait";
import { UserAvatar, userDisplayName } from "./UserAvatar";
import { getActiveProvider, getKeys, getProviderWithKey, setActiveProvider, saveKeys, CUSTOM_OPENAI_PROVIDER } from "../lib/keys";
import { fetchAvailableModels, testProviderConnection, suggestBaseUrlFromLabel, isPresetOrDefaultUrl, type ConnectionTestResult } from "../lib/customProvider";
import { checkOllamaHealth, getCachedOllamaHealth, invalidateOllamaHealthCache } from "../lib/ollamaHealth";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { playSfx } from "../lib/sfx";
import { getCoreProviderSummary as getProviderSummary } from "../lib/coreProviderSummary";
import { switchChannel } from "../lib/channelSwitch";
import { useMediaQuery, useStudioAvailable, useEffectiveMode } from "../hooks/useMediaQuery";
import { ThemedTooltip } from "./ui/tooltip";
import { AutoCheckControls } from "./AutoCheckControls";
import { fireConfetti } from "../lib/confetti";
import logoUrl from "../../madchatter-logo1.png";

export type WidgetType = "audio" | "chat" | "visual" | "memory" | "stream";

interface CoreWorkspaceProps {
  renderWidgetContent: (widget: WidgetType, embedded?: boolean) => React.ReactNode;
  openWidgetFromDock: (widget: WidgetType, anchorEl?: HTMLElement | null) => void;
  toggleWidget: (widget: WidgetType) => void;
  openWidgets: Set<WidgetType>;
  // Auth (passed from ForgeLayout to avoid duplicate hook calls)
  activeUser: { display_name?: string; login?: string; username?: string; profile_image_url?: string } | null;
  activeAuthLoading: boolean;
  activeLoginError: string | null;
  activeLoginInProgress: boolean;
  activeLogin: () => void;
  activeLogout: () => void;
  activeClearLoginError: () => void;
  // Visual capture controls (wired to ForgeLayout's capture handlers so Core
  // can start/stop screen capture and take snapshots without Studio)
  onVisualCapture: () => void;
  onManualSnapshot: () => void;
  isVisualCapturing: boolean;
  visualCooldown: boolean;
  // Visual auto-capture mode controls
  smartLevel: number;
  onCycleSmartLevel: () => void;
  // Notifies ForgeLayout when the inline Visual panel is hidden/shown so
  // auto-capture can pause when there's nothing to display.
  onVisualInlineHiddenChange?: (hidden: boolean) => void;
}

// ─── Core/Studio beautified toggle switch ─────────────────────────────────

function CoreStudioSwitch(props: {
  mode: "core" | "studio";
  onToggle: (m: "core" | "studio") => void;
  studioAvailable: boolean;
}) {
  const isCore = props.mode === "core";
  return (
    <div
      role="group"
      aria-label="Interface mode"
      className="relative flex items-center bg-black/50 backdrop-blur-md rounded-full border border-white/10 p-1 shadow-lg"
    >
      {/* Sliding indicator */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 500, damping: 35 }}
        className={cn(
          "absolute top-1 bottom-1 rounded-full",
          isCore
            ? "left-1 right-[calc(50%+2px)] bg-gradient-to-r from-orange-500/40 to-orange-500/20 border border-orange-500/40"
            : "left-[calc(50%+2px)] right-1 bg-gradient-to-r from-cyan-500/20 to-cyan-500/40 border border-cyan-500/40"
        )}
        style={{ boxShadow: isCore ? "0 0 12px rgba(255,107,0,0.25)" : "0 0 12px rgba(34,211,238,0.25)" }}
      />
      <button
        type="button"
        onClick={() => props.onToggle("core")}
        aria-pressed={isCore}
        className={cn(
          "relative z-10 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-full transition-colors",
          isCore ? "text-orange-200" : "text-gray-500 hover:text-gray-400"
        )}
      >
        Core
      </button>
      <button
        type="button"
        onClick={() => props.onToggle("studio")}
        aria-pressed={!isCore}
        // aria-disabled (not disabled): a tap still routes through
        // setInterfaceMode → opens the "larger screen" gate overlay.
        aria-disabled={!props.studioAvailable}
        title={props.studioAvailable ? undefined : "STUDIO needs a larger screen"}
        className={cn(
          "relative z-10 px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-full transition-colors",
          !isCore
            ? "text-cyan-200"
            : props.studioAvailable
              ? "text-gray-500 hover:text-gray-400"
              : "text-gray-700 cursor-not-allowed"
        )}
      >
        Studio
      </button>
    </div>
  );
}

// ─── Stage indicator dots ─────────────────────────────────────────────────

const STAGE_ORDER: (keyof ReadinessItems)[] = ["platform", "ai", "personality", "forge", "send"];

interface ReadinessItems {
  platform: boolean;
  ai: boolean;
  personality: boolean;
  forge: boolean;
  send: boolean;
}

const STAGE_LABELS: Record<keyof ReadinessItems, string> = {
  platform: "Platform",
  ai: "AI",
  personality: "Persona",
  forge: "Forge",
  send: "Send",
};

// ─── CoreWorkspace ─────────────────────────────────────────────────────────

export function CoreWorkspace(props: CoreWorkspaceProps) {
  const { renderWidgetContent, openWidgetFromDock, toggleWidget, openWidgets } = props;
  const readiness = useCoreReadiness();
  const chatConnection = useAppStore((s) => s.tmiReadState);
  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const updateStreamMetadata = useAppStore((s) => s.updateStreamMetadata);
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const setAutoForgeEnabled = useAppStore((s) => s.setAutoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const isForging = useAppStore((s) => s.isForging);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const audioTranscript = useAppStore((s) => s.audioTranscript);
  const visualSnapshotUrl = useAppStore((s) => s.visualSnapshotUrl);
  const pinnedMemories = useAppStore((s) => s.pinnedMemories);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  // effectiveMode is what actually renders (CORE when STUDIO is unavailable).
  const interfaceMode = useEffectiveMode();
  const studioAvailable = useStudioAvailable();
  const setPersonaChosen = useAppStore((s) => s.setPersonaChosen);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [stripExpandedItem, setStripExpandedItem] = useState<string | null>(null);
  const [streamEmbedHidden, setStreamEmbedHidden] = useState(false);
  const [audioInlineHidden, setAudioInlineHidden] = useState(false);
  const [visualInlineHidden, setVisualInlineHidden] = useState(false);
  const [memoryInlineHidden, setMemoryInlineHidden] = useState(false);
  // Notify ForgeLayout when the inline Visual panel visibility changes so
  // auto-capture can pause while hidden.
  useEffect(() => {
    props.onVisualInlineHiddenChange?.(visualInlineHidden);
  }, [visualInlineHidden]);
  // Live Context region: Stream + Chat share a height (resizable together)
  const [liveContextHeight, setLiveContextHeight] = useState(324);
  const [isResizingLiveContext, setIsResizingLiveContext] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const liveContextWide = useMediaQuery("(min-width: 1100px)");
  // Ultra-wide: 4-column layout (Audio | Stream | Chat | Visual)
  const liveContextUltraWide = useMediaQuery("(min-width: 1500px)");

  // When onboarding completes (setup → activating/operational), grow the
  // Live Context region to double height so the panels get room to breathe.
  const setupGrownRef = useRef(false);
  useEffect(() => {
    if (readiness.phase !== "setup" && !setupGrownRef.current) {
      setupGrownRef.current = true;
      setLiveContextHeight((h) => Math.min(700, h * 2));
    }
  }, [readiness.phase]);

  // Celebrate completing the welcome tutorial: confetti bursts from the
  // bottom-left and bottom-right corners. Fires only on the real setup →
  // operational transition, not on mount when a returning user loads straight
  // into operational (personaChosen is persisted).
  const prevPhaseRef = useRef(readiness.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = readiness.phase;
    if (prev === "setup" && readiness.phase !== "setup") {
      fireConfetti("bottom", 140);
    }
  }, [readiness.phase]);

  const startLiveContextResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeCleanupRef.current?.();
    setIsResizingLiveContext(true);
    const startY = e.clientY;
    const startH = liveContextHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      setLiveContextHeight(Math.max(160, Math.min(700, startH + delta)));
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      resizeCleanupRef.current = null;
    };
    const onUp = () => {
      setIsResizingLiveContext(false);
      cleanup();
    };
    resizeCleanupRef.current = cleanup;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
  }, [liveContextHeight]);

  // Re-show stream embed when channel changes
  useEffect(() => {
    setStreamEmbedHidden(false);
  }, [streamMetadata?.channelName]);

  // Auto-expand the current incomplete step in Setup phase
  React.useEffect(() => {
    if (readiness.phase === "setup") {
      setExpandedStep(readiness.stage);
    } else {
      setExpandedStep(null);
    }
  }, [readiness.phase, readiness.stage]);

  const providerSummary = getProviderSummary();

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

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-transparent relative z-10">
      {/* Gold hexagon background */}
      <div className="forge-hex-bg" aria-hidden="true">
        <div className="forge-hex-sparkles" aria-hidden="true" />
      </div>

      {/* ─── Logo (top-left corner) ─────────────────────────────────────── */}
      <div className="forge-brand absolute top-3 left-4 z-20 flex items-center shrink-0 gap-2 pointer-events-none">
        <div className="forge-header-aura" />
        <img
          src={logoUrl}
          alt="MADchatter"
          className="relative z-10 h-[81px] w-auto forge-logo-glow select-none"
          style={{ opacity: 0.95 }}
        />
        <VersionBadge />
      </div>

      {/* ─── Core/Studio toggle (top-right corner) ──────────────────────── */}
      <div className="absolute top-3 right-4 z-30">
        <CoreStudioSwitch
          mode={interfaceMode}
          onToggle={(m) => setInterfaceMode(m)}
          studioAvailable={studioAvailable}
        />
      </div>

      {/* ─── Main centered area ────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto forge-scroll-main relative z-10">
        <div className="px-4 py-2 flex flex-col min-h-full gap-3">
          {/* Hero (adaptive hierarchy) — centered, constrained width */}
          <div className="max-w-5xl mx-auto w-full">
            {readiness.phase === "setup" ? (
              <CoreLaunchpadHero
                readiness={readiness}
                expandedStep={expandedStep}
                setExpandedStep={setExpandedStep}
                platform={platform}
                setPlatform={setPlatform}
                streamMetadata={streamMetadata}
                updateStreamMetadata={updateStreamMetadata}
                config={config}
                updateConfig={updateConfig}
                activeUser={props.activeUser}
                activeLogin={props.activeLogin}
                activeLogout={props.activeLogout}
                activeAuthLoading={props.activeAuthLoading}
                activeLoginInProgress={props.activeLoginInProgress}
                activeLoginError={props.activeLoginError}
                activeClearLoginError={props.activeClearLoginError}
                providerSummary={providerSummary}
                isForging={isForging}
                autoForgeEnabled={autoForgeEnabled}
                autoForgeDryRun={autoForgeDryRun}
                handleAutoForgeToggle={handleAutoForgeToggle}
              />
            ) : (
              <CoreReadinessStrip
                readiness={readiness}
                platform={platform}
                streamMetadata={streamMetadata}
                providerSummary={providerSummary}
                config={config}
                autoForgeEnabled={autoForgeEnabled}
                autoForgeDryRun={autoForgeDryRun}
                multiBotEnabled={multiBotEnabled}
                expandedItem={stripExpandedItem}
                setExpandedItem={setStripExpandedItem}
                setPlatform={setPlatform}
                updateStreamMetadata={updateStreamMetadata}
                updateConfig={updateConfig}
                activeUser={props.activeUser}
                activeLogin={props.activeLogin}
                activeLogout={props.activeLogout}
              />
            )}
            {/* TheForge stays mounted across phases — hidden during setup so its
                forge-trigger listener exists and variant state survives the transition.
                Exception: once the first Forge completes (hasForgedOnce), unhide TheForge
                so the user can review/send the variant cards before advancing to AutoForge. */}
            <div className={readiness.phase === "setup" && !hasForgedOnce ? "hidden" : "flex-1 min-h-0"}>
              <TheForge />
            </div>
          </div>

          {/* ─── Previous Cycle Decision (activating/operational only) ─────── */}
          {readiness.phase !== "setup" && <PreviousCycleDecisionPanel />}

          {/* ─── Live Context: Audio | Stream | Chat | (Memory + Visual) ───────── */}
          {/* Columns are computed dynamically from which panels are visible. */}
          {/* Right column = Memory (top) + Visual (bottom) stacked. */
          /* Hiding Visual leaves Memory with full column height, and vice versa. */}
          {(() => {
            const showStream = !!streamMetadata?.channelName && !streamEmbedHidden;
            const showAudio = showStream && liveContextUltraWide && !audioInlineHidden;
            const showRightCol = showStream && liveContextUltraWide && (!visualInlineHidden || !memoryInlineHidden);
            const showMemory = showRightCol && !memoryInlineHidden;
            const showVisual = showRightCol && !visualInlineHidden;

            // Compute grid template from visible columns (order: Audio | Stream | Chat | RightCol)
            let gridTemplate: string;
            let maxWidth: string;
            if (showAudio && showRightCol) {
              gridTemplate = "minmax(240px,0.7fr) minmax(0,1.2fr) minmax(340px,0.9fr) minmax(240px,0.7fr)";
              maxWidth = "max-w-[1800px]";
            } else if (showAudio) {
              gridTemplate = "minmax(240px,0.7fr) minmax(0,1.3fr) minmax(340px,1fr)";
              maxWidth = "max-w-[1400px]";
            } else if (showRightCol) {
              gridTemplate = "minmax(0,1.2fr) minmax(340px,0.9fr) minmax(240px,0.7fr)";
              maxWidth = "max-w-[1400px]";
            } else if (showStream && liveContextWide) {
              gridTemplate = "minmax(0,1.15fr) minmax(340px,0.85fr)";
              maxWidth = "max-w-5xl";
            } else {
              gridTemplate = "1fr";
              maxWidth = "max-w-5xl";
            }

            // Thin edge rails flag panels that exist but aren't visible inline
            // (window too narrow, or dismissed via Hide). Click to reopen.
            const showAudioEdgeHint = showStream && !showAudio;
            const showMemoryEdgeHint = showStream && !showMemory;
            const showVisualEdgeHint = showStream && !showVisual;

            return (
              <>
                <div className={cn("shrink-0 relative mx-auto w-full", maxWidth)}>
                  {/* Left edge hint — Audio transcript lives off-screen left */}
                  {showAudioEdgeHint && (
                    <ThemedTooltip content={liveContextUltraWide ? "Audio panel hidden — click to restore" : "Audio panel — hidden at this window width. Click to open"} side="right">
                      <button
                        type="button"
                        onClick={(e) => liveContextUltraWide ? setAudioInlineHidden(false) : openWidgetFromDock("audio", e.currentTarget)}
                        aria-label="Audio panel hidden — click to open"
                        className="absolute -left-3 top-1 bottom-1 w-[3px] rounded-full bg-purple-400/25 hover:bg-purple-400/70 transition-colors"
                      />
                    </ThemedTooltip>
                  )}
                <div
                  className={cn(
                    "grid gap-3 w-full",
                    !isResizingLiveContext && "transition-[height] duration-500 ease-out"
                  )}
                  style={{ height: `${liveContextHeight}px`, gridTemplateColumns: gridTemplate }}
                >
                  {/* Audio Transcript (far left) — ultra-wide only */}
                  {showAudio && (
                    <div className="rounded-xl border border-purple-500/20 bg-[#0F0F12] overflow-hidden flex flex-col min-h-0">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                          <AudioLines className="w-3.5 h-3.5 text-purple-400" />
                          Audio
                        </span>
                        <button
                          type="button"
                          onClick={() => setAudioInlineHidden(true)}
                          className="text-gray-600 hover:text-gray-400 transition-colors text-[10px] uppercase tracking-wider font-bold"
                        >
                          Hide
                        </button>
                      </div>
                      <div
                        className="flex-1 overflow-y-auto overflow-x-hidden p-3 min-h-0"
                        {...interfaceMode === "core" ? { "data-core-audio-scroll": true } : {}}
                      >
                        {renderWidgetContent("audio")}
                      </div>
                    </div>
                  )}

                  {/* Stream (left / top) */}
                  {showStream && (
                    <div className="rounded-xl border border-white/10 bg-[#0F0F12] overflow-hidden flex flex-col min-h-0">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                          <Tv className="w-3.5 h-3.5 text-orange-400" />
                          Stream — @{streamMetadata.channelName}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStreamEmbedHidden(true)}
                          className="text-gray-600 hover:text-gray-400 transition-colors text-[10px] uppercase tracking-wider font-bold"
                        >
                          Hide
                        </button>
                      </div>
                      <div className="flex-1 overflow-hidden min-h-0">
                        {renderWidgetContent("stream", true)}
                      </div>
                    </div>
                  )}

                  {/* Chat Pulse (always visible) */}
                  <div className="rounded-xl border border-teal-500/20 bg-[#0F0F12] overflow-hidden flex flex-col min-h-0">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                      <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                        <MessageSquare className="w-3.5 h-3.5 text-teal-400" />
                        Chat Pulse
                      </span>
                      <span role="status" aria-live="polite" className={cn(
                        "text-[10px] uppercase tracking-wider font-bold flex items-center gap-1",
                        readiness.platformReady ? "text-emerald-400" : chatConnection === "connecting" ? "text-amber-400" : "text-gray-500",
                      )}>
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          readiness.platformReady ? "bg-emerald-400 animate-pulse" : chatConnection === "connecting" ? "bg-amber-400 animate-pulse" : "bg-gray-700",
                        )} />
                        {readiness.platformReady ? "Connected" : chatConnection === "connecting" ? "Connecting" : chatConnection === "error" ? "Connection error" : "Not connected"}
                      </span>
                    </div>
                    <div className="flex-1 overflow-hidden overflow-x-hidden p-3 min-h-0 flex flex-col">
                      {renderWidgetContent("chat")}
                    </div>
                    <ChatPulseComposer />
                  </div>

                  {/* Far right column: Memory (top) + Visual (bottom) — ultra-wide only */}
                  {showRightCol && (
                    <div className="flex flex-col gap-3 min-h-0">
                      {/* Long-Term Memory (top) */}
                      {showMemory && (
                        <div className={cn(
                          "rounded-xl border border-blue-500/20 bg-[#0F0F12] overflow-hidden flex flex-col min-h-0",
                          showVisual ? "flex-[2]" : "flex-1"
                        )}>
                          <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                            <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                              <Brain className="w-3.5 h-3.5 text-blue-400" />
                              Memory
                              {pinnedMemories.length > 0 && (
                                <span className="text-[9px] font-bold text-blue-300 bg-blue-500/15 px-1.5 py-0.5 rounded">
                                  {pinnedMemories.length}
                                </span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => setMemoryInlineHidden(true)}
                              className="text-gray-600 hover:text-gray-400 transition-colors text-[10px] uppercase tracking-wider font-bold"
                            >
                              Hide
                            </button>
                          </div>
                          <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 min-h-0">
                            {renderWidgetContent("memory")}
                          </div>
                        </div>
                      )}

                      {/* Visual Snapshot (bottom) — sizes to its content so
                          the snapshot + analysis + History button fit without
                          an inner scrollbar; capped so it can't starve Memory
                          of all space. Memory above absorbs the remainder. */}
                      {showVisual && (
                        <div className={cn(
                          "rounded-xl border border-orange-500/20 bg-[#0F0F12] overflow-hidden flex flex-col min-h-0",
                          showMemory ? "shrink max-h-[68%]" : "flex-1"
                        )}>
                          <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                            <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                              <Eye className="w-3.5 h-3.5 text-orange-400" />
                              Visual
                            </span>
                            <span className="flex items-center gap-1">
                              <ThemedTooltip content={!readiness.aiReady ? "Set up an AI provider first (Step 3) — vision needs a model to analyze frames" : props.isVisualCapturing ? (props.visualCooldown ? "Cooldown active…" : "Snapshot the current stream frame") : "Start capture from the stream panel first"}>
                                <button
                                  type="button"
                                  onClick={() => props.onManualSnapshot()}
                                  disabled={!readiness.aiReady || !props.isVisualCapturing || props.visualCooldown}
                                  className={cn(
                                    "h-5 px-1.5 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all",
                                    readiness.aiReady && props.isVisualCapturing && !props.visualCooldown
                                      ? "text-blue-400 bg-blue-500/15 hover:bg-blue-500/25"
                                      : "text-gray-600 bg-white/5 cursor-not-allowed",
                                  )}
                                  aria-label="Take snapshot of current stream frame"
                                >
                                  <Camera className="w-3 h-3" />
                                  Snap
                                </button>
                              </ThemedTooltip>
                              <ThemedTooltip content={`${props.smartLevel === 0 ? "Fixed (60s)" : "Lite (smart)"} mode — click to switch`}>
                                <button
                                  type="button"
                                  onClick={props.onCycleSmartLevel}
                                  className={cn(
                                    "h-5 px-1.5 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all",
                                    props.smartLevel === 0
                                      ? "text-gray-400 bg-white/5 hover:bg-white/10"
                                      : "text-cyan-400 bg-cyan-500/15 hover:bg-cyan-500/25"
                                  )}
                                  aria-label="Toggle capture mode"
                                >
                                  <Sparkles className="w-3 h-3" />
                                  {props.smartLevel === 0 ? "60s" : "Lite"}
                                </button>
                              </ThemedTooltip>
                              <button
                                type="button"
                                onClick={() => setVisualInlineHidden(true)}
                                className="text-gray-600 hover:text-gray-400 transition-colors text-[10px] uppercase tracking-wider font-bold px-1"
                              >
                                Hide
                              </button>
                            </span>
                          </div>
                          <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 min-h-0">
                            {renderWidgetContent("visual")}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right edge hints — Memory + Visual live off-screen right.
                    Split mirrors the right column's 2:3 stack. */}
                {(showMemoryEdgeHint || showVisualEdgeHint) && (
                  <div className="absolute -right-3 top-1 bottom-1 w-[3px] flex flex-col gap-1.5">
                    {showMemoryEdgeHint && (
                      <ThemedTooltip content={liveContextUltraWide ? "Memory panel hidden — click to restore" : "Memory panel — hidden at this window width. Click to open"} side="left">
                        <button
                          type="button"
                          onClick={(e) => liveContextUltraWide ? setMemoryInlineHidden(false) : openWidgetFromDock("memory", e.currentTarget)}
                          aria-label="Memory panel hidden — click to open"
                          className="w-full flex-[2] rounded-full bg-blue-400/25 hover:bg-blue-400/70 transition-colors"
                        />
                      </ThemedTooltip>
                    )}
                    {showVisualEdgeHint && (
                      <ThemedTooltip content={liveContextUltraWide ? "Visual panel hidden — click to restore" : "Visual panel — hidden at this window width. Click to open"} side="left">
                        <button
                          type="button"
                          onClick={(e) => liveContextUltraWide ? setVisualInlineHidden(false) : openWidgetFromDock("visual", e.currentTarget)}
                          aria-label="Visual panel hidden — click to open"
                          className="w-full flex-[3] rounded-full bg-orange-400/25 hover:bg-orange-400/70 transition-colors"
                        />
                      </ThemedTooltip>
                    )}
                  </div>
                )}
                </div>

                {/* Resize handle for the Live Context region */}
                <div
                  onMouseDown={startLiveContextResize}
                  role="separator"
                  aria-label="Live context height"
                  aria-orientation="horizontal"
                  aria-valuemin={160}
                  aria-valuemax={700}
                  aria-valuenow={liveContextHeight}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setLiveContextHeight((height) => e.key === "Home" ? 160 : e.key === "End" ? 700
                      : Math.max(160, Math.min(700, height + (e.key === "ArrowDown" ? 20 : -20))));
                  }}
                  className={cn(
                    "shrink-0 h-2 cursor-ns-resize bg-white/[0.04] hover:bg-teal-500/50 focus-visible:bg-teal-500/50 focus-visible:outline-2 focus-visible:outline-teal-400 transition-colors flex items-center justify-center group border-t border-teal-500/10 hover:border-teal-500/40 rounded-b-xl mx-auto w-full",
                    maxWidth
                  )}
                >
                  <div className="h-1 w-10 rounded-full bg-white/15 group-hover:bg-teal-400/60 transition-colors" />
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* ─── Bottom Utility Dock ────────────────────────────────────────── */}
      <CoreUtilityDock
        openWidgetFromDock={openWidgetFromDock}
        toggleWidget={toggleWidget}
        openWidgets={openWidgets}
        audioActive={!!audioTranscript}
        visualActive={!!visualSnapshotUrl}
        memoryCount={pinnedMemories.length}
        streamActive={!!streamMetadata?.channelName && !streamEmbedHidden}
        onStreamToggle={() => setStreamEmbedHidden((h) => !h)}
        audioInlineVisible={liveContextUltraWide && !!streamMetadata?.channelName && !audioInlineHidden}
        onAudioToggle={() => setAudioInlineHidden((h) => !h)}
        visualInlineVisible={liveContextUltraWide && !!streamMetadata?.channelName && !visualInlineHidden}
        onVisualToggle={() => setVisualInlineHidden((h) => !h)}
        memoryInlineVisible={liveContextUltraWide && !!streamMetadata?.channelName && !memoryInlineHidden}
        onMemoryToggle={() => setMemoryInlineHidden((h) => !h)}
        streamInlineCapable={!!streamMetadata?.channelName}
        contextUltraWide={liveContextUltraWide && !!streamMetadata?.channelName}
      />
    </div>
  );
}

// ─── Core Header ───────────────────────────────────────────────────────────

function CoreHeader(props: {
  activeUser: CoreWorkspaceProps["activeUser"];
  activeAuthLoading: boolean;
  activeLoginError: string | null;
  activeLoginInProgress: boolean;
  activeLogin: () => void;
  activeLogout: () => void;
  activeClearLoginError: () => void;
  platform: Platform;
  setPlatform: (p: Platform) => void;
}) {
  return (
    <div className="shrink-0 border-b border-white/5 bg-[#121217]/90 backdrop-blur-md px-4 py-2 flex items-center justify-between gap-3 z-40 relative">
      {/* Logo */}
      <div className="flex items-center gap-2 shrink-0">
        <VersionBadge />
      </div>

      {/* Right: Platform + Login */}
      <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
        {/* Platform tabs */}
        <div className="flex gap-0.5 bg-black/40 rounded border border-white/5 p-0.5 shrink-0">
          {(["twitch", "kick", "joystick"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => props.setPlatform(p)}
              className={cn(
                "px-1.5 py-0.5 text-[8px] font-bold uppercase rounded transition-colors",
                props.platform === p
                  ? p === "twitch"
                    ? "bg-[#9146FF]/30 text-[#9146FF] border border-[#9146FF]/30"
                    : p === "kick"
                      ? "bg-[#53fc18]/20 text-[#53fc18] border border-[#53fc18]/30"
                      : "bg-[#FF6B35]/20 text-[#FF6B35] border border-[#FF6B35]/30"
                  : "text-gray-600 hover:text-gray-400"
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Login */}
        {props.activeAuthLoading ? (
          <div className="h-7 w-20 bg-white/5 animate-pulse rounded-md border border-white/10 shrink-0" />
        ) : props.activeUser ? (
          <div className="flex items-center h-7 rounded-md overflow-hidden border bg-[#18181B] border-white/10 min-w-0 max-w-full">
            <div className="flex items-center gap-1.5 pl-1.5 pr-2.5 min-w-0">
              <UserAvatar user={props.activeUser} platform={props.platform} sizeClass="h-5 w-5" textClass="text-[10px]" />
              <span className="text-[11px] font-bold tracking-wide text-white truncate min-w-0">
                @{userDisplayName(props.activeUser)}
              </span>
            </div>
            <button
              onClick={props.activeLogout}
              className="h-full px-2 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors shrink-0"
              aria-label="Disconnect"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={props.activeLogin}
            disabled={props.activeLoginInProgress}
            className={cn(
              "h-8 px-3 flex items-center gap-1.5 disabled:opacity-70 text-white text-[11px] font-bold uppercase tracking-wider rounded-md transition-colors",
              props.platform === "kick"
                ? "bg-[#53fc18] hover:bg-[#44d014] text-black"
                : props.platform === "joystick"
                  ? "bg-[#FF6B35] hover:bg-[#e55a25]"
                  : "bg-[#9146FF] hover:bg-[#772ce8]"
            )}
          >
            {props.activeLoginInProgress ? (
              <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <LogIn className="w-3.5 h-3.5" />
            )}
            <span>Login</span>
          </button>
        )}

        {/* Login error */}
        {props.activeLoginError && (
          <div className="absolute top-full right-0 mt-2 w-64 bg-red-950/90 border border-red-500/50 rounded-md p-2 shadow-lg z-50 flex items-start gap-2 backdrop-blur-sm">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-[11px] text-red-200 leading-snug">{props.activeLoginError}</div>
            <button
              onClick={props.activeClearLoginError}
              className="shrink-0 opacity-70 hover:opacity-100 hover:bg-white/10 p-0.5 rounded transition-colors"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared AI provider configuration data (hero + strip AI panel) ─────────

const PROVIDER_KEY_MAP: Record<string, keyof ReturnType<typeof getKeys>> = {
  gemini: "geminiKey",
  openai: "chatGptKey",
  claude: "claudeKey",
  openrouter: "openRouterKey",
};

// Per-provider key-format hints so the placeholder doesn't mislead (e.g. a
// Groq key is `gsk_…`, not `sk-…` — and Groq belongs under Custom anyway).
const PROVIDER_KEY_PLACEHOLDER: Record<string, string> = {
  gemini: "AIza...",
  openai: "sk-...",
  claude: "sk-ant-...",
  openrouter: "sk-or-...",
};

const CLOUD_PROVIDER_PILLS = [
  { id: "gemini", label: "Gemini", color: "text-blue-400" },
  { id: "openai", label: "OpenAI", color: "text-emerald-400" },
  { id: "claude", label: "Claude", color: "text-orange-400" },
  { id: "openrouter", label: "OpenRouter", color: "text-purple-400" },
  { id: "custom-openai", label: "Custom", color: "text-sky-400" },
] as const;

/** One-click switch to local Ollama. Seeds the default endpoint/model when
 *  missing so the provider is immediately usable (OllamaConfigFields then
 *  auto-repairs the model tag against the live model list). */
function activateLocalOllama() {
  setActiveProvider("ollama");
  const keys = getKeys();
  const updates: Partial<ReturnType<typeof getKeys>> = {};
  if (!keys.customBaseUrl) updates.customBaseUrl = "http://localhost:11434/v1";
  // getApiKey("ollama") returns null without a model — set the recommended
  // default; OllamaConfigFields auto-repairs it against the live model list.
  if (!keys.customModel) updates.customModel = "qwen3.5:9b";
  if (Object.keys(updates).length) saveKeys(updates);
  toast.success("Switched to local Ollama");
  playSfx("welcome_dismiss");
}

// ─── Core Launchpad Hero (Setup phase) ────────────────────────────────────
// Reimagined: channel input front and center, Ollama auto-detection,
// clear "do this next" guidance. Not a static welcome — an interactive
// fast-path to get MADchatter talking ASAP.

function useOllamaAutoDetect(): "detecting" | "available" | "unavailable" {
  const [state, setState] = useState<"detecting" | "available" | "unavailable">("detecting");
  useEffect(() => {
    let cancelled = false;
    const keys = getKeys();
    if (keys.customBaseUrl && keys.customModel) {
      const cached = getCachedOllamaHealth(keys.customBaseUrl, keys.customModel);
      if (cached && cached.state === "ready") {
        setState("available");
        return;
      }
    }
    const baseUrl = keys.customBaseUrl || "http://localhost:11434/v1";
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
    return () => { cancelled = true; };
  }, []);
  return state;
}

/** Ollama endpoint + model editor with auto-detected model chips.
 *  Self-contained: reads/saves keys directly, refreshes the model list on
 *  mount and whenever keys change. Auto-repairs a missing model so forging
 *  never fails on an unpulled tag. */
export function OllamaConfigFields() {
  const authTick = useAppStore((s) => s.authTick);
  const [url, setUrl] = useState(() => getKeys().customBaseUrl || "http://localhost:11434/v1");
  const [model, setModel] = useState(() => getKeys().customModel);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);

  const save = (next: { customBaseUrl?: string; customModel?: string }) => {
    saveKeys(next);
    invalidateOllamaHealthCache();
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keys = getKeys();
      const baseUrl = keys.customBaseUrl || "http://localhost:11434/v1";
      setChecking(true);
      const result = await checkOllamaHealth(baseUrl, keys.customModel, true).catch(() => null);
      const latest = getKeys();
      if (cancelled || latest.customBaseUrl !== keys.customBaseUrl || latest.customModel !== keys.customModel) return;
      setChecking(false);
      if (!result || result.state === "endpoint_unreachable") { setModels([]); return; }
      setModels(result.models);
      const found = result.state === "ready";
      if (result.models.length && !found) {
        const preferred =
          result.models.find((m) => m.startsWith("qwen3.5")) ??
          result.models.find((m) => m.toLowerCase().includes("qwen")) ??
          result.models[0];
        save({ customModel: preferred });
        setModel(preferred);
        toast.info(`Ollama model set to ${preferred}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authTick]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">Endpoint + model</span>
        <span className="text-[9px] text-gray-600">{checking ? "Detecting models..." : models.length ? `${models.length} model${models.length === 1 ? "" : "s"} found` : "Ollama not reachable"}</span>
      </div>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => save({ customBaseUrl: url.trim() || "http://localhost:11434/v1" })}
        placeholder="http://localhost:11434/v1"
        className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-emerald-500/50 focus:outline-none"
        aria-label="Ollama base URL"
      />
      <input
        type="text"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        onBlur={() => save({ customModel: model.trim() })}
        placeholder="model tag (e.g. qwen3.5:9b)"
        className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-emerald-500/50 focus:outline-none"
        aria-label="Ollama model"
      />
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.slice(0, 8).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setModel(m); save({ customModel: m }); }}
              className={cn(
                "px-1.5 py-0.5 rounded text-[9px] font-mono border transition-all",
                model === m
                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                  : "bg-white/5 border-white/10 text-gray-500 hover:text-gray-300",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Recommended vision-capable model for custom OpenAI-compatible endpoints
 *  (Groq, etc.). Surfaced as a highlighted chip so users running text-only
 *  providers can discover a model that accepts Visual snapshots — avoiding
 *  the "content must be a string" 400 a text model throws on image input. */
const VISION_MODEL_SUGGESTION = "qwen/qwen3.8-27b";

/** Custom OpenAI-compatible endpoint + model editor (Groq, OpenRouter,
 *  Cerebras, Together, local proxies, self-hosted gateways…).
 *  Self-contained like OllamaConfigFields: reads/saves keys directly and
 *  exposes Load Models (GET /models) + Test Connection (chat probe). */
export function CustomProviderConfigFields({ onActive }: { onActive?: () => void } = {}) {
  const authTick = useAppStore((s) => s.authTick);
  const [label, setLabel] = useState(() => getKeys().customOpenAILabel);
  const [baseUrl, setBaseUrl] = useState(() => getKeys().customOpenAIBaseUrl);
  const [apiKey, setApiKey] = useState(() => getKeys().customOpenAIKey);
  const [model, setModel] = useState(() => getKeys().customOpenAIModel);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connResult, setConnResult] = useState<ConnectionTestResult | null>(null);

  // Keep inputs in sync when keys change elsewhere (e.g. SettingsPanel save).
  useEffect(() => {
    const k = getKeys();
    setLabel(k.customOpenAILabel);
    setBaseUrl(k.customOpenAIBaseUrl);
    setApiKey(k.customOpenAIKey);
    setModel(k.customOpenAIModel);
  }, [authTick]);

  const save = (next: Record<string, string>) => {
    saveKeys(next);
    setConnResult(null);
  };

  const configured = !!(baseUrl.trim() && model.trim());

  const handleLoadModels = async () => {
    setLoadingModels(true);
    setConnResult(null);
    try {
      const result = await fetchAvailableModels({ baseUrl, apiKey });
      if (result.ok && result.models.length > 0) {
        setModels(result.models);
        toast.success(`Loaded ${result.models.length} models`);
      } else {
        setModels([]);
        toast.error(result.message || "No models found — enter a model manually.");
      }
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setConnResult(null);
    try {
      const result = await testProviderConnection({ baseUrl, apiKey, model });
      setConnResult(result);
      if (result.models.length > 0) setModels(result.models);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } finally {
      setTesting(false);
    }
  };

  const handleActivate = () => {
    if (!baseUrl.trim() || !model.trim()) {
      toast.error("Base URL and model are required");
      return;
    }
    saveKeys({
      customOpenAILabel: label.trim(),
      customOpenAIBaseUrl: baseUrl.trim(),
      customOpenAIKey: apiKey.trim(),
      customOpenAIModel: model.trim(),
    });
    setActiveProvider(CUSTOM_OPENAI_PROVIDER);
    toast.success("Custom provider saved — active");
    playSfx("welcome_dismiss");
    onActive?.();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider">OpenAI-compatible endpoint</span>
        <span className="text-[9px] text-gray-600">{models.length ? `${models.length} model${models.length === 1 ? "" : "s"} found` : "Manual entry works"}</span>
      </div>

      <input
        type="text"
        value={label}
        onChange={(e) => {
          const next = e.target.value;
          setLabel(next);
          // Autofill Base URL when the label matches a known preset and the
          // URL field is still empty or a preset default (don't clobber custom).
          // Persist immediately so the authTick resync doesn't wipe it.
          const suggested = suggestBaseUrlFromLabel(next);
          if (suggested && isPresetOrDefaultUrl(baseUrl)) {
            setBaseUrl(suggested);
            saveKeys({ customOpenAILabel: next, customOpenAIBaseUrl: suggested });
            setConnResult(null);
          }
        }}
        onBlur={() => save({ customOpenAILabel: label.trim() })}
        placeholder="Label (e.g. Groq, My Proxy) — optional"
        className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-sky-500/50 focus:outline-none"
        aria-label="Provider label"
      />
      <input
        type="text"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        onBlur={() => save({ customOpenAIBaseUrl: baseUrl.trim() })}
        placeholder="Base URL (e.g. https://api.groq.com/openai/v1)"
        className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-sky-500/50 focus:outline-none"
        aria-label="Base URL"
      />
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        onBlur={() => save({ customOpenAIKey: apiKey.trim() })}
        placeholder="API key (leave blank if none)"
        className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-sky-500/50 focus:outline-none"
        aria-label="API key"
      />
      <input
        type="text"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        onBlur={() => save({ customOpenAIModel: model.trim() })}
        placeholder="Model (e.g. openai/gpt-oss-120b)"
        className="w-full px-2.5 py-1.5 rounded-md bg-black/30 border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-sky-500/50 focus:outline-none"
        aria-label="Model"
      />

      {/* Recommended vision-capable model — always pinned first, with a
          special emblem explaining it accepts Visual snapshots. Merged ahead
          of any fetched model list so it stays highlighted at the top. */}
      {(() => {
        const list = [
          VISION_MODEL_SUGGESTION,
          ...models.filter((m) => m !== VISION_MODEL_SUGGESTION),
        ];
        return (
          <div className="flex flex-wrap gap-1">
            {list.slice(0, 11).map((m) => {
              const isSuggested = m === VISION_MODEL_SUGGESTION;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setModel(m); save({ customOpenAIModel: m }); }}
                  className={cn(
                    "px-1.5 py-0.5 rounded text-[9px] font-mono border transition-all flex items-center gap-1",
                    model === m
                      ? isSuggested
                        ? "bg-orange-500/25 border-orange-500/60 text-orange-200"
                        : "bg-sky-500/20 border-sky-500/40 text-sky-300"
                      : isSuggested
                      ? "bg-orange-500/10 border-orange-500/40 text-orange-300 hover:bg-orange-500/20"
                      : "bg-white/5 border-white/10 text-gray-500 hover:text-gray-300",
                  )}
                >
                  {isSuggested && (
                    <ThemedTooltip content="Vision-capable on Groq — accepts Visual snapshots (image input). Recommended if your text-only model rejects Forge with 'content must be a string'.">
                      <Eye className="w-3 h-3 shrink-0" />
                    </ThemedTooltip>
                  )}
                  {m}
                </button>
              );
            })}
          </div>
        );
      })()}

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleLoadModels}
          disabled={loadingModels || !baseUrl.trim()}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-200 hover:border-white/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loadingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          Models
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || !baseUrl.trim()}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-200 hover:border-white/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Test
        </button>
        <button
          type="button"
          onClick={handleActivate}
          disabled={!configured}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-sky-500/15 border border-sky-500/30 text-[10px] font-bold uppercase tracking-wider text-sky-300 hover:bg-sky-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save
        </button>
      </div>

      {connResult && (
        <div className={cn(
          "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed",
          connResult.ok
            ? "bg-green-500/10 border border-green-500/25 text-green-300"
            : "bg-red-500/10 border border-red-500/25 text-red-300",
        )}>
          {connResult.ok
            ? <Check className="w-3 h-3 mt-0.5 shrink-0" />
            : <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />}
          <span>{connResult.message}</span>
        </div>
      )}
    </div>
  );
}

// Optional automation tuning. Finishing setup preserves the user's choice
// to keep AutoForge off, preview with Dry Run, or enable live automation.

const FREQ_PRESETS = [
  { id: "quiet", label: "Quiet", desc: "8/hr · 3/10min", maxActionsPerHour: 8, maxActionsPerTenMinutes: 3, minCooldownMs: 60_000 },
  { id: "balanced", label: "Balanced", desc: "30/hr · 8/10min", maxActionsPerHour: 30, maxActionsPerTenMinutes: 8, minCooldownMs: 15_000 },
  { id: "chatty", label: "Chatty", desc: "60/hr · 15/10min", maxActionsPerHour: 60, maxActionsPerTenMinutes: 15, minCooldownMs: 8_000 },
] as const;

// Icon per frequency preset — quiet (calm), balanced (steady), chatty (talkative).
const FREQ_ICON = {
  quiet: Moon,
  balanced: Activity,
  chatty: MessageCircle,
} as const;

function AutoForgeSetupStep(props: {
  isForging: boolean;
  autoForgeEnabled: boolean;
  autoForgeDryRun: boolean;
  handleAutoForgeToggle: () => void;
  onComplete: () => void;
}) {
  const rateLimitConfig = useAppStore((s) => s.rateLimitConfig);
  const updateRateLimitConfig = useAppStore((s) => s.updateRateLimitConfig);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const setAutoForgeDryRun = useAppStore((s) => s.setAutoForgeDryRun);
  const autoForgeConfidenceThreshold = useAppStore((s) => s.autoForgeConfidenceThreshold);
  const setAutoForgeConfidenceThreshold = useAppStore((s) => s.setAutoForgeConfidenceThreshold);

  // Detect which preset is currently active
  const activePreset = FREQ_PRESETS.find(
    (p) =>
      p.maxActionsPerHour === rateLimitConfig.maxActionsPerHour &&
      p.maxActionsPerTenMinutes === rateLimitConfig.maxActionsPerTenMinutes &&
      p.minCooldownMs === rateLimitConfig.minCooldownMs,
  );

  const handleFinish = () => {
    // Automation is optional; finishing setup must also support manual sends.
    playSfx("welcome_dismiss");
    props.onComplete();
  };

  return (
    <motion.div
      key="autoforge-hero"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.3 }}
      className="w-full max-w-xl"
    >
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-300 text-xs font-bold uppercase tracking-wider mb-4">
          <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
          Step 6 of 6 · Meet your autopilot
        </div>
        <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">AutoForge — let the bot speak for itself</h2>
        <p className="text-sm text-gray-400">
          MADchatter can decide when to chime in. Try Dry Run, or finish setup with AutoForge off.
        </p>
      </div>

      <div className="space-y-3">
        {/* Enable + Dry Run */}
        <div className="p-4 rounded-xl border border-orange-500/20 bg-orange-500/[0.04]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-orange-400" />
              <span className="text-sm font-bold text-gray-200">AutoForge</span>
            </div>
            <button
              type="button"
              onClick={props.handleAutoForgeToggle}
              className="relative w-10 h-5 rounded-full border transition-all"
              style={{
                background: props.autoForgeEnabled ? "rgba(249,115,22,0.3)" : "rgba(0,0,0,0.4)",
                borderColor: props.autoForgeEnabled ? "rgba(249,115,22,0.5)" : "rgba(255,255,255,0.1)",
              }}
              aria-label="Toggle AutoForge"
              role="switch"
              aria-checked={props.autoForgeEnabled}
            >
              <span className={cn(
                "absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all",
                props.autoForgeEnabled ? "left-5 bg-orange-400" : "left-0.5 bg-gray-600",
              )} />
            </button>
          </div>
          {!props.autoForgeEnabled && (
            <p className="text-[10px] text-gray-600">
              AutoForge is optional. Keep it off for manual sends, or use Dry Run to preview its decisions.
            </p>
          )}
        </div>

        {/* Talk Frequency */}
        <div className="p-4 rounded-xl border border-white/5 bg-[#0a0a0f]">
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Talk Frequency</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {FREQ_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={activePreset?.id === p.id}
                onClick={() => {
                  updateRateLimitConfig({
                    maxActionsPerHour: p.maxActionsPerHour,
                    maxActionsPerTenMinutes: p.maxActionsPerTenMinutes,
                    minCooldownMs: p.minCooldownMs,
                  });
                  playSfx("welcome_dismiss");
                }}
                className={cn(
                  "p-2.5 rounded-lg border text-center transition-all",
                  activePreset?.id === p.id
                    ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                    : "bg-white/5 border-white/5 text-gray-500 hover:text-gray-300",
                )}
              >
                <div className="text-xs font-bold">{p.label}</div>
                <div className="text-[9px] text-gray-500 mt-0.5">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Confidence Threshold */}
        <div className="p-4 rounded-xl border border-white/5 bg-[#0a0a0f]">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Confidence Threshold</span>
            </div>
            <span className="text-xs font-mono font-bold text-purple-300">
              {autoForgeConfidenceThreshold.toFixed(1)}
            </span>
          </div>
          <input
            type="range"
            min={0.3}
            max={0.8}
            step={0.05}
            aria-label="AutoForge confidence threshold"
            value={autoForgeConfidenceThreshold}
            onChange={(e) => setAutoForgeConfidenceThreshold(parseFloat(e.target.value))}
            className="w-full accent-purple-500"
          />
          <div className="flex justify-between text-[9px] text-gray-600 mt-1">
            <span>0.3 · chatty</span>
            <span>0.8 · careful</span>
          </div>
        </div>

        {/* Dry Run — full-width toggle with beautified tooltip */}
        <ThemedTooltip
          side="top"
          align="center"
          className="max-w-[240px] leading-relaxed"
          content={
            <div className="space-y-1">
              <div className="font-bold text-amber-300">Dry Run Mode</div>
              <div className="text-[10px] text-gray-400">
                AutoForge runs its full decision loop — reading chat, scoring confidence, generating a message — but never sends anything to the channel.
                Use it to preview the bot's judgment and tune confidence/frequency before going live.
              </div>
            </div>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={autoForgeDryRun}
            aria-label="Dry Run"
            onClick={() => {
              setAutoForgeDryRun(!autoForgeDryRun);
              playSfx("welcome_dismiss");
            }}
            className={cn(
              "w-full flex items-center justify-between gap-2 p-3 rounded-xl border transition-all",
              autoForgeDryRun
                ? "bg-amber-500/10 border-amber-500/40"
                : "bg-[#0a0a0f] border-white/5 hover:border-white/10",
            )}
          >
            <div className="flex items-center gap-1.5">
              <FlaskConical className={cn("w-3.5 h-3.5", autoForgeDryRun ? "text-amber-400" : "text-gray-500")} />
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Dry Run</span>
              <span className="text-[9px] text-gray-600 leading-tight">
                {autoForgeDryRun ? "· preview only" : "· sending live"}
              </span>
            </div>
            <span
              className={cn(
                "relative w-10 h-5 rounded-full border transition-all shrink-0",
                autoForgeDryRun ? "bg-amber-500/30 border-amber-500/50" : "bg-white/5 border-white/10",
              )}
            >
              <span className={cn(
                "absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all",
                autoForgeDryRun ? "left-5 bg-amber-400" : "left-0.5 bg-gray-600",
              )} />
            </span>
          </button>
        </ThemedTooltip>

        {/* Auto-Check cadence — replaces the old implicit 15s re-check with a
            user-controlled cadence (Smart / 30s / 1m / 2m / 5m) + live progress.
            Matches the Mobile CORE tuning surface (AutoCheckControls). */}
        {props.autoForgeEnabled && (
          <div className="p-3 rounded-xl border border-white/5 bg-[#0a0a0f]">
            <AutoCheckControls variant="full" />
          </div>
        )}

        {/* Finish button */}
        <motion.button
          type="button"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleFinish}
          className="w-full py-3.5 rounded-xl font-bold text-sm transition-all bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40"
        >
          {props.autoForgeEnabled && autoForgeDryRun ? "Finish Setup (Dry Run)" : "Finish Setup"}
        </motion.button>
      </div>
    </motion.div>
  );
}

function CoreLaunchpadHero(props: {
  readiness: ReturnType<typeof useCoreReadiness>;
  expandedStep: string | null;
  setExpandedStep: (s: string | null) => void;
  platform: Platform;
  setPlatform: (p: Platform) => void;
  streamMetadata: any;
  updateStreamMetadata: (m: any) => void;
  config: any;
  updateConfig: (c: any) => void;
  activeUser: CoreWorkspaceProps["activeUser"];
  activeLogin: () => void;
  activeLogout: () => void;
  activeAuthLoading: boolean;
  activeLoginInProgress: boolean;
  activeLoginError: string | null;
  activeClearLoginError: () => void;
  providerSummary: ReturnType<typeof getProviderSummary>;
  isForging: boolean;
  autoForgeEnabled: boolean;
  autoForgeDryRun: boolean;
  handleAutoForgeToggle: () => void;
}) {
  const { readiness } = props;
  const setPersonaChosen = useAppStore((s) => s.setPersonaChosen);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const authTick = useAppStore((s) => s.authTick);
  // getActiveProvider() reads localStorage — authTick re-runs this after
  // saveKeys/setActiveProvider so provider UI stays fresh.
  const activeProvider = getActiveProvider();
  const [channelInput, setChannelInput] = useState(props.streamMetadata?.channelName || "");
  const channelInputRef = useRef<HTMLInputElement>(null);
  const ollamaState = useOllamaAutoDetect();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  // Persona step: user must click "Lock It In" to advance, not just select a persona
  const [personaStepDone, setPersonaStepDone] = useState(false);
  // Completing the optional automation step never requires enabling it.
  const [autoForgeStepDone, setAutoForgeStepDone] = useState(false);
  // Audio step (optional): user can skip or complete audio capture to advance
  const [audioStepDone, setAudioStepDone] = useState(false);
  // Forge step (skippable): user can forge OR explicitly skip to AutoForge
  const [forgeStepDone, setForgeStepDone] = useState(false);

  // Store fields for audio setup coordination (glow + progress bar)
  const setAudioSetupActive = useAppStore((s) => s.setAudioSetupActive);
  const voiceCapturing = useAppStore((s) => s.voiceCapturing);
  const whisperDownloadProgress = useAppStore((s) => s.whisperDownloadProgress);

  // ─── Setup step navigation (1-6, user can go back) ──────────────────
  // The "furthest reachable step" is derived from readiness; the user can
  // navigate freely up to that step but not past it.
  // Step 2 (Audio) is optional — audioStepDone is set by skip or capture.
  // Step 5 (Forge) is skippable — the user can advance to step 6 (AutoForge)
  // without forging, via the step-6 progress dot or the Next arrow key. Landing
  // on step 6 without forging marks forgeStepDone so setup can complete.
  const furthestStep = !readiness.platformReady ? 1
    : !audioStepDone ? 2
    : !readiness.aiReady ? 3
    : !personaStepDone ? 4
    : !autoForgeStepDone ? 6
    : 7; // setup complete
  const [setupStep, setSetupStep] = useState(1);

  // Track the furthest step we've auto-advanced TO. Auto-advance jumps
  // straight to the first incomplete step — including skipping steps that
  // were already satisfied on arrival (e.g. a saved API key). Once a
  // furthest step has been reached, we don't re-advance — manual
  // back-navigation is respected.
  const autoAdvancedToRef = useRef(1);

  // Clamp setupStep if furthestStep drops (e.g. user disconnects)
  useEffect(() => {
    if (setupStep > furthestStep) setSetupStep(furthestStep);
  }, [furthestStep, setupStep]);

  // Skipping the Forge step: the Forge step (5) is skippable, so step 6 is
  // reachable as soon as the persona is locked in. Whenever the user lands on
  // step 6 without having forged, mark the forge step done so setup can
  // complete. This covers every skip path — the step-6 progress dot, the Next
  // arrow key — without a dedicated "Skip for now" button.
  useEffect(() => {
    if (setupStep >= 6 && !hasForgedOnce && !forgeStepDone) {
      setForgeStepDone(true);
    }
  }, [setupStep, hasForgedOnce, forgeStepDone]);

  // Auto-advance to the first incomplete step (once per newly-reached step).
  // Don't auto-advance past step 5 (Forge) — after the first Forge completes,
  // the user should stay on step 5 to review/send the Forge cards before
  // manually advancing to AutoForge (step 6).
  useEffect(() => {
    const autoAdvanceTarget = Math.min(furthestStep, 5);
    if (autoAdvanceTarget > setupStep && autoAdvanceTarget > autoAdvancedToRef.current) {
      autoAdvancedToRef.current = autoAdvanceTarget;
      setSetupStep(autoAdvanceTarget);
    }
  }, [furthestStep, setupStep]);

  // Arrow-key navigation (left=back, right=forward) during setup phase
  useEffect(() => {
    if (readiness.phase !== "setup") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Skip if user is typing in an input
      const target = e.target as HTMLElement;
      if (target && (target.closest('input, textarea, select, [role="dialog"]') || target.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSetupStep((s) => Math.max(1, s - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSetupStep((s) => Math.min(furthestStep, s + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readiness.phase, furthestStep]);

  // Finish setup after the first Forge (or an explicit skip) and review of
  // optional automation. The persisted milestone then lets the regular
  // workspace take over. A skipped forge leaves hasForgedOnce false — the
  // user lands in "activating" phase with "Forge something" as next action.
  useEffect(() => {
    if ((hasForgedOnce || forgeStepDone) && personaStepDone && autoForgeStepDone) {
      setPersonaChosen(true);
    }
  }, [hasForgedOnce, forgeStepDone, personaStepDone, autoForgeStepDone, setPersonaChosen]);

  // Sync audioSetupActive to the store so StreamOverlay can glow the capture
  // button while the user is on the audio step.
  useEffect(() => {
    setAudioSetupActive(setupStep === 2 && !audioStepDone);
    return () => setAudioSetupActive(false);
  }, [setupStep, audioStepDone, setAudioSetupActive]);

  // Auto-complete the audio step when voice capture starts (user clicked the
  // glowing capture button and transcription began).
  useEffect(() => {
    if (voiceCapturing && !audioStepDone) {
      setAudioStepDone(true);
    }
  }, [voiceCapturing, audioStepDone]);

  // Auto-focus the channel input on mount if platform not ready
  useEffect(() => {
    if (!readiness.platformReady && channelInputRef.current) {
      channelInputRef.current.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setChannel = async () => {
    const trimmed = channelInput.trim().replace(/^#/, "");
    if (!trimmed) {
      toast.error("Enter a channel name");
      return;
    }
    if (!props.activeUser) {
      toast.error("Login first to connect a channel");
      return;
    }
    try {
      await switchChannel(trimmed);
      toast.success(`Watching @${trimmed}`);
      playSfx("memory_add");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not switch channels. Please try again.");
    }
  };

  const saveApiKey = (providerId: string, label: string) => {
    const key = apiKeyInput.trim();
    if (!key) {
      toast.error("Paste an API key");
      return;
    }
    const field = PROVIDER_KEY_MAP[providerId];
    if (!field) return;
    saveKeys({ [field]: key });
    setActiveProvider(providerId);
    setExpandedProvider(null);
    setApiKeyInput("");
    toast.success(`${label} key saved — provider active`);
    playSfx("welcome_dismiss");
  };

  const removeApiKey = (providerId: string, label: string) => {
    const field = PROVIDER_KEY_MAP[providerId];
    if (!field) return;
    saveKeys({ [field]: "" });
    setApiKeyInput("");
    toast.success(`${label} key removed`);
  };

  const expandedKeyField = expandedProvider ? PROVIDER_KEY_MAP[expandedProvider] : undefined;
  const expandedHasKey = !!(expandedKeyField && getKeys()[expandedKeyField]);

  return (
    <div className={cn(
      "flex flex-col items-center justify-center py-4",
      hasForgedOnce ? "min-h-0" : "min-h-[40vh]"
    )}>
      {/* ─── Setup steps (1-4, user can navigate back) ───────────────── */}
      <AnimatePresence mode="wait">
        {setupStep === 1 ? (
          <motion.div
            key="channel-hero"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-xl"
          >
            <div className="text-center mb-6">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-300 text-xs font-bold uppercase tracking-wider mb-4">
                <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
                Step 1 of 6 · Connect your stream
              </div>
              <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">Connect to a streaming platform:</h2>
            </div>

            {/* Platform tabs */}
            <div className="flex gap-2 mb-5 justify-center">
              {(["twitch", "kick", "joystick"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => props.setPlatform(p)}
                  className={cn(
                    "px-5 py-2 rounded-lg border text-sm font-bold transition-all capitalize",
                    props.platform === p
                      ? p === "twitch"
                        ? "bg-[#9146FF]/20 border-[#9146FF]/60 text-[#9146FF]"
                        : p === "kick"
                          ? "bg-[#53fc18]/20 border-[#53fc18]/60 text-[#53fc18]"
                          : "bg-[#FF6B35]/20 border-[#FF6B35]/60 text-[#FF6B35]"
                      : "bg-[#0a0a0f] border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/20"
                  )}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Login gate — above channel input, required to unlock */}
            <div className="mb-4">
              {props.activeUser ? (
                <div className="flex items-center justify-center gap-3 py-2">
                  <div className="flex items-center gap-2 text-sm text-emerald-400">
                    <span className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <Check className="w-3 h-3" />
                    </span>
                    Connected as @{props.activeUser.display_name || props.activeUser.login || props.activeUser.username}
                  </div>
                  <button
                    type="button"
                    onClick={props.activeLogout}
                    className="text-xs text-gray-500 hover:text-red-400 transition-colors px-2 py-0.5 rounded border border-white/10 hover:border-red-500/30"
                    aria-label={`Log out of ${props.platform}`}
                  >
                    Log out
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={props.activeLogin}
                  disabled={props.activeLoginInProgress || props.activeAuthLoading}
                  className={cn(
                    "w-full px-6 py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition-all disabled:opacity-70",
                    props.platform === "kick"
                      ? "bg-[#53fc18] hover:bg-[#44d014] text-black"
                      : props.platform === "joystick"
                        ? "bg-[#FF6B35] hover:bg-[#e55a25] text-white"
                        : "bg-[#9146FF] hover:bg-[#772ce8] text-white"
                  )}
                >
                  {props.activeLoginInProgress || props.activeAuthLoading ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <LogIn className="w-5 h-5" />
                      Connect {props.platform === "kick" ? "Kick" : props.platform === "joystick" ? "Joystick" : "Twitch"}
                    </>
                  )}
                </button>
              )}
              {/* Login error */}
              {props.activeLoginError && (
                <div className="mt-3 bg-red-950/80 border border-red-500/40 rounded-md p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <div className="flex-1 text-xs text-red-200 leading-snug">
                    {props.activeLoginError}
                  </div>
                  <button
                    onClick={props.activeClearLoginError}
                    className="shrink-0 opacity-70 hover:opacity-100 hover:bg-white/10 p-0.5 rounded transition-colors"
                    aria-label="Dismiss error"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* Channel input — revealed after login */}
            {props.activeUser ? (
              <div className="relative transition-all">
                <div className="text-xs text-gray-500 uppercase tracking-wider font-bold mb-2 text-center">
                  Now, which channel?
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-mono text-base">#</span>
                    <input
                      ref={channelInputRef}
                      type="text"
                      value={channelInput}
                      onChange={(e) => setChannelInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") setChannel(); }}
                      placeholder="channel name"
                      className="w-full pl-8 pr-3 py-3.5 rounded-xl bg-[#0a0a0f] border-2 text-lg text-gray-100 placeholder-gray-600 focus:outline-none transition-all shadow-lg border-orange-500/40 channel-unlock-pulse focus:border-orange-500 focus:ring-4 focus:ring-orange-500/10 shadow-orange-500/5"
                      aria-label="Channel name"
                      autoFocus
                    />
                  </div>
                  <button
                    type="button"
                    onClick={setChannel}
                    className="px-7 py-3.5 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold text-base hover:scale-105 transition-transform shadow-lg shadow-orange-500/20"
                  >
                    Watch
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2.5 text-center">
                  Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-mono">Enter</kbd> to connect
                </p>
              </div>
            ) : (
              <div className="text-center py-3 text-sm text-gray-500">
                After connecting, you'll pick a channel to watch.
              </div>
            )}
          </motion.div>
        ) : setupStep === 2 ? (
          /* ── Step 2: Audio Capture (optional) ── */
          <motion.div
            key="audio-hero"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-xl"
          >
            <div className="text-center mb-6">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-xs font-bold uppercase tracking-wider mb-4">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                Step 2 of 6 · Hear the stream
              </div>
              <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">Want audio transcription?</h2>
              <p className="text-sm text-gray-400 max-w-md mx-auto">
                Capture the stream's tab or window below to let the bot hear what's being said. Optional — the bot works on chat alone too.
              </p>
            </div>

            {voiceCapturing ? (
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <Check className="w-5 h-5" />
                  <span className="text-sm font-bold">Audio transcription is live!</span>
                </div>
                <p className="text-xs text-gray-500 text-center max-w-sm">
                  The bot can now hear the stream. You can stop capture anytime from the stream panel.
                </p>
                <button
                  type="button"
                  onClick={() => { setAudioStepDone(true); playSfx("welcome_dismiss"); }}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-orange-500 text-white font-bold text-sm hover:scale-105 transition-transform shadow-lg shadow-purple-500/20"
                >
                  Continue
                </button>
              </div>
            ) : whisperDownloadProgress !== null ? (
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center gap-2 text-purple-300">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm font-bold">Downloading Whisper model…</span>
                </div>
                <div className="w-full max-w-sm">
                  <div className="h-2.5 rounded-full bg-white/5 border border-purple-500/20 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-purple-500 to-purple-400 transition-all duration-300"
                      style={{ width: `${whisperDownloadProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-purple-300/70 text-center mt-1.5 font-mono">
                    {whisperDownloadProgress}% · ~150MB (cached after first use)
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="flex items-center gap-2 text-purple-300/80 text-xs">
                  <MonitorUp className="w-4 h-4" />
                  <span>Click the glowing <strong className="text-purple-300">Capture</strong> button on the stream panel below</span>
                </div>
                <button
                  type="button"
                  onClick={() => { setAudioStepDone(true); playSfx("welcome_dismiss"); }}
                  className="px-6 py-2.5 rounded-xl bg-white/5 border border-white/10 text-gray-300 font-bold text-sm hover:bg-white/10 hover:border-white/20 transition-all"
                >
                  Skip for now
                </button>
              </div>
            )}
          </motion.div>
        ) : setupStep === 3 ? (
          /* ── Step 3: AI — Ollama auto-detect + cloud options ── */
          <motion.div
            key="ai-hero"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-xl"
          >
            <div className="text-center mb-6">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs font-bold uppercase tracking-wider mb-4">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                Step 3 of 6 · Choose the brain
              </div>
              <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">Pick an AI to generate messages</h2>
              <p className="text-sm text-gray-400">Local (free, private) or cloud (powerful, needs a key).</p>
            </div>

            <div className="space-y-2">
              {/* Ollama — auto-detected */}
              <button
                type="button"
                onClick={activateLocalOllama}
                disabled={ollamaState === "detecting"}
                className={cn(
                  "w-full p-4 rounded-xl border-2 text-left transition-all flex items-center gap-3",
                  ollamaState === "available"
                    ? "border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/60"
                    : ollamaState === "detecting"
                      ? "border-gray-700 bg-[#0a0a0f] opacity-70"
                      : "border-white/5 bg-[#0a0a0f] hover:border-white/10"
                )}
              >
                <div className={cn(
                  "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
                  ollamaState === "available" ? "bg-emerald-500/15 text-emerald-400" : "bg-white/5 text-gray-500"
                )}>
                  {ollamaState === "detecting" ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : ollamaState === "available" ? (
                    <Check className="w-5 h-5" />
                  ) : (
                    <Cpu className="w-5 h-5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-gray-200 flex items-center gap-2">
                    Ollama (Local)
                    {ollamaState === "available" && (
                      <span className="text-[9px] font-bold uppercase text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">Detected</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {ollamaState === "detecting" ? "Scanning for local Ollama..." :
                     ollamaState === "available" ? "Free · Private · Runs on your GPU" :
                     "Not detected — install at ollama.com"}
                  </div>
                </div>
                {activeProvider === "ollama" ? (
                  <span className="text-[9px] font-bold uppercase text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded shrink-0">Active</span>
                ) : ollamaState === "available" ? (
                  <ChevronRight className="w-4 h-4 text-emerald-400" />
                ) : null}
              </button>

              {/* Ollama endpoint + model — editable inline so forging works without Studio */}
              <AnimatePresence>
                {activeProvider === "ollama" && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden mt-2"
                  >
                    <div className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04]">
                      <OllamaConfigFields />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Cloud providers */}
              <div className="p-4 rounded-xl border border-white/5 bg-[#0a0a0f]">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Cloud Providers</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {CLOUD_PROVIDER_PILLS.map((p) => {
                    const keys = getKeys();
                    const keyField = PROVIDER_KEY_MAP[p.id];
                    // Custom OpenAI-compatible is "configured" on base URL +
                    // model (API key is optional); keyed providers check the
                    // stored key directly.
                    const hasKey = p.id === "custom-openai"
                      ? !!(keys.customOpenAIBaseUrl && keys.customOpenAIModel)
                      : !!(keyField && keys[keyField]);
                    const isActive = activeProvider === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          const opening = expandedProvider !== p.id;
                          // Always toggle the input — keyed providers pre-fill the
                          // saved key (masked) so it can be viewed/updated/removed.
                          setExpandedProvider(opening ? p.id : null);
                          setApiKeyInput(opening ? ((keyField && keys[keyField]) || "") : "");
                          if (opening) setTimeout(() => apiKeyInputRef.current?.focus(), 50);
                          if (hasKey) {
                            setActiveProvider(p.id);
                            if (opening) toast.success(`Switched to ${p.label}`);
                            playSfx("welcome_dismiss");
                          }
                        }}
                        className={cn(
                          "flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-bold transition-all",
                          isActive && hasKey
                            ? "bg-white/10 border-white/20 text-white"
                            : expandedProvider === p.id
                              ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
                              : "bg-white/5 border-white/5 text-gray-400 hover:text-gray-300"
                        )}
                      >
                        <span className={p.color}>{p.label}</span>
                        {hasKey ? (
                          expandedProvider === p.id
                            ? <ChevronDown className="w-3 h-3" />
                            : p.id === "custom-openai" ? (
                              // No single key to mask — the key is optional and
                              // config lives in base URL + model.
                              <span
                                className="flex items-center gap-1 text-[9px] font-mono text-emerald-400"
                                title={`${keys.customOpenAILabel || "Custom"} configured — click to view/edit`}
                              >
                                <Check className="w-3 h-3" />configured
                              </span>
                            ) : (
                              <span
                                className="flex items-center gap-1 text-[9px] font-mono text-emerald-400"
                                title={`Saved ${p.label} key ending in ${String(keys[keyField]).slice(-4)} — click to view/edit`}
                              >
                                <Check className="w-3 h-3" />••{String(keys[keyField]).slice(-4)}
                              </span>
                            )
                        ) : expandedProvider === p.id ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <span className="text-[9px] text-gray-600">
                            {p.id === "custom-openai" ? "endpoint" : "needs key"}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Inline API key input — expands when provider clicked without key.
                    Custom OpenAI-compatible expands a full endpoint form instead. */}
                <AnimatePresence>
                  {expandedProvider && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      {expandedProvider === CUSTOM_OPENAI_PROVIDER ? (
                        <div className="mt-3 pt-3 border-t border-white/5">
                          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                            Custom OpenAI-compatible — Groq, OpenRouter, proxies…
                          </div>
                          <CustomProviderConfigFields onActive={() => setExpandedProvider(null)} />
                        </div>
                      ) : (
                        <div className="mt-3 pt-3 border-t border-white/5">
                          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                            {expandedHasKey
                              ? `${expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1)} API key — saved`
                              : `Paste your ${expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1)} API key`}
                          </div>
                          <div className="flex gap-2">
                            <input
                              ref={apiKeyInputRef}
                              type="password"
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveApiKey(expandedProvider, expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1));
                                if (e.key === "Escape") { setExpandedProvider(null); setApiKeyInput(""); }
                              }}
                              placeholder={PROVIDER_KEY_PLACEHOLDER[expandedProvider] ?? "API key..."}
                              className="flex-1 px-3 py-2 rounded-lg bg-[#0a0a0f] border border-white/10 text-sm text-gray-200 placeholder-gray-700 focus:border-cyan-500/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/10"
                              aria-label={`${expandedProvider} API key`}
                            />
                            <button
                              type="button"
                              onClick={() => saveApiKey(expandedProvider, expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1))}
                              className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/30 text-xs font-bold transition-all"
                            >
                              {expandedHasKey ? "Update" : "Save"}
                            </button>
                            {expandedHasKey && (
                              <button
                                type="button"
                                onClick={() => removeApiKey(expandedProvider, expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1))}
                                className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 text-xs font-bold transition-all"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                          <p className="text-[9px] text-gray-600 mt-1.5">
                            {expandedHasKey && <span className="text-emerald-500/70">Key saved from a previous session. </span>}
                            Press <kbd className="px-1 py-0.5 rounded bg-white/10 text-[9px] font-mono">Enter</kbd> to save · <kbd className="px-1 py-0.5 rounded bg-white/10 text-[9px] font-mono">Esc</kbd> to cancel
                          </p>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        ) : setupStep === 4 ? (
          /* ── Step 4: Personality ── */
          <motion.div
            key="persona-hero"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-xl"
          >
            <div className="text-center mb-6">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300 text-xs font-bold uppercase tracking-wider mb-4">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                Step 4 of 6 · Give it a vibe
              </div>
              <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">Choose a personality</h2>
              <p className="text-sm text-gray-400">This shapes how MADchatter talks. You can change it anytime.</p>
            </div>
            <PersonalityGrid
              config={props.config}
              updateConfig={props.updateConfig}
              actionButton={
                <motion.button
                  type="button"
                  whileHover={props.config.primaryProfile && props.config.primaryProfile !== "none" ? { scale: 1.04 } : undefined}
                  whileTap={props.config.primaryProfile && props.config.primaryProfile !== "none" ? { scale: 0.98 } : undefined}
                  onClick={() => {
                    if (props.config.primaryProfile && props.config.primaryProfile !== "none") {
                      setPersonaStepDone(true);
                      setSetupStep((s) => Math.max(s, 5));
                      playSfx("forge_start");
                    }
                  }}
                  disabled={!props.config.primaryProfile || props.config.primaryProfile === "none"}
                  className={cn(
                    "group relative px-6 py-3 rounded-xl font-bold text-sm transition-all overflow-hidden whitespace-nowrap",
                    props.config.primaryProfile && props.config.primaryProfile !== "none"
                      ? "bg-gradient-to-r from-purple-500 to-orange-500 text-white shadow-lg shadow-purple-500/20 hover:shadow-purple-500/40"
                      : "bg-white/5 border border-white/5 text-gray-600 cursor-not-allowed"
                  )}
                >
                  {props.config.primaryProfile && props.config.primaryProfile !== "none" && (
                    <span className="absolute inset-0 overflow-hidden pointer-events-none">
                      <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent forge-btn-shimmer" />
                    </span>
                  )}
                  <span className="relative flex items-center gap-2">
                    {props.config.primaryProfile && props.config.primaryProfile !== "none" ? "Lock It In" : "Pick a persona"}
                    {props.config.primaryProfile && props.config.primaryProfile !== "none" && <ChevronRight className="w-4 h-4" />}
                  </span>
                </motion.button>
              }
            />
          </motion.div>
        ) : setupStep === 5 ? (
          /* ── Step 5: First Forge ── */
          <motion.div
            key="forge-hero"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-xl"
          >
            <div className="text-center mb-3">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-300 text-xs font-bold uppercase tracking-wider mb-3">
                <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
                Step 5 of 6 · Let's make some noise
              </div>
              {hasForgedOnce ? (
                <>
                  <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">Pick a card to send</h2>
                  <p className="text-sm text-gray-400">
                    Your Forge variants are ready below. Send one to chat, or skip ahead to AutoForge.
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-3xl font-bold text-gray-100 mb-2 tracking-tight">Forge your first batch</h2>
                  <p className="text-sm text-gray-400">
                    Everything's set. Generate AI chat variants from the live context below.
                  </p>
                </>
              )}
            </div>
            <div className="flex flex-col items-center gap-3">
              <motion.button
                type="button"
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => window.dispatchEvent(new CustomEvent("forge-trigger"))}
                disabled={props.isForging}
                className="group relative px-10 py-4 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold text-base transition-all shadow-lg shadow-orange-500/20 hover:shadow-orange-500/40 overflow-hidden disabled:opacity-70"
              >
                {props.isForging && (
                  <span className="absolute inset-0 overflow-hidden pointer-events-none">
                    <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent forge-btn-shimmer" />
                  </span>
                )}
                <span className="relative flex items-center gap-2">
                  {props.isForging
                    ? <Loader2 className="w-5 h-5 animate-spin" />
                    : <Flame className="w-5 h-5" />}
                  {props.isForging ? "Forging..." : hasForgedOnce ? "Forge" : "Forge First Batch"}
                </span>
              </motion.button>
              <p className="text-[10px] text-gray-600">
                {hasForgedOnce
                  ? <>or press <kbd className="px-1 py-0.5 rounded bg-white/10 text-[9px] font-mono">F</kbd></>
                  : <>press <kbd className="px-1 py-0.5 rounded bg-white/10 text-[9px] font-mono">F</kbd> to forge · skip ahead to step 6 anytime</>}
              </p>
            </div>
          </motion.div>
        ) : setupStep === 6 ? (
          /* ── Step 6: AutoForge — lite config ── */
          <AutoForgeSetupStep
            isForging={props.isForging}
            autoForgeEnabled={props.autoForgeEnabled}
            autoForgeDryRun={props.autoForgeDryRun}
            handleAutoForgeToggle={props.handleAutoForgeToggle}
            onComplete={() => setAutoForgeStepDone(true)}
          />
        ) : null}
      </AnimatePresence>

      {/* ─── Progress indicator + Back button (clickable to navigate) ─── */}
      {readiness.phase === "setup" && (
        <div className="flex items-center gap-3 mt-6">
          {/* Back button — left of the progress dots */}
          {setupStep > 1 && (
            <button
              type="button"
              onClick={() => setSetupStep((s) => Math.max(1, s - 1))}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold text-gray-300 hover:text-orange-300 hover:bg-orange-500/10 border border-white/5 hover:border-orange-500/30 transition-all"
              aria-label="Go back to previous step"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
          )}
          {[
            { done: readiness.platformReady, label: "Channel", hint: "connect stream", step: 1 },
            { done: audioStepDone, label: "Audio", hint: "hear stream", step: 2 },
            { done: readiness.aiReady, label: "AI", hint: "choose brain", step: 3 },
            { done: personaStepDone, label: "Persona", hint: "set vibe", step: 4 },
            { done: hasForgedOnce, label: "Forge", hint: "first message", step: 5 },
            { done: autoForgeStepDone, label: "AutoForge", hint: "autopilot", step: 6 },
          ].map((s, i) => {
            const reachable = s.step <= furthestStep;
            const isCurrent = s.step === setupStep;
            return (
              <React.Fragment key={s.label}>
                <button
                  type="button"
                  onClick={() => reachable && setSetupStep(s.step)}
                  disabled={!reachable}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all",
                    s.done ? "text-emerald-300" : "text-gray-400",
                    isCurrent && "ring-1 ring-orange-500/40 bg-orange-500/10",
                    reachable && !isCurrent && "hover:bg-white/5 cursor-pointer",
                    !reachable && "cursor-not-allowed opacity-50"
                  )}
                >
                  <span className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center text-[10px]",
                    s.done ? "bg-emerald-500/20" : "bg-white/5"
                  )}>
                    {s.done ? <Check className="w-3 h-3" /> : <span>{i + 1}</span>}
                  </span>
                  <span className="hidden sm:flex flex-col items-start leading-tight">
                    <span>{s.label}</span>
                    <span className="text-[9px] font-normal text-gray-600">{s.hint}</span>
                  </span>
                  <span className="sm:hidden">{s.label}</span>
                </button>
                {i < 5 && <ChevronRight className="w-3.5 h-3.5 text-gray-700" />}
              </React.Fragment>
            );
          })}
          {setupStep < 6 && (
            <button
              type="button"
              onClick={() => {
                // Step 5 (Forge) is skippable — clicking Next without forging
                // marks the step done and advances straight to AutoForge.
                if (setupStep === 5 && !hasForgedOnce && !forgeStepDone) {
                  setForgeStepDone(true);
                  setSetupStep(6);
                  return;
                }
                setSetupStep((s) => Math.min(furthestStep, s + 1));
              }}
              disabled={setupStep + 1 > furthestStep && !(setupStep === 5 && !hasForgedOnce)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all border",
                setupStep + 1 <= furthestStep || (setupStep === 5 && !hasForgedOnce)
                  ? "text-orange-200 bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/30 hover:border-orange-500/50"
                  : "text-gray-700 cursor-not-allowed border-transparent",
              )}
              aria-label="Go to next step"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Personality Grid (shared between hero and strip) ─────────────────────

export const PERSONA_SCENARIO = "The streamer whiffs an easy shot in an FPS";

export const PERSONA_DATA = [
  { value: "Gremlin", label: "Gremlin", desc: "Troll", color: "hover:border-red-500/40 hover:bg-red-500/10", activeColor: "bg-red-500/15 border-red-500/50 text-red-200 shadow-[0_0_20px_rgba(239,68,68,0.25)]", fontClass: "italic font-black lowercase tracking-tight", image: "https://madchatter.fun/assets/gremlin.gif", imageStatic: "https://madchatter.fun/assets/gremlin.png", example: "bro really aimed at the concept of aiming and still missed 💀" },
  { value: "Hype", label: "Hype Beast", desc: "Energy", color: "hover:border-orange-500/40 hover:bg-orange-500/10", activeColor: "bg-orange-500/15 border-orange-500/50 text-orange-200 shadow-[0_0_20px_rgba(249,115,22,0.25)]", fontClass: "font-black uppercase tracking-wider", image: "https://madchatter.fun/assets/hype_beast.gif", imageStatic: "https://madchatter.fun/assets/hype_beast.png", example: "NO WAY THAT WAS ACTUALLY INSANE LMAOOO 🔥" },
  { value: "Analyst", label: "Analyst", desc: "Smart", color: "hover:border-blue-500/40 hover:bg-blue-500/10", activeColor: "bg-blue-500/15 border-blue-500/50 text-blue-200 shadow-[0_0_20px_rgba(59,130,246,0.25)]", fontClass: "font-medium tracking-wide", image: "https://madchatter.fun/assets/analyst.gif", imageStatic: "https://madchatter.fun/assets/analyst.png", example: "crosshair was off-center — flicked left when the target went right" },
  { value: "Short", label: "One-Worder", desc: "Clean", color: "hover:border-teal-500/40 hover:bg-teal-500/10", activeColor: "bg-teal-500/15 border-teal-500/50 text-teal-200 shadow-[0_0_20px_rgba(20,184,166,0.25)]", fontClass: "font-light tracking-normal", image: "https://madchatter.fun/assets/one-worder.gif", imageStatic: "https://madchatter.fun/assets/one-worder.png", example: "tragic." },
  { value: "Questioner", label: "Questioner", desc: "Curious", color: "hover:border-purple-500/40 hover:bg-purple-500/10", activeColor: "bg-purple-500/15 border-purple-500/50 text-purple-200 shadow-[0_0_20px_rgba(168,85,247,0.25)]", fontClass: "italic font-semibold tracking-wide", image: "https://madchatter.fun/assets/questioner.gif", imageStatic: "https://madchatter.fun/assets/questioner.png", example: "did you actually think that shot was gonna hit?" },
  { value: "Support", label: "Support", desc: "Warm", color: "hover:border-green-500/40 hover:bg-green-500/10", activeColor: "bg-green-500/15 border-green-500/50 text-green-200 shadow-[0_0_20px_rgba(34,197,94,0.25)]", fontClass: "font-bold tracking-normal", image: "https://madchatter.fun/assets/support.gif", imageStatic: "https://madchatter.fun/assets/support.png", example: "you'll get the next one, shake it off" },
] as const;

function PersonalityGrid(props: { config: any; updateConfig: (c: any) => void; actionButton?: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2.5">
        {PERSONA_DATA.map((p) => {
          const active = props.config.primaryProfile === p.value;
          return (
            <ThemedTooltip
              key={p.value}
              side="bottom"
              align="center"
              sideOffset={6}
              closeOnPopupHover
              content={
                <div className="text-left space-y-1.5 max-w-[280px]">
                  <div className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Same scenario</div>
                  <p className="text-[11px] text-gray-300 italic leading-snug">"{PERSONA_SCENARIO}"</p>
                  <div className="text-[9px] text-gray-500 uppercase tracking-wider font-bold pt-1 border-t border-white/5">{p.label} would say</div>
                  <p className="text-[11px] text-gray-200 font-mono leading-snug">"{p.example}"</p>
                </div>
              }
            >
              <motion.button
                type="button"
                aria-pressed={active}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  if (active) {
                    props.updateConfig({ primaryProfile: "none" });
                  } else {
                    props.updateConfig({ primaryProfile: p.value });
                    toast.success(`Profile: ${p.label}`);
                    playSfx("memory_add");
                  }
                }}
                className={cn(
                  "group relative flex flex-col items-center justify-center gap-2 py-4 px-2 rounded-xl border-2 transition-all overflow-hidden",
                  active ? p.activeColor : cn("bg-[#0a0a0f] border-white/5 text-gray-400", p.color)
                )}
              >
                {/* Portrait — animated on hover/active */}
                <PersonaPortrait image={p.image} still={p.imageStatic} active={active} size={64} />
                <div className="flex flex-col items-center gap-0.5">
                  <span className={cn("text-sm", p.fontClass)}>{p.label}</span>
                  <span className="text-[9px] font-mono opacity-60 uppercase tracking-wider">{p.desc}</span>
                </div>
                {/* Active checkmark badge */}
                {active && (
                  <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-white/10 flex items-center justify-center">
                    <Check className="w-2.5 h-2.5" />
                  </span>
                )}
              </motion.button>
            </ThemedTooltip>
          );
        })}
      </div>
      {/* Sliders + action button — same row to save vertical space */}
      <div className="p-3 rounded-xl border border-white/5 bg-[#0a0a0f] flex items-center gap-3">
        <div className="flex-1 space-y-2">
          <div>
            <div className="flex justify-between text-[11px] font-bold text-gray-300 mb-1">
              <span>Humor</span>
              <span className="font-mono text-orange-400">{props.config.humorLevel}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={props.config.humorLevel}
              onChange={(e) => props.updateConfig({ humorLevel: parseInt(e.target.value) })}
              className="w-full accent-orange-500 cursor-pointer"
              aria-label="Humor level"
            />
          </div>
          <div>
            <div className="flex justify-between text-[11px] font-bold text-gray-300 mb-1">
              <span>Chaos</span>
              <span className="font-mono text-purple-400">{props.config.chaosLevel}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={props.config.chaosLevel}
              onChange={(e) => props.updateConfig({ chaosLevel: parseInt(e.target.value) })}
              className="w-full accent-purple-500 cursor-pointer"
              aria-label="Chaos level"
            />
          </div>
        </div>
        {props.actionButton}
      </div>
    </div>
  );
}

// ─── Previous Cycle Decision — floating draggable overlay ──────────────────
// Shows the last AutoForgeDecision — what the bot decided, confidence, reason,
// and when. No Director Notes — purely decision telemetry. Draggable via the
// header grip; position is kept in local state (not persisted).

function PreviousCycleDecisionPanel() {
  const lastDecision = useAppStore((s) => s.lastAutoForgeDecision);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const [expanded, setExpanded] = useState(true);
  const [sending, setSending] = useState(false);

  // ── Drag state ──────────────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Default position: bottom-right area, above the status bar
  useEffect(() => {
    if (!pos && panelRef.current) {
      const rect = panelRef.current.getBoundingClientRect();
      setPos({
        top: Math.max(80, window.innerHeight - rect.height - 100),
        left: Math.max(16, window.innerWidth - rect.width - 24),
      });
    }
  }, [pos]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (!panelRef.current) return;
    e.preventDefault();
    const rect = panelRef.current.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
    if (!pos) setPos({ top: rect.top, left: rect.left });
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const x = e.clientX - dragOffsetRef.current.x;
      const y = e.clientY - dragOffsetRef.current.y;
      const rect = panelRef.current?.getBoundingClientRect();
      const w = rect?.width ?? 300;
      const h = rect?.height ?? 200;
      setPos({
        top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
        left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      });
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // ── Send the dry-run payload as a manual message ──────────────────────
  const handleSendPayload = async () => {
    if (!lastDecision?.action_payload || sending) return;
    const channel = streamMetadata?.channelName;
    if (!channel) { toast.error("No channel connected"); return; }
    setSending(true);
    try {
      const { sendManualMessage } = await import("../lib/manualSend");
      await sendManualMessage({ message: lastDecision.action_payload, channel, source: "manual" });
      toast.success("Sent to chat");
      playSfx("welcome_dismiss");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const decision = lastDecision?.decision || "none";
  const confidence = lastDecision?.confidence ?? 0;
  const reason = lastDecision?.reason || "—";
  const ts = lastDecision?.timestamp ? new Date(lastDecision.timestamp).toLocaleTimeString() : "—";
  const nextMins = lastDecision?.estimated_next_action_minutes ?? 0;
  const activityLevel = lastDecision?.activityLevel ?? 0;

  const decisionLabel =
    decision === "speak" ? "Speak"
    : decision === "stay_silent" || decision === "deliberate_silence" ? "Silent"
    : decision === "short_reaction" ? "Reaction"
    : decision === "emote_only" ? "Emote"
    : decision === "quick_followup" ? "Followup"
    : decision === "meta_observation" ? "Meta"
    : decision === "joke_callback" ? "Joke"
    : decision === "full_forge" ? "Forge"
    : decision.replace(/_/g, " ");

  const decisionColor =
    decision === "speak" || decision === "full_forge" || decision === "short_reaction" || decision === "emote_only" || decision === "quick_followup"
      ? "text-emerald-400"
      : decision === "stay_silent" || decision === "deliberate_silence"
      ? "text-gray-500"
      : "text-cyan-400";
  const decisionBg =
    decision === "speak" || decision === "full_forge" || decision === "short_reaction" || decision === "emote_only" || decision === "quick_followup"
      ? "bg-emerald-500/10 border-emerald-500/20"
      : decision === "stay_silent" || decision === "deliberate_silence"
      ? "bg-white/5 border-white/5"
      : "bg-cyan-500/10 border-cyan-500/20";
  const confColor = confidence >= 0.7 ? "bg-emerald-500" : confidence >= 0.4 ? "bg-yellow-500" : "bg-red-500";

  const panelW = expanded ? 340 : 280;

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, delay: 0.5 }}
      className={cn(
        "fixed z-[60] rounded-xl border backdrop-blur-md shadow-2xl select-none",
        decisionBg,
        dragging && "opacity-80 shadow-3xl",
      )}
      style={{
        width: panelW,
        top: pos?.top ?? "auto",
        left: pos?.left ?? "auto",
        bottom: pos ? "auto" : 80,
        right: pos ? "auto" : 24,
        cursor: dragging ? "grabbing" : "default",
      }}
    >
      {/* Drag handle / header */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing min-w-0"
        role="button"
        aria-label="Drag panel"
        tabIndex={0}
      >
        <GripHorizontal className="w-3.5 h-3.5 text-gray-600 shrink-0" />
        <Brain className={cn("w-4 h-4 shrink-0", decisionColor)} />
        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider shrink-0">
          Last Cycle
        </span>
        <span
          title={decision}
          className={cn("text-[11px] font-bold px-1.5 py-0.2 rounded bg-white/5 border border-white/10 shrink-0", decisionColor)}
        >
          {decisionLabel}
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 pl-1">
          <span className="text-[9px] text-gray-500 font-mono">{ts}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="p-0.5 rounded hover:bg-white/10"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronDown className={cn("w-3.5 h-3.5 text-gray-500 transition-transform", expanded && "rotate-180")} />
          </button>
        </span>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2.5">
              {!lastDecision ? (
                <div className="text-[10px] text-gray-500">
                  {autoForgeEnabled ? "Waiting for first check…" : "AutoForge is off"}
                </div>
              ) : (
                <>
                  {/* Confidence bar */}
                  <div>
                    <div className="flex justify-between text-[9px] text-gray-500 mb-1">
                      <span>Confidence</span>
                      <span className="font-mono font-bold text-gray-400">{(confidence * 100).toFixed(0)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={cn("h-full transition-all duration-500", confColor)}
                        style={{ width: `${Math.min(100, confidence * 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* Reason */}
                  <div className="text-[11px] text-gray-300 leading-relaxed">{reason}</div>

                  {/* Telemetry */}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-gray-500">
                    <span>Next: <span className="font-mono text-gray-400">{nextMins}m</span></span>
                    <span>Activity: <span className="font-mono text-gray-400">{activityLevel}/4</span></span>
                    {lastDecision.suggested_trigger && (
                      <span>Trigger: <span className="font-mono text-gray-400">{lastDecision.suggested_trigger}</span></span>
                    )}
                    {lastDecision.used_fallback_provider && (
                      <span>Fallback: <span className="font-mono text-amber-400">{lastDecision.used_fallback_provider}</span></span>
                    )}
                  </div>

                  {/* Payload + Send button — shown for ANY payload-bearing
                      decision (short_reaction, emote_only, joke_callback,
                      meta_observation, quick_followup, speak, full_forge),
                      not just "speak". Only silence decisions lack a payload.
                      Dry-run / AutoForge-off surfaces a manual send so the
                      proposed message isn't trapped in telemetry. */}
                  {lastDecision.action_payload && (
                    <div className="pt-2 border-t border-white/5">
                      <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1">Payload</div>
                      <div className="text-[11px] text-gray-300 italic leading-relaxed line-clamp-3">
                        "{lastDecision.action_payload}"
                      </div>
                      {(autoForgeDryRun || !autoForgeEnabled) && (
                        <button
                          type="button"
                          onClick={handleSendPayload}
                          disabled={sending}
                          className="mt-2 w-full py-1.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold hover:bg-emerald-500/25 transition-all disabled:opacity-50"
                        >
                          {sending ? "Sending…" : "Send to Chat"}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Forge Tray Button (readiness strip) ────────────────────────────────────
// Opens a dropdown with SMART (AI picks count) or fixed counts 1–4.
// Dispatches forge-trigger with the chosen count in the event detail.

function ForgeTrayButton() {
  const [open, setOpen] = useState(false);
  const isForging = useAppStore((s) => s.isForging);
  const trayRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const fire = (count?: number) => {
    setOpen(false);
    window.dispatchEvent(
      new CustomEvent("forge-trigger", { detail: { count } }),
    );
  };

  return (
    <div ref={trayRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={isForging}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-all",
          isForging
            ? "bg-orange-500/10 border-orange-500/20 text-orange-300 opacity-60"
            : "bg-orange-500/5 border-orange-500/20 text-orange-300 hover:bg-orange-500/10",
        )}
        aria-label="Forge variants"
      >
        <Flame className="w-3 h-3" />
        <span className="font-bold">Forge</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.95 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full left-0 mt-1 z-50 w-44 rounded-lg border border-white/10 bg-[#1a1a22] shadow-2xl overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-white/5">
              <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Generate</div>
            </div>
            {/* SMART — AI picks count */}
            <button
              type="button"
              onClick={() => fire()}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] font-bold text-orange-300 hover:bg-orange-500/10 transition-all"
            >
              <Sparkles className="w-3 h-3" />
              SMART
              <span className="ml-auto text-[9px] text-gray-600 font-normal">AI decides</span>
            </button>
            <div className="h-px bg-white/5" />
            {/* Fixed counts 1–4 */}
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => fire(n)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] font-bold text-gray-300 hover:bg-white/5 transition-all"
              >
                <span className="w-4 h-4 rounded bg-orange-500/15 border border-orange-500/30 flex items-center justify-center text-[9px] text-orange-300 font-mono">
                  {n}
                </span>
                {n} {n === 1 ? "card" : "cards"}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Channel Edit Row (readiness strip → platform panel) ──────────────────
// Uses the same archive/reset/restore flow as setup and Studio.

export function ChannelEditRow(props: {
  channelName: string;
  onSave: (name: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(props.channelName);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => setValue(props.channelName), [props.channelName]);
  const save = async () => {
    if (savingRef.current) return;
    const trimmed = value.trim().replace(/^#/, "");
    if (!trimmed) {
      toast.error("Enter a channel name");
      return;
    }
    if (trimmed === props.channelName) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await props.onSave(trimmed);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="flex gap-1">
      <div className="relative flex-1">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600 font-mono text-[11px]">#</span>
        <input
          type="text"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="channel name"
          className="w-full pl-5 pr-2 py-1.5 rounded bg-[#0a0a0f] border border-white/10 text-[11px] text-gray-200 placeholder-gray-700 focus:outline-none focus:border-orange-500/50 transition-colors"
          aria-label="Channel name"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        aria-busy={saving}
        className="px-2.5 py-1.5 rounded bg-orange-500/20 border border-orange-500/30 text-orange-300 text-[10px] font-bold hover:bg-orange-500/30 transition-all"
      >
        {saving ? "Switching…" : "Set"}
      </button>
    </div>
  );
}

// ─── Compact AI provider configurator (readiness-strip AI panel) ───────────
// Full provider switching + key management inline in Core Mode — mirrors the
// Step 3 Launchpad experience (Ollama auto-detect, cloud pills, inline key
// input, custom endpoint fields) so AI configuration never requires the
// "Open Settings (Studio)" detour.

function AIProviderCompactPanel() {
  // Subscribe to authTick so the localStorage-backed getKeys()/
  // getActiveProvider() reads below refresh after saveKeys/setActiveProvider.
  useAppStore((s) => s.authTick);

  const activeProvider = getActiveProvider();
  const keys = getKeys();
  const ollamaState = useOllamaAutoDetect();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const apiKeyInputRef = useRef<HTMLInputElement>(null);

  const saveApiKey = (providerId: string, label: string) => {
    const key = apiKeyInput.trim();
    if (!key) {
      toast.error("Paste an API key");
      return;
    }
    const field = PROVIDER_KEY_MAP[providerId];
    if (!field) return;
    saveKeys({ [field]: key });
    setActiveProvider(providerId);
    setExpandedProvider(null);
    setApiKeyInput("");
    toast.success(`${label} key saved — provider active`);
    playSfx("welcome_dismiss");
  };

  const removeApiKey = (providerId: string, label: string) => {
    const field = PROVIDER_KEY_MAP[providerId];
    if (!field) return;
    saveKeys({ [field]: "" });
    setApiKeyInput("");
    toast.success(`${label} key removed`);
    // Removing the active provider's key would leave an unconfigured provider
    // selected — fall back to the first provider that still has a key.
    if (getActiveProvider() === providerId) {
      setActiveProvider(getProviderWithKey() || "gemini");
    }
  };

  // Custom OpenAI-compatible is "configured" on base URL + model (API key is
  // optional); keyed providers check the stored key directly.
  const isProviderConfigured = (id: string) =>
    id === "custom-openai"
      ? !!(keys.customOpenAIBaseUrl && keys.customOpenAIModel)
      : !!(PROVIDER_KEY_MAP[id] && keys[PROVIDER_KEY_MAP[id]]);

  const toggleProvider = (p: (typeof CLOUD_PROVIDER_PILLS)[number]) => {
    const keyField = PROVIDER_KEY_MAP[p.id];
    const hasKey = isProviderConfigured(p.id);
    const opening = expandedProvider !== p.id;
    // Always toggle the editor — keyed providers pre-fill the saved key
    // (masked input) so it can be viewed/updated/removed.
    setExpandedProvider(opening ? p.id : null);
    setApiKeyInput(opening ? ((keyField && keys[keyField]) || "") : "");
    if (opening) setTimeout(() => apiKeyInputRef.current?.focus(), 50);
    if (hasKey) {
      setActiveProvider(p.id);
      if (opening) toast.success(`Switched to ${p.label}`);
      playSfx("welcome_dismiss");
    }
  };

  const ollamaActive = activeProvider === "ollama";

  return (
    <div className="space-y-2">
      {/* Ollama (local) — one-click switch, endpoint/model fields when active */}
      <div className={cn(
        "rounded-lg border overflow-hidden transition-all",
        ollamaActive
          ? "border-emerald-500/40 bg-emerald-500/[0.04]"
          : ollamaState === "available"
            ? "border-emerald-500/30 bg-[#0a0a0f]"
            : "border-white/5 bg-[#0a0a0f]"
      )}>
        <button
          type="button"
          onClick={activateLocalOllama}
          disabled={ollamaState === "detecting" || ollamaActive}
          aria-pressed={ollamaActive}
          className="w-full p-2.5 flex items-center gap-2.5 text-left transition-all disabled:cursor-default"
        >
          <span className={cn(
            "w-7 h-7 rounded-md flex items-center justify-center shrink-0",
            ollamaActive || ollamaState === "available" ? "bg-emerald-500/15 text-emerald-400" : "bg-white/5 text-gray-500"
          )}>
            {ollamaState === "detecting" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : ollamaActive ? (
              <Check className="w-4 h-4" />
            ) : (
              <Cpu className="w-4 h-4" />
            )}
          </span>
          <span className="flex-1 min-w-0">
            <span className="text-[11px] font-bold text-gray-200 flex items-center gap-1.5">
              Ollama (Local)
              {ollamaState === "available" && (
                <span className="text-[8px] font-bold uppercase text-emerald-400 bg-emerald-500/15 px-1 py-0.5 rounded">Detected</span>
              )}
            </span>
            <span className="block text-[9px] text-gray-500 truncate">
              {ollamaState === "detecting" ? "Scanning for local Ollama..." :
               ollamaState === "available" ? "Free · Private · Runs on your GPU" :
               "Not detected — install at ollama.com"}
            </span>
          </span>
          {ollamaActive && (
            <span className="text-[8px] font-bold uppercase text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded shrink-0">Active</span>
          )}
        </button>
        <AnimatePresence>
          {ollamaActive && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-2.5 pb-2.5">
                <OllamaConfigFields />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Cloud providers — pills + inline key/endpoint editors */}
      <div className="p-2.5 rounded-lg border border-white/5 bg-[#0a0a0f]">
        <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Cloud Providers</div>
        <div className="grid grid-cols-2 gap-1.5">
          {CLOUD_PROVIDER_PILLS.map((p) => {
            const hasKey = isProviderConfigured(p.id);
            const isActive = activeProvider === p.id;
            const isExpanded = expandedProvider === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleProvider(p)}
                className={cn(
                  "flex items-center justify-between px-2 py-1.5 rounded-lg border text-[10px] font-bold transition-all",
                  isActive && hasKey
                    ? "bg-white/10 border-white/20 text-white"
                    : isExpanded
                      ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
                      : "bg-white/5 border-white/5 text-gray-400 hover:text-gray-300"
                )}
              >
                <span className={p.color}>{p.label}</span>
                {hasKey ? (
                  isExpanded ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : p.id === "custom-openai" ? (
                    // No single key to mask — config lives in base URL + model.
                    <span className="flex items-center gap-0.5 text-[8px] font-mono text-emerald-400">
                      <Check className="w-3 h-3" />ok
                    </span>
                  ) : (
                    <span className="text-[8px] font-mono text-emerald-400">••{String(keys[PROVIDER_KEY_MAP[p.id]]).slice(-4)}</span>
                  )
                ) : isExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <span className="text-[8px] text-gray-600">{p.id === "custom-openai" ? "endpoint" : "needs key"}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Inline editor — key input for keyed providers, endpoint form for Custom */}
        <AnimatePresence>
          {expandedProvider && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              {expandedProvider === CUSTOM_OPENAI_PROVIDER ? (
                <div className="mt-2 pt-2 border-t border-white/5">
                  <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                    Custom OpenAI-compatible — Groq, OpenRouter, proxies…
                  </div>
                  <CustomProviderConfigFields onActive={() => setExpandedProvider(null)} />
                </div>
              ) : (
                <div className="mt-2 pt-2 border-t border-white/5">
                  <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                    {isProviderConfigured(expandedProvider)
                      ? `${expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1)} API key — saved`
                      : `Paste your ${expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1)} API key`}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      ref={apiKeyInputRef}
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveApiKey(expandedProvider, expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1));
                        if (e.key === "Escape") { setExpandedProvider(null); setApiKeyInput(""); }
                      }}
                      placeholder={PROVIDER_KEY_PLACEHOLDER[expandedProvider] ?? "API key..."}
                      className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-[#0a0a0f] border border-white/10 text-[11px] font-mono text-gray-200 placeholder-gray-700 focus:border-cyan-500/50 focus:outline-none"
                      aria-label={`${expandedProvider} API key`}
                    />
                    <button
                      type="button"
                      onClick={() => saveApiKey(expandedProvider, expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1))}
                      className="px-2.5 py-1.5 rounded-md bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/30 text-[10px] font-bold transition-all shrink-0"
                    >
                      {isProviderConfigured(expandedProvider) ? "Update" : "Save"}
                    </button>
                    {isProviderConfigured(expandedProvider) && (
                      <button
                        type="button"
                        onClick={() => removeApiKey(expandedProvider, expandedProvider.charAt(0).toUpperCase() + expandedProvider.slice(1))}
                        className="px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 text-[10px] font-bold transition-all shrink-0"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="text-[8px] text-gray-600 mt-1">
                    {isProviderConfigured(expandedProvider) && <span className="text-emerald-500/70">Key saved from a previous session. </span>}
                    Press <kbd className="px-1 py-0.5 rounded bg-white/10 text-[8px] font-mono">Enter</kbd> to save · <kbd className="px-1 py-0.5 rounded bg-white/10 text-[8px] font-mono">Esc</kbd> to cancel
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Core Readiness Strip (Activating/Operational) ────────────────────────

// Next-check bar color: short = hot/green (about to fire), long = cool/red.
// Mirrors AutoForgeHUD's nextCheckBarColor so the Core chip matches the HUD.
function coreNextCheckBarColor(secs: number): string {
  if (secs <= 10) return 'bg-emerald-500';
  if (secs <= 30) return 'bg-yellow-500';
  if (secs <= 90) return 'bg-orange-500';
  return 'bg-red-500';
}

function CoreReadinessStrip(props: {
  readiness: ReturnType<typeof useCoreReadiness>;
  platform: Platform;
  streamMetadata: any;
  providerSummary: ReturnType<typeof getProviderSummary>;
  config: any;
  autoForgeEnabled: boolean;
  autoForgeDryRun: boolean;
  multiBotEnabled: boolean;
  expandedItem: string | null;
  setExpandedItem: (s: string | null) => void;
  setPlatform: (p: Platform) => void;
  updateStreamMetadata: (m: any) => void;
  updateConfig: (c: any) => void;
  activeUser: CoreWorkspaceProps["activeUser"];
  activeLogin: () => void;
  activeLogout: () => void;
}) {
  const { readiness } = props;

  // The active persona's icon data — lets the strip chip and expanded panel
  // show the persona's actual portrait (png/gif pair) instead of a text-only label.
  const activePersona = PERSONA_DATA.find((p) => p.value === props.config.primaryProfile);

  // ── AutoForge cycle progress (thin bar under the AutoForge chip) ──────
  // Mirrors the AutoForgeHUD's NEXT CHECK progress logic so the Core header
  // shows the same cycle state at a glance: fills as the next check
  // approaches, sweeps when processing, dims when paused/waiting.
  const autoForgeNextActionMs = useAppStore((s) => s.autoForgeNextActionMs);
  const autoForgeLastActionMs = useAppStore((s) => s.autoForgeLastActionMs);
  const autoForgeAutoCheckEnabled = useAppStore((s) => s.autoForgeAutoCheckEnabled);
  const isAutoForgeThinking = useAppStore((s) => s.isAutoForgeThinking);
  const bots = useAppStore((s) => s.bots);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);

  // In multi-bot mode the legacy global pacing fields are not updated (the
  // legacy loop stands down). Derive next/last from per-bot runtimes so the
  // bar stays accurate when multiple bots are running.
  const activeBots = multiBotEnabled ? bots.filter((b) => b.active && b.session) : [];
  const rawNext = multiBotEnabled
    ? activeBots.reduce<number>((min, b) => Math.min(min, b.runtime.autoForgeNextActionMs), Infinity)
    : (autoForgeNextActionMs ?? 0);
  const effectiveNextActionMs = rawNext === Infinity ? 0 : rawNext;
  const effectiveLastActionMs = multiBotEnabled
    ? activeBots.reduce<number>((max, b) => Math.max(max, b.runtime.autoForgeLastActionMs ?? 0), 0)
    : (autoForgeLastActionMs ?? 0);
  const isProcessing = multiBotEnabled
    ? activeBots.some((b) => b.runtime.isAutoForgeThinking)
    : isAutoForgeThinking;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!props.autoForgeEnabled) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [props.autoForgeEnabled]);

  const nextCheckPaused = !autoForgeAutoCheckEnabled;
  const timeUntilNext = effectiveNextActionMs
    ? Math.max(0, Math.floor((effectiveNextActionMs - now) / 1000))
    : 0;
  const totalCycleMs = effectiveNextActionMs && effectiveLastActionMs
    ? Math.max(1000, effectiveNextActionMs - effectiveLastActionMs)
    : 0;
  const elapsedMs = effectiveLastActionMs ? Math.max(0, now - effectiveLastActionMs) : 0;
  const cyclePct = totalCycleMs ? Math.min(100, Math.round((elapsedMs / totalCycleMs) * 100)) : 0;
  const isWaiting = !nextCheckPaused && !isProcessing && timeUntilNext === 0;
  const showBar = props.autoForgeEnabled && (effectiveNextActionMs > 0 || isProcessing);

  const items: { key: string; label: string; detail: string; done: boolean; error: boolean; portrait?: { image: string; still: string } }[] = [
    {
      key: "platform",
      label: props.platform.charAt(0).toUpperCase() + props.platform.slice(1),
      detail: props.streamMetadata?.channelName ? `@${props.streamMetadata.channelName}` : "Not connected",
      done: readiness.platformReady,
      error: readiness.platformError,
    },
    {
      key: "ai",
      label: props.providerSummary.label,
      detail: props.providerSummary.model || (props.providerSummary.configured ? "Configured" : "Not configured"),
      done: readiness.aiReady,
      error: readiness.aiError,
    },
    {
      key: "personality",
      label: "Persona",
      detail: props.config.primaryProfile && props.config.primaryProfile !== "none"
        ? props.config.primaryProfile
        : "Default",
      done: readiness.personalityReady,
      error: false,
      portrait: activePersona
        ? { image: activePersona.image, still: activePersona.imageStatic }
        : undefined,
    },
  ];

  return (
    <div className="shrink-0">
      {/* Strip */}
      <div className="flex items-center gap-2 flex-wrap text-xs justify-center">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => props.setExpandedItem(props.expandedItem === item.key ? null : item.key)}
            aria-expanded={props.expandedItem === item.key}
            className={cn(
              "group flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-all",
              item.error
                ? "bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/20"
                : item.done
                  ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/10"
                  : "bg-orange-500/5 border-orange-500/20 text-orange-300 hover:bg-orange-500/10"
            )}
          >
            <span className={cn(
              "w-1.5 h-1.5 rounded-full",
              item.error ? "bg-red-400" : item.done ? "bg-emerald-400" : "bg-orange-400"
            )} />
            {item.portrait && (
              <PersonaPortrait
                image={item.portrait.image}
                still={item.portrait.still}
                active={false}
                size={20}
              />
            )}
            {item.error && <AlertTriangle className="w-3 h-3" />}
            <span className="font-bold">{item.label}</span>
            <span className="text-gray-500 hidden sm:inline">· {item.detail}</span>
          </button>
        ))}

        {/* AutoForge status — with a thin cycle progress bar hooked to
            the bottom edge. Fills as the next check approaches, sweeps
            cyan when processing, dims when paused/waiting. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => props.setExpandedItem(props.expandedItem === "autoforge" ? null : "autoforge")}
            aria-expanded={props.expandedItem === "autoforge"}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-all",
              props.autoForgeEnabled
                ? props.autoForgeDryRun
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
                  : "bg-orange-500/10 border-orange-500/30 text-orange-300 hover:bg-orange-500/20"
                : "bg-white/5 border-white/5 text-gray-500 hover:text-gray-400"
            )}
          >
            <Zap className="w-3 h-3" />
            <span className="font-bold">AutoForge</span>
            <span className="text-gray-500 hidden sm:inline">
              · {props.autoForgeEnabled ? (props.autoForgeDryRun ? "Dry Run" : "On") : "Off"}
            </span>
          </button>
          {/* Thin cycle progress bar spanning the bottom of the chip */}
          {showBar && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-md overflow-hidden pointer-events-none">
              {isProcessing ? (
                <div className="absolute inset-0 overflow-hidden">
                  <div className="absolute inset-y-0 w-1/2 bg-cyan-500 forge-processing-bar" />
                </div>
              ) : (
                <div
                  className={cn(
                    "h-full transition-all duration-1000 ease-linear",
                    nextCheckPaused ? "bg-gray-600" : isWaiting ? "bg-gray-500" : coreNextCheckBarColor(timeUntilNext),
                  )}
                  style={{ width: nextCheckPaused ? "100%" : isWaiting ? "100%" : `${cyclePct}%` }}
                />
              )}
            </div>
          )}
        </div>

        {/* Multi-Bot badge — tappable: expands a read-only bot roster.
            Multi-bot management lives in Studio, but the engine keeps running
            in Core (per-bot AutoForge, send-as-bot, merged sent log), so the
            badge doubles as the only visible signal that it's active. */}
        {props.multiBotEnabled && (
          <button
            type="button"
            onClick={() => props.setExpandedItem(props.expandedItem === "multibot" ? null : "multibot")}
            aria-expanded={props.expandedItem === "multibot"}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-bold uppercase transition-all",
              props.expandedItem === "multibot"
                ? "bg-purple-500/25 border-purple-500/50 text-purple-200"
                : "bg-purple-500/10 border-purple-500/30 text-purple-300 hover:bg-purple-500/20"
            )}
          >
            <Bot className="w-3 h-3" /> Multi-Bot
          </button>
        )}

        {/* Forge button — opens tray with SMART + fixed counts */}
        <ForgeTrayButton />
      </div>

      {/* Expanded item panel */}
      <AnimatePresence initial={false}>
        {props.expandedItem && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 p-3 rounded-lg border border-white/5 bg-[#0F0F12] max-w-sm mx-auto w-full">
              {props.expandedItem === "platform" && (
                <div className="space-y-2">
                  <div className="flex gap-1">
                    {(["twitch", "kick", "joystick"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => props.setPlatform(p)}
                        className={cn(
                          "flex-1 py-1.5 rounded border text-[10px] font-bold capitalize transition-all",
                          props.platform === p
                            ? "bg-orange-500/20 border-orange-500/40 text-orange-300"
                            : "bg-white/5 border-white/5 text-gray-500 hover:text-gray-400"
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  {props.activeUser ? (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-emerald-400 flex items-center gap-1">
                          <Check className="w-3 h-3" /> @{props.activeUser.display_name || props.activeUser.login || props.activeUser.username}
                        </span>
                        <button onClick={props.activeLogout} className="text-[10px] text-red-400 hover:text-red-300">Disconnect</button>
                      </div>
                      <div>
                        <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1">Watching channel</div>
                        <ChannelEditRow
                          channelName={props.streamMetadata?.channelName || ""}
                          onSave={async (name) => {
                            try {
                              if (await switchChannel(name)) {
                                toast.success(`Watching @${name}`);
                                playSfx("memory_add");
                              }
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "Could not switch channels. Please try again.");
                            }
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <button onClick={props.activeLogin} className="w-full py-1.5 rounded bg-orange-500/20 border border-orange-500/30 text-orange-300 text-[10px] font-bold">Login</button>
                  )}
                </div>
              )}
              {props.expandedItem === "ai" && (
                /* Inline AI provider configurator — switch providers, manage
                   keys, and edit endpoint/model right here in Core Mode. */
                <AIProviderCompactPanel />
              )}
              {props.expandedItem === "personality" && (
                /* Beautified persona picker — same portrait/typography language as
                   the Step 4 PersonalityGrid: static PNG normally, animated GIF
                   when active or hovered, per-persona colors + fonts. */
                <div className="grid grid-cols-3 gap-1.5">
                  {PERSONA_DATA.map((p) => {
                    const active = props.config.primaryProfile === p.value;
                    return (
                      <ThemedTooltip
                        key={p.value}
                        side="bottom"
                        align="center"
                        sideOffset={6}
                        closeOnPopupHover
                        content={
                          <div className="text-left space-y-1.5 max-w-[240px]">
                            <div className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Same scenario</div>
                            <p className="text-[11px] text-gray-300 italic leading-snug">"{PERSONA_SCENARIO}"</p>
                            <div className="text-[9px] text-gray-500 uppercase tracking-wider font-bold pt-1 border-t border-white/5">{p.label} would say</div>
                            <p className="text-[11px] text-gray-200 font-mono leading-snug">"{p.example}"</p>
                          </div>
                        }
                      >
                        <motion.button
                          type="button"
                          aria-pressed={active}
                          whileHover={{ scale: 1.04 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => {
                            if (active) {
                              props.updateConfig({ primaryProfile: "none" });
                            } else {
                              props.updateConfig({ primaryProfile: p.value });
                              toast.success(`Profile: ${p.label}`);
                              playSfx("memory_add");
                            }
                          }}
                          className={cn(
                            "group relative flex flex-col items-center justify-center gap-1.5 py-2.5 px-1.5 rounded-xl border transition-all overflow-hidden",
                            active ? p.activeColor : cn("bg-[#0a0a0f] border-white/5 text-gray-400", p.color)
                          )}
                        >
                          {/* Portrait — static PNG normally, animated GIF when active/hovered */}
                          <PersonaPortrait image={p.image} still={p.imageStatic} active={active} size={44} />
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={cn("text-[11px] leading-tight", p.fontClass)}>{p.label}</span>
                            <span className="text-[8px] font-mono opacity-60 uppercase tracking-wider leading-none">{p.desc}</span>
                          </div>
                          {/* Active checkmark badge */}
                          {active && (
                            <span className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-white/10 flex items-center justify-center">
                              <Check className="w-2 h-2" />
                            </span>
                          )}
                        </motion.button>
                      </ThemedTooltip>
                    );
                  })}
                </div>
              )}
              {props.expandedItem === "autoforge" && (
                <div className="space-y-2.5">
                  {/* AutoForge lite configuration — Dry Run, Auto-Check, Frequency, Confidence */}
                  <div className="rounded-lg border border-orange-500/10 bg-black/30 p-2.5">
                    <AutoForgeLiteControls />
                  </div>
                </div>
              )}
              {props.expandedItem === "multibot" && (
                <MultiBotRosterPanel />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Multi-Bot roster (read-only — management lives in Studio Mode) ────────
// Shown when the Multi-Bot chip in the readiness strip is expanded. Core keeps
// the multi-bot engine running (per-bot AutoForge, send-as-bot, merged sent
// log) but has no management UI, so this panel is a status roster with an
// escape hatch into Studio — routed through setInterfaceMode, which opens the
// StudioGateOverlay instead when the viewport can't host Studio.
function MultiBotRosterPanel() {
  const bots = useAppStore((s) => s.bots);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const studioAvailable = useStudioAvailable();

  // Sendable bots (active + signed in). Numbering matches the send-as-bot
  // squares on Forge variant cards, which enumerate this same filtered set.
  const activeBots = bots.filter((b) => b.active && b.session);

  return (
    <div className="space-y-2.5">
      <p className="text-[10px] text-gray-500 leading-snug">
        These bot identities are running in the channel — each has its own persona, memory, and AutoForge brain. Numbered badges match the send-as-bot buttons on Forge cards.
      </p>

      <div className="space-y-1.5">
        {bots.length === 0 && (
          <p className="text-[10px] text-gray-600">No bots configured.</p>
        )}
        {bots.map((bot) => {
          const sendIdx = activeBots.indexOf(bot); // -1 when not sendable
          const live = sendIdx >= 0;
          const needsAuth = bot.active && !bot.session;
          const personaId = bot.persona?.config?.primaryProfile;
          const persona = personaId && personaId !== "none" ? personaId : null;
          return (
            <div
              key={bot.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2 py-1.5",
                live ? "border-purple-500/20 bg-purple-500/[0.06]" : "border-white/5 bg-white/[0.02] opacity-60",
              )}
            >
              {/* Send-as number (VariantCard parity) — only for sendable bots */}
              {live ? (
                <span className="w-5 h-5 shrink-0 rounded-md bg-green-500/15 border border-green-500/30 text-green-300 text-[10px] font-black flex items-center justify-center">
                  {sendIdx + 1}
                </span>
              ) : (
                <span className="w-5 h-5 shrink-0 rounded-md bg-white/5 border border-white/10 text-gray-600 text-[10px] font-black flex items-center justify-center">
                  –
                </span>
              )}

              {/* Avatar — bot's platform profile picture when signed in */}
              {bot.session?.profileImageUrl ? (
                <img src={bot.session.profileImageUrl} alt="" className="w-6 h-6 rounded-full shrink-0 border border-white/10" />
              ) : (
                <span className="w-6 h-6 rounded-full shrink-0 bg-white/5 border border-white/10 flex items-center justify-center">
                  <Bot className="w-3 h-3 text-gray-500" />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold text-gray-200 truncate">{bot.label}</div>
                <div className="text-[9px] text-gray-500 truncate">
                  {bot.session?.username ? `@${bot.session.username}` : "Not signed in"}
                  {persona && <span className="text-purple-400/80"> · {persona}</span>}
                </div>
              </div>

              <span className="text-[8px] uppercase px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 font-mono shrink-0">
                {bot.platform}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1 text-[9px] font-bold uppercase shrink-0",
                  live ? "text-emerald-400" : needsAuth ? "text-amber-400" : "text-gray-600",
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", live ? "bg-emerald-400" : needsAuth ? "bg-amber-400" : "bg-gray-600")} />
                {live ? "Live" : needsAuth ? "Sign-in" : "Off"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Escape hatch into Studio — the canonical chokepoint. When the viewport
          can't host Studio this opens the StudioGateOverlay explaining why. */}
      <button
        type="button"
        onClick={() => { playSfx("hud_open"); setInterfaceMode("studio"); }}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-300 text-[10px] font-bold hover:bg-white/10 hover:text-white transition-colors"
      >
        <MonitorUp className="w-3.5 h-3.5" />
        Manage in Studio Mode
        {!studioAvailable && (
          <span className="text-gray-500 font-normal">· requires a wider window</span>
        )}
      </button>
    </div>
  );
}

// ─── AutoForge lite-config controls (shared between Step 5 and AutoForge dropdown) ─
function AutoForgeLiteControls() {
  const rateLimitConfig = useAppStore((s) => s.rateLimitConfig);
  const updateRateLimitConfig = useAppStore((s) => s.updateRateLimitConfig);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const setAutoForgeDryRun = useAppStore((s) => s.setAutoForgeDryRun);
  const autoForgeConfidenceThreshold = useAppStore((s) => s.autoForgeConfidenceThreshold);
  const setAutoForgeConfidenceThreshold = useAppStore((s) => s.setAutoForgeConfidenceThreshold);

  const activePreset = FREQ_PRESETS.find(
    (p) =>
      p.maxActionsPerHour === rateLimitConfig.maxActionsPerHour &&
      p.maxActionsPerTenMinutes === rateLimitConfig.maxActionsPerTenMinutes &&
      p.minCooldownMs === rateLimitConfig.minCooldownMs,
  );

  // Live status shown as a pill in the hero header.
  const statusLabel = !autoForgeEnabled ? "Off" : autoForgeDryRun ? "Dry Run" : "Live";

  return (
    <div className="space-y-2.5">
      {/* ── Master AutoForge — hero card with live status pill ── */}
      <button
        type="button"
        role="switch"
        aria-checked={autoForgeEnabled}
        aria-label="AutoForge"
        onClick={() => {
          const next = !autoForgeEnabled;
          useAppStore.getState().setAutoForgeEnabled(next);
          toast.success(`AutoForge ${next ? "enabled" : "disabled"}`);
          playSfx(next ? "autoforge_on" : "autoforge_off");
        }}
        className={cn(
          "group relative w-full flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all overflow-hidden",
          autoForgeEnabled
            ? "border-orange-500/40 bg-gradient-to-br from-orange-500/15 via-orange-500/[0.06] to-transparent shadow-[0_0_28px_-8px_rgba(249,115,22,0.5)]"
            : "border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]",
        )}
      >
        {autoForgeEnabled && (
          <div className="pointer-events-none absolute -top-10 -right-6 h-24 w-24 rounded-full bg-orange-500/25 blur-2xl" />
        )}
        <div className="relative flex items-center gap-2.5 min-w-0">
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all",
              autoForgeEnabled
                ? "border-orange-500/40 bg-orange-500/20 text-orange-300"
                : "border-white/10 bg-white/5 text-gray-500",
            )}
          >
            <Zap className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-gray-100">AutoForge</span>
              <span
                className={cn(
                  "rounded px-1.5 py-px text-[8px] font-black uppercase tracking-wider",
                  autoForgeEnabled
                    ? autoForgeDryRun
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-emerald-500/20 text-emerald-300"
                    : "bg-white/5 text-gray-500",
                )}
              >
                {statusLabel}
              </span>
            </span>
            <span className="truncate text-[9px] text-gray-500">
              {autoForgeEnabled ? "Decides when to chime in" : "Manual sends only"}
            </span>
          </span>
        </div>
        <span
          className={cn(
            "relative h-5 w-10 shrink-0 rounded-full border transition-all",
            autoForgeEnabled ? "border-orange-500/50 bg-orange-500/30" : "border-white/10 bg-white/5",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all",
              autoForgeEnabled ? "left-5 bg-orange-400" : "left-0.5 bg-gray-600",
            )}
          />
        </span>
      </button>

      {/* ── Dry Run ── */}
      <ThemedTooltip
        side="top"
        align="center"
        className="max-w-[240px] leading-relaxed"
        content={
          <div className="space-y-1">
            <div className="font-bold text-amber-300">Dry Run Mode</div>
            <div className="text-[10px] text-gray-400">
              AutoForge runs its full decision loop — reading chat, scoring confidence, generating a message — but never sends anything to the channel.
              Use it to preview the bot's judgment and tune confidence/frequency before going live.
            </div>
          </div>
        }
      >
        <button
          type="button"
          role="switch"
          aria-checked={autoForgeDryRun}
          aria-label="Dry Run"
          onClick={() => {
            setAutoForgeDryRun(!autoForgeDryRun);
            playSfx("welcome_dismiss");
          }}
          className={cn(
            "w-full flex items-center justify-between gap-2 rounded-xl border p-2.5 text-left transition-all",
            autoForgeDryRun
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-white/5 bg-white/[0.02] hover:border-white/10",
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <FlaskConical className={cn("h-3.5 w-3.5 shrink-0", autoForgeDryRun ? "text-amber-400" : "text-gray-500")} />
            <div className="min-w-0">
              <div className="text-[10px] font-bold text-gray-300">Dry Run</div>
              <div className="text-[8px] leading-tight text-gray-600">
                {autoForgeDryRun ? "Previewing decisions — nothing sent" : "Sending live to chat"}
              </div>
            </div>
          </div>
          <span
            className={cn(
              "relative h-5 w-9 shrink-0 rounded-full border transition-all",
              autoForgeDryRun ? "border-amber-500/50 bg-amber-500/30" : "border-white/10 bg-white/5",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all",
                autoForgeDryRun ? "left-5 bg-amber-400" : "left-0.5 bg-gray-600",
              )}
            />
          </span>
        </button>
      </ThemedTooltip>

      {/* ── Auto-Check cadence — user-controlled cadence (Smart / 30s / 1m /
          2m / 5m) + live progress. Matches the Mobile CORE tuning surface. ── */}
      {autoForgeEnabled && (
        <div className="rounded-xl border border-white/5 bg-black/30 p-2.5">
          <AutoCheckControls variant="full" />
        </div>
      )}

      {/* ── Talk Frequency ── */}
      <div className="rounded-xl border border-white/5 bg-black/30 p-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Gauge className="w-3 h-3 text-cyan-400" />
          <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400">Talk Frequency</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {FREQ_PRESETS.map((p) => {
            const Icon = FREQ_ICON[p.id];
            const active = activePreset?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  updateRateLimitConfig({
                    maxActionsPerHour: p.maxActionsPerHour,
                    maxActionsPerTenMinutes: p.maxActionsPerTenMinutes,
                    minCooldownMs: p.minCooldownMs,
                  });
                  playSfx("welcome_dismiss");
                }}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center transition-all",
                  active
                    ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200 shadow-[0_0_14px_-4px_rgba(34,211,238,0.5)]"
                    : "border-white/5 bg-white/[0.02] text-gray-500 hover:border-white/15 hover:text-gray-300",
                )}
              >
                <Icon className={cn("h-3.5 w-3.5", active ? "text-cyan-300" : "text-gray-600")} />
                <span className="text-[10px] font-bold leading-none">{p.label}</span>
                <span className="text-[8px] leading-none text-gray-600">{p.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Confidence Threshold ── */}
      <div className="rounded-xl border border-white/5 bg-black/30 p-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Brain className="w-3 h-3 text-purple-400" />
            <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400">Confidence</span>
          </div>
          <span className="rounded bg-purple-500/15 px-1.5 py-px font-mono text-[10px] font-bold text-purple-300">
            {autoForgeConfidenceThreshold.toFixed(1)}
          </span>
        </div>
        <input
          type="range"
          min={0.3}
          max={0.8}
          step={0.05}
          aria-label="AutoForge confidence threshold"
          value={autoForgeConfidenceThreshold}
          onChange={(e) => setAutoForgeConfidenceThreshold(parseFloat(e.target.value))}
          className="w-full accent-purple-500"
        />
        <div className="mt-0.5 flex justify-between text-[8px] text-gray-600">
          <span>0.3 · chatty</span>
          <span>0.8 · careful</span>
        </div>
      </div>
    </div>
  );
}

// ─── Core Utility Dock (bottom, 4 icons) ──────────────────────────────────

function CoreUtilityDock(props: {
  openWidgetFromDock: (w: WidgetType, anchorEl?: HTMLElement | null) => void;
  toggleWidget: (w: WidgetType) => void;
  openWidgets: Set<WidgetType>;
  audioActive: boolean;
  visualActive: boolean;
  memoryCount: number;
  streamActive: boolean;
  onStreamToggle: () => void;
  audioInlineVisible: boolean;
  onAudioToggle: () => void;
  visualInlineVisible: boolean;
  onVisualToggle: () => void;
  memoryInlineVisible: boolean;
  onMemoryToggle: () => void;
  // Whether each surface can render inline right now. Stream renders inline
  // whenever a channel is set (it stacks above Chat on narrow screens);
  // Audio/Visual/Memory only render inline on ultra-wide (4-column layout).
  streamInlineCapable: boolean;
  contextUltraWide: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close the settings popover on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [settingsOpen]);

  // Settings toggles for Core users — read from the store so they stay in
  // sync with Studio and the persisted state.
  const cursorTrailEnabled = useAppStore((s) => s.cursorTrailEnabled);
  const setCursorTrailEnabled = useAppStore((s) => s.setCursorTrailEnabled);
  const sfxEnabled = useAppStore((s) => s.sfxEnabled);
  const setSfxEnabled = useAppStore((s) => s.setSfxEnabled);
  const messageSoundEnabled = useAppStore((s) => s.messageSoundEnabled);
  const setMessageSoundEnabled = useAppStore((s) => s.setMessageSoundEnabled);
  const desktopNotificationsEnabled = useAppStore((s) => s.desktopNotificationsEnabled);
  const setDesktopNotificationsEnabled = useAppStore((s) => s.setDesktopNotificationsEnabled);
  const smartRepliesEnabled = useAppStore((s) => s.smartRepliesEnabled);
  const setSmartRepliesEnabled = useAppStore((s) => s.setSmartRepliesEnabled);
  const r34lEnabled = useAppStore((s) => s.r34lEnabled);
  const setR34lEnabled = useAppStore((s) => s.setR34lEnabled);
  const ttsEnabled = useAppStore((s) => s.ttsEnabled);
  const setTtsEnabled = useAppStore((s) => s.setTtsEnabled);
  const dockIcons: { widget: WidgetType; icon: React.ReactNode; label: string; active: boolean; badge?: string }[] = [
    { widget: "stream", icon: <Tv className="w-4 h-4" />, label: "Stream", active: props.streamActive },
    { widget: "audio", icon: <AudioLines className="w-4 h-4" />, label: "Audio", active: props.audioActive },
    { widget: "visual", icon: <Eye className="w-4 h-4" />, label: "Visual", active: props.visualActive },
    { widget: "memory", icon: <Brain className="w-4 h-4" />, label: "Memory", active: props.memoryCount > 0, badge: props.memoryCount > 0 ? String(props.memoryCount) : undefined },
  ];

  // A dock button toggles inline visibility only when its surface can actually
  // render inline right now. Otherwise it opens/closes the floating widget —
  // without this gate the button silently did nothing on narrower screens.
  const isInline = (w: WidgetType): boolean =>
    w === "stream" ? props.streamInlineCapable
      : w === "audio" || w === "visual" || w === "memory" ? props.contextUltraWide
      : false;
  const inlineActive = (w: WidgetType): boolean =>
    w === "stream" ? props.streamActive
      : w === "audio" ? props.audioInlineVisible
      : w === "visual" ? props.visualInlineVisible
      : w === "memory" ? props.memoryInlineVisible
      : false;
  const inlineToggle = (w: WidgetType): void =>
    w === "stream" ? props.onStreamToggle()
      : w === "audio" ? props.onAudioToggle()
      : w === "visual" ? props.onVisualToggle()
      : w === "memory" ? props.onMemoryToggle()
      : undefined;

  return (
    <div className="shrink-0 border-t border-white/5 bg-[#121217]/90 backdrop-blur-md px-4 py-2 z-30 relative">
      <div className="max-w-5xl mx-auto flex items-center justify-center gap-2">
        {dockIcons.map((item) => {
          const isOpen = props.openWidgets.has(item.widget);
          const inline = isInline(item.widget);
          const active = inline ? inlineActive(item.widget) : isOpen;
          return (
            <button
              key={item.widget}
              type="button"
              onClick={(e) => {
                if (inline) {
                  inlineToggle(item.widget);
                } else if (isOpen) {
                  props.toggleWidget(item.widget);
                } else {
                  props.openWidgetFromDock(item.widget, e.currentTarget);
                }
              }}
              className={cn(
                "relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-all",
                active
                  ? "bg-orange-500/15 border-orange-500/30 text-orange-300"
                  : "bg-white/5 border-white/5 text-gray-400 hover:text-gray-300 hover:bg-white/10"
              )}
              aria-label={`${item.label} widget`}
              aria-expanded={active}
            >
              <span className={cn(item.active && !active && "text-teal-400")}>
                {item.icon}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider">{item.label}</span>
              {/* Activity indicator (data present but not actively shown) */}
              {item.active && !active && (
                <span className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
              )}
              {/* Inline active indicator */}
              {inline && active && (
                <span className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
              )}
              {/* Badge */}
              {item.badge && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-blue-500/30 border border-blue-500/50 text-[9px] font-bold text-blue-200 flex items-center justify-center">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}

        {/* Settings cog — right side of the footer */}
        <div ref={settingsRef} className="absolute right-4 top-1/2 -translate-y-1/2">
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-label="Settings"
            aria-expanded={settingsOpen}
            className={cn(
              "p-1.5 rounded-lg border transition-all",
              settingsOpen
                ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-300"
                : "bg-white/5 border-white/5 text-gray-500 hover:text-gray-400 hover:bg-white/10"
            )}
          >
            <Settings className="w-4 h-4" />
          </button>

          <AnimatePresence>
            {settingsOpen && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.15 }}
                className="absolute bottom-full right-0 mb-2 w-64 rounded-xl border border-white/10 bg-[#0F0F12] shadow-2xl overflow-hidden"
              >
                <div className="px-3 py-2 border-b border-white/5 bg-white/[0.02]">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Settings</span>
                </div>
                <div className="p-2 space-y-1 max-h-[60vh] overflow-y-auto themed-scroll">
                  <DockSettingsToggle
                    label="Mouse Cursor Trail"
                    description="Animated cursor with particle trail"
                    value={cursorTrailEnabled}
                    onToggle={() => {
                      const next = !cursorTrailEnabled;
                      setCursorTrailEnabled(next);
                      toast.success(`Mouse trail ${next ? "enabled" : "disabled"}`);
                    }}
                  />
                  <DockSettingsToggle
                    label="Sound Effects"
                    description="UI interaction sounds"
                    value={sfxEnabled}
                    onToggle={() => {
                      const next = !sfxEnabled;
                      setSfxEnabled(next);
                      if (next) playSfx("welcome_dismiss");
                    }}
                  />
                  <DockSettingsToggle
                    label="Message Sound"
                    description="Ping on new messages"
                    value={messageSoundEnabled}
                    onToggle={() => setMessageSoundEnabled(!messageSoundEnabled)}
                  />
                  <DockSettingsToggle
                    label="Desktop Notifications"
                    description="OS notifications for key events"
                    value={desktopNotificationsEnabled}
                    onToggle={() => setDesktopNotificationsEnabled(!desktopNotificationsEnabled)}
                  />
                  <DockSettingsToggle
                    label="Smart Replies"
                    description="Suggest replies to mentions"
                    value={smartRepliesEnabled}
                    onToggle={() => setSmartRepliesEnabled(!smartRepliesEnabled)}
                  />
                  <DockSettingsToggle
                    label="R34L Typing"
                    description="Simulated typing delay"
                    value={r34lEnabled}
                    onToggle={() => setR34lEnabled(!r34lEnabled)}
                  />
                  <DockSettingsToggle
                    label="Text-to-Speech"
                    description="Read bot messages aloud"
                    value={ttsEnabled}
                    onToggle={() => setTtsEnabled(!ttsEnabled)}
                  />
                </div>
                <div className="px-3 py-2 border-t border-white/5 bg-white/[0.02]">
                  <button
                    type="button"
                    onClick={() => {
                      useAppStore.getState().setInterfaceMode("studio");
                      setSettingsOpen(false);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 text-[10px] font-bold text-cyan-300 hover:text-cyan-200 transition-colors"
                  >
                    Open Studio for full controls
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─── Dock Settings Toggle ──────────────────────────────────────────────────
function DockSettingsToggle(props: {
  label: string;
  description: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      role="switch"
      aria-checked={props.value}
      aria-label={props.label}
      className="w-full flex items-center justify-between text-left px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
    >
      <div className="min-w-0 pr-2">
        <div className="text-[11px] font-bold text-gray-300 truncate">{props.label}</div>
        <div className="text-[9px] text-gray-600 truncate">{props.description}</div>
      </div>
      <span
        className={cn(
          "shrink-0 relative w-8 h-4 rounded-full border transition-all",
          props.value
            ? "bg-cyan-500/30 border-cyan-500/40"
            : "bg-white/5 border-white/10"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 w-3 h-3 rounded-full transition-all",
            props.value
              ? "left-4 bg-cyan-400"
              : "left-0.5 bg-gray-600"
          )}
        />
      </span>
    </button>
  );
}

// ─── Chat Pulse Composer ────────────────────────────────────────────────────
// Compact live-chat composer at the bottom of the Chat Pulse panel in CORE
// mode. Uses the canonical sendManualMessage pipeline — no CORE-specific
// send path. Draft state is local (survives rerenders, not persisted).
function ChatPulseComposer() {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const platform = useAppStore((s) => s.platform);
  const channelName = useAppStore((s) => s.streamMetadata?.channelName);
  const chatConnection = useAppStore((s) => s.tmiReadState);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const bots = useAppStore((s) => s.bots);
  const messageSoundEnabled = useAppStore((s) => s.messageSoundEnabled);
  const ttsEnabled = useAppStore((s) => s.ttsEnabled);

  // Determine if sending is available. The sendManualMessage pipeline
  // already validates bot/session state and throws descriptive errors,
  // but we disable the composer proactively for a better UX.
  const connected = chatConnection === "connected";
  const hasChannel = !!channelName?.trim();

  // Multi-bot: need at least one active, signed-in bot for the platform.
  // Joystick is single-session (no per-bot sending).
  const usesBots = multiBotEnabled && platform !== "joystick";
  const availableBots = bots.filter((b) => b.active && b.session && b.platform === platform);
  const canSend = connected && hasChannel && (!usesBots || availableBots.length > 0);

  const disabledReason = !hasChannel
    ? "No channel connected"
    : !connected
      ? chatConnection === "connecting"
        ? "Connecting to chat…"
        : "Chat not connected"
      : usesBots && availableBots.length === 0
        ? "No active bot for this platform"
        : null;

  const handleSend = useCallback(async () => {
    const msg = draft.trim();
    if (!msg || sending || !channelName?.trim()) return;
    setError(null);
    setSending(true);
    try {
      await sendManualMessage({ message: msg, channel: channelName, source: "manual" });
      if (messageSoundEnabled && platform === "joystick") playMessageSound();
      if (ttsEnabled) speakMessage(msg);
      setDraft("");
      // Re-focus for rapid follow-up
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      setError(errMsg);
      // Don't clear the draft on failure — user may want to retry
    } finally {
      setSending(false);
    }
  }, [draft, sending, channelName, messageSoundEnabled, ttsEnabled, platform]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline. Stop propagation so
    // global hotkeys (F=Forge, P=Snap, etc.) don't fire while typing.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Auto-grow textarea up to a max height, then scroll
  const adjustHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 96) + "px";
  }, []);

  return (
    <div className="shrink-0 border-t border-white/5 bg-[#121217]/90 px-2 py-1.5">
      <div className="flex items-end gap-1.5">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={adjustHeight}
          onInput={(e) => e.stopPropagation()}
          placeholder={disabledReason || "Send a message…"}
          disabled={!canSend || sending}
          rows={1}
          aria-label="Chat message"
          className={cn(
            "flex-1 min-w-0 resize-none bg-white/5 border rounded-lg px-2.5 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-teal-500/40 focus:bg-white/[0.07] transition-all",
            error ? "border-red-500/40" : "border-white/10",
            (!canSend || sending) && "opacity-50 cursor-not-allowed",
          )}
          style={{ maxHeight: "96px" }}
        />
        <ThemedTooltip content={canSend ? "Send message" : disabledReason || "Send unavailable"}>
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend || sending || !draft.trim()}
            aria-label="Send message"
            className={cn(
              "shrink-0 h-7 w-7 flex items-center justify-center rounded-lg border transition-all",
              sending
                ? "bg-teal-500/5 border-teal-500/20 text-teal-400/50"
                : canSend && draft.trim()
                  ? "text-teal-400 bg-teal-500/10 hover:bg-teal-500/20 border-teal-500/20 hover:border-teal-500/40"
                  : "text-gray-600 bg-white/5 border-white/5 cursor-not-allowed",
            )}
          >
            {sending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Send className="w-3.5 h-3.5" />}
          </button>
        </ThemedTooltip>
      </div>
      {error && (
        <div className="mt-1 text-[9px] text-red-400/80 truncate" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
