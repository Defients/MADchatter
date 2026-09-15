/**
 * CoreMobileWorkspace — First-class mobile layout for MADchatter CORE Mode.
 *
 * Dedicated portrait/landscape smartphone and tablet experience (320px–768px).
 * Preserves the 3 primary workspaces: Context → Forge → Tuning.
 *
 * Flow:
 *   Sticky Header
 *   ↓
 *   Active CORE Workspace (Context / Forge / Tuning — all kept mounted, zero state loss)
 *   ↓
 *   Persistent Status / Telemetry Strip (with expandable details drawer)
 *   ↓
 *   Persistent Bottom Navigation (safe-area compliant, large touch targets)
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Brain,
  Zap,
  Sparkles,
  Flame,
  Bot,
  Tv,
  Cpu,
  Search,
  X,
  Send,
  Loader2,
  LogIn,
  LogOut,
  ChevronDown,
  ChevronUp,
  Volume2,
  VolumeX,
  ExternalLink,
  MonitorUp,
  StopCircle,
  Camera,
  AlertCircle,
  Pin,
  Star,
  Coins,
  Trash2,
  AlertTriangle,
  Clock,
  FlaskConical,
  VolumeOff,
  Radio,
  Sliders,
  GripHorizontal,
  Check,
} from "lucide-react";
import { useAppStore, selectMultiBotActive } from "../store";
import { useCoreReadiness } from "../hooks/useCoreReadiness";
import { useEffectiveMode, useStudioAvailable } from "../hooks/useMediaQuery";
import { getCoreProviderSummary } from "../lib/coreProviderSummary";
import { getActiveProvider, getKeys, setActiveProvider, saveKeys, getProviderWithKey } from "../lib/keys";
import { sendManualMessage } from "../lib/manualSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { playSfx } from "../lib/sfx";
import { switchChannel } from "../lib/channelSwitch";
import { getPlatformSendFn } from "../lib/platformSend";
import { refineSuggestion, visionRequest } from "../lib/ai";
import { fetchStreamThumbnailDataUrl } from "../lib/streamThumbnail";
import { cn } from "../lib/utils";
import { toast } from "sonner";
import { VersionBadge } from "./VersionBadge";
import { VariantCard } from "./VariantCard";
import { EmoteText } from "./EmoteText";
import { ChannelEditRow, PERSONA_DATA, CustomProviderConfigFields } from "./CoreWorkspace";
import { PersonaPortrait } from "./PersonaPortrait";
import { AutoCheckControls } from "./AutoCheckControls";
import { UserAvatar, userDisplayName } from "./UserAvatar";
import { TheForge } from "./TheForge";
import logoUrl from "../../madchatter-logo1.png";

// Color maps for sentiment
const SENTIMENT_DOT_COLORS: Record<string, string> = {
  hype: "bg-red-400",
  positive: "bg-emerald-400",
  neutral: "bg-blue-400",
  chill: "bg-teal-400",
  confused: "bg-purple-400",
  negative: "bg-amber-400",
  toxic: "bg-rose-600",
};

export interface CoreMobileWorkspaceProps {
  activeUser: { display_name?: string; login?: string; username?: string; profile_image_url?: string } | null;
  activeAuthLoading: boolean;
  activeLoginError: string | null;
  activeLoginInProgress: boolean;
  activeLogin: () => void;
  activeLogout: () => void;
  activeClearLoginError: () => void;
  onVisualCapture: () => void;
  onManualSnapshot: () => void;
  isVisualCapturing: boolean;
  visualCooldown: boolean;
  smartLevel: number;
  onCycleSmartLevel: () => void;
}

export function CoreMobileWorkspace(props: {
  activeUser: CoreMobileWorkspaceProps["activeUser"];
  activeAuthLoading: boolean;
  activeLoginError: string | null;
  activeLoginInProgress: boolean;
  activeLogin: () => void;
  activeLogout: () => void;
  activeClearLoginError: () => void;
  onVisualCapture: () => void;
  onManualSnapshot: () => void;
  isVisualCapturing: boolean;
  visualCooldown: boolean;
  smartLevel: number;
  onCycleSmartLevel: () => void;
}) {
  const [mobileTab, setMobileTab] = useState<"context" | "forge" | "tuning">("forge");
  const [chatDraft, setChatDraft] = useState("");
  const [telemetryExpanded, setTelemetryExpanded] = useState(false);

  // ─── Collapsible telemetry strip ───────────────────────────────────────────
  // The strip sits directly above the tab bar, so its height is the most
  // expensive real estate on a phone. It is now a utility strip with a grip on
  // the left: drag up / short = collapse, drag down = restore. Collapsed keeps a
  // discoverable handle + live status dot instead of the full 32px row.
  //
  // Performance: dragging writes to a ref and a single inline height on the
  // strip element — no per-frame React state, so CORE does not re-render while
  // the user drags. The collapsed/expanded choice is session-scoped
  // (sessionStorage) so it survives navigation but is not a permanent setting.
  const TELEMETRY_EXPANDED_H = 32;
  const TELEMETRY_COLLAPSED_H = 20;
  const telemetryStripRef = useRef<HTMLDivElement | null>(null);
  const telemetryDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const telemetryDragHeightRef = useRef<number | null>(null);
  const telemetryDragMovedRef = useRef(false);
  const [telemetryCollapsed, setTelemetryCollapsed] = useState(() => {
    try { return sessionStorage.getItem("core-telemetry-collapsed") === "1"; } catch { return false; }
  });
  const [telemetryDragging, setTelemetryDragging] = useState(false);

  useEffect(() => {
    try { sessionStorage.setItem("core-telemetry-collapsed", telemetryCollapsed ? "1" : "0"); } catch { /* private mode */ }
  }, [telemetryCollapsed]);

  // The three handlers below deliberately never set state during the move:
  // the live height is written straight to the strip element, so a drag cannot
  // trigger a single React render (the requirement is "drag gestures must not
  // constantly update state"). Only the gesture start and the committed
  // collapsed/expanded choice are React state.
  const applyStripHeight = (h: number) => {
    const el = telemetryStripRef.current;
    if (el) el.style.height = `${h}px`;
    telemetryDragHeightRef.current = h;
  };
  const onGripPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const startH = telemetryCollapsed ? TELEMETRY_COLLAPSED_H : TELEMETRY_EXPANDED_H;
    telemetryDragRef.current = { startY: e.clientY, startH };
    telemetryDragMovedRef.current = false;
    setTelemetryDragging(true); // reveals the full row so the drag reads as motion
    applyStripHeight(startH);
  };
  const onGripPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = telemetryDragRef.current;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dy) > 4) telemetryDragMovedRef.current = true;
    // Vertical-only, bounded to the two heights that exist in this layout —
    // no freeform placement, no horizontal overflow.
    applyStripHeight(Math.max(TELEMETRY_COLLAPSED_H, Math.min(TELEMETRY_EXPANDED_H, drag.startH + dy)));
  };
  const onGripPointerUp = () => {
    const drag = telemetryDragRef.current;
    telemetryDragRef.current = null;
    if (drag) {
      // Commit on release: nearer the collapsed height than expanded → collapse.
      const finalH = telemetryDragHeightRef.current ?? drag.startH;
      setTelemetryCollapsed(finalH < (TELEMETRY_COLLAPSED_H + TELEMETRY_EXPANDED_H) / 2);
    }
    telemetryDragHeightRef.current = null;
    if (telemetryStripRef.current) telemetryStripRef.current.style.height = "";
    setTelemetryDragging(false);
  };

  // Store state
  // effectiveMode: what actually renders (always "core" here — this component
  // only mounts below the STUDIO width threshold). Studio taps are gated by
  // setInterfaceMode → the "larger screen" interstitial.
  const interfaceMode = useEffectiveMode();
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const studioAvailable = useStudioAvailable();
  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const updateStreamMetadata = useAppStore((s) => s.updateStreamMetadata);
  const isForging = useAppStore((s) => s.isForging);
  const variants = useAppStore((s) => s.variants);
  const setVariants = useAppStore((s) => s.setVariants);
  const updateVariant = useAppStore((s) => s.updateVariant);
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const setAutoForgeEnabled = useAppStore((s) => s.setAutoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const setAutoForgeDryRun = useAppStore((s) => s.setAutoForgeDryRun);
  const autoForgeAutoCheckEnabled = useAppStore((s) => s.autoForgeAutoCheckEnabled);
  const setAutoForgeAutoCheckEnabled = useAppStore((s) => s.setAutoForgeAutoCheckEnabled);
  const autoForgeConfidenceThreshold = useAppStore((s) => s.autoForgeConfidenceThreshold);
  const setAutoForgeConfidenceThreshold = useAppStore((s) => s.setAutoForgeConfidenceThreshold);
  const isAutoForgeThinking = useAppStore((s) => s.isAutoForgeThinking);
  const lastAutoForgeDecision = useAppStore((s) => s.lastAutoForgeDecision);
  const autoForgeNextActionMs = useAppStore((s) => s.autoForgeNextActionMs);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // On mobile devices, local Ollama is not usable (runs only on desktop localhost).
  // If activeProvider is set to Ollama, switch to a configured cloud provider if available.
  useEffect(() => {
    if (getActiveProvider() === "ollama") {
      const fallback = getProviderWithKey();
      if (fallback) {
        setActiveProvider(fallback);
      }
    }
  }, []);
  const autoForgeCountdown = autoForgeNextActionMs
    ? Math.max(0, Math.floor((autoForgeNextActionMs - now) / 1000))
    : 0;
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const lastTokenUsage = useAppStore((s) => s.lastTokenUsage);
  const setLastTokenUsage = useAppStore((s) => s.setLastTokenUsage);
  const multiBotActive = useAppStore(selectMultiBotActive);
  const bots = useAppStore((s) => s.bots);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const r34lEnabled = useAppStore((s) => s.r34lEnabled);
  const setR34lEnabled = useAppStore((s) => s.setR34lEnabled);
  const sfxEnabled = useAppStore((s) => s.sfxEnabled);
  const setSfxEnabled = useAppStore((s) => s.setSfxEnabled);
  const ttsEnabled = useAppStore((s) => s.ttsEnabled);
  const setTtsEnabled = useAppStore((s) => s.setTtsEnabled);

  const readiness = useCoreReadiness();
  const providerSummary = getCoreProviderSummary();

  const activeBots = useMemo(
    () => (multiBotEnabled ? bots.filter((b) => b.active && b.session) : []),
    [multiBotEnabled, bots]
  );

  return (
    <div className="flex flex-col h-dvh w-full bg-[#0b0b11] text-[#e0e0e6] overflow-hidden font-sans relative z-10 select-text">
      {/* ─── Hidden TheForge loop instance to handle forge-trigger and auto-send events ─── */}
      <div className="hidden" aria-hidden="true">
        <TheForge />
      </div>

      {/* ─── 1. Sticky Header ─── */}
      <header className="shrink-0 h-12 border-b border-white/5 bg-[#121217]/95 backdrop-blur-md px-3 flex items-center justify-between gap-2 z-40 safe-top">
        {/* Brand + Version */}
        <div className="flex items-center shrink-0 gap-1.5 min-w-0">
          <img
            src={logoUrl}
            alt="MADchatter"
            className="h-7 w-auto forge-logo-glow select-none"
            style={{ opacity: 0.85 }}
          />
          <VersionBadge />
        </div>

        {/* User / Login */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
          {props.activeUser ? (
            <div className="flex items-center h-8 rounded-lg overflow-hidden border bg-[#18181B] border-white/10 min-w-0 max-w-full">
              <div className="flex items-center gap-1.5 pl-1.5 pr-2.5 min-w-0">
                <UserAvatar user={props.activeUser} platform={platform} sizeClass="h-6 w-6" textClass="text-[11px]" />
                <span className="text-[11px] font-bold tracking-wide text-white truncate min-w-0">
                  @{userDisplayName(props.activeUser)}
                </span>
              </div>
              <button
                type="button"
                onClick={props.activeLogout}
                aria-label="Disconnect account"
                className="h-full px-2 text-gray-400 hover:text-red-400 hover:bg-red-500/20 transition-colors flex items-center justify-center shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={props.activeLogin}
              disabled={props.activeLoginInProgress}
              className={cn(
                "h-8 px-2.5 flex items-center gap-1.5 disabled:opacity-70 text-white text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors touch-target",
                platform === "kick"
                  ? "bg-[#53fc18] hover:bg-[#44d014] text-black"
                  : platform === "joystick"
                  ? "bg-[#FF6B35] hover:bg-[#e55a25]"
                  : "bg-[#9146FF] hover:bg-[#772ce8]"
              )}
            >
              {props.activeLoginInProgress ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <LogIn className="w-3.5 h-3.5" />
              )}
              <span>Login</span>
            </button>
          )}
        </div>
      </header>

      {/* ─── 2. Active CORE Workspaces (All 3 kept mounted; display toggled) ─── */}
      <main className="flex-1 min-h-0 relative overflow-hidden flex flex-col">
        {/* Context Workspace */}
        <div
          className={cn(
            "flex flex-col h-full w-full min-h-0",
            mobileTab !== "context" && "hidden"
          )}
          role="tabpanel"
          aria-label="Context workspace"
        >
          <MobileContextTab
            activeUser={props.activeUser}
            draft={chatDraft}
            setDraft={setChatDraft}
            onVisualCapture={props.onVisualCapture}
            onManualSnapshot={props.onManualSnapshot}
            isVisualCapturing={props.isVisualCapturing}
            visualCooldown={props.visualCooldown}
          />
        </div>

        {/* Forge Workspace */}
        <div
          className={cn(
            "flex flex-col h-full w-full min-h-0",
            mobileTab !== "forge" && "hidden"
          )}
          role="tabpanel"
          aria-label="Forge workspace"
        >
          <MobileForgeTab
            readiness={readiness}
            providerSummary={providerSummary}
            activeBots={activeBots}
            multiBotActive={multiBotActive}
            onSelectTuning={() => setMobileTab("tuning")}
          />
        </div>

        {/* Tuning Workspace */}
        <div
          className={cn(
            "flex flex-col h-full w-full min-h-0",
            mobileTab !== "tuning" && "hidden"
          )}
          role="tabpanel"
          aria-label="Tuning workspace"
        >
          <MobileTuningTab
            readiness={readiness}
            providerSummary={providerSummary}
            activeUser={props.activeUser}
            activeLogin={props.activeLogin}
            activeLogout={props.activeLogout}
          />
        </div>
      </main>

      {/* ─── 3. Persistent Status / Telemetry Strip (with Expandable Drawer) ─── */}
      {/* ─── 3. Persistent Status / Telemetry Strip (collapsible utility strip) ───
          Left-side grip is the drag affordance: drag up/short collapses, drag
          down restores. Collapsed keeps a discoverable handle + live status dot
          instead of the full row, and never covers the bottom navigation. */}
      <div
        ref={telemetryStripRef}
        className={cn(
          "shrink-0 bg-[#0d0d14] border-t border-white/5 relative z-30 core-telemetry-strip overflow-hidden",
          telemetryDragging && "core-telemetry-dragging"
        )}
      >
        {/* Collapsed: "mostly hidden" — handle + live status only (~20px) */}
        {telemetryCollapsed && !telemetryDragging && (
          <div className="flex items-center h-5 min-w-0">
            <span
              role="button"
              tabIndex={0}
              aria-label="Expand status strip"
              aria-expanded={false}
              onPointerDown={onGripPointerDown}
              onPointerMove={onGripPointerMove}
              onPointerUp={onGripPointerUp}
              onPointerCancel={onGripPointerUp}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTelemetryCollapsed(false); } }}
              className="core-telemetry-grip flex items-center px-1.5 text-gray-600 hover:text-gray-400 transition-colors shrink-0"
            >
              <GripHorizontal className="w-4 h-4" />
            </span>
            <span className="flex items-center gap-1.5 pr-2 min-w-0 text-[10px] font-mono text-gray-500">
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0",
                  readiness.platformReady
                    ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                    : "bg-amber-400"
                )}
              />
              <span className="truncate">
                {streamMetadata.channelName ? `@${streamMetadata.channelName}` : "No Channel"}
              </span>
              {autoForgeEnabled && (
                <span className="shrink-0 text-emerald-400/80">
                  · {isAutoForgeThinking ? "thinking…" : "AutoForge"}
                </span>
              )}
            </span>
          </div>
        )}

        <div className={cn("flex items-stretch h-8", telemetryCollapsed && !telemetryDragging && "hidden")}>
          <button
            type="button"
            aria-label="Collapse status strip"
            aria-expanded={true}
            title="Drag up to collapse, or press to collapse"
            onPointerDown={onGripPointerDown}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
            onClick={() => { if (!telemetryDragMovedRef.current) setTelemetryCollapsed(true); }}
            className="core-telemetry-grip flex items-center px-1.5 text-gray-600 hover:text-gray-400 transition-colors shrink-0"
          >
            <GripHorizontal className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setTelemetryExpanded((v) => !v)}
            className="flex-1 h-8 px-1.5 flex items-center justify-between text-[11px] hover:bg-white/[0.02] transition-colors min-w-0"
            aria-expanded={telemetryExpanded}
            aria-label="Toggle system telemetry"
          >
          {/* Platform / Channel */}
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={cn(
                "w-2 h-2 rounded-full shrink-0",
                readiness.platformReady
                  ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                  : "bg-amber-400"
              )}
            />
            <span className="text-gray-300 font-bold capitalize truncate max-w-[90px] sm:max-w-[140px]">
              {streamMetadata.channelName ? `@${streamMetadata.channelName}` : "No Channel"}
            </span>
          </div>

          {/* AI / AutoForge status */}
          <div className="flex items-center gap-2 text-gray-400">
            {isAutoForgeThinking ? (
              <span className="flex items-center gap-1 text-orange-400 font-bold animate-pulse text-[10px]">
                <Loader2 className="w-3 h-3 animate-spin" /> Thinking…
              </span>
            ) : autoForgeEnabled ? (
              <span className="flex items-center gap-1 text-emerald-400 text-[10px]">
                {autoForgeDryRun ? (
                  <span className="text-amber-400 font-bold flex items-center gap-1">
                    <FlaskConical className="w-3 h-3" /> Dry Run
                  </span>
                ) : (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <Zap className="w-3 h-3" /> AutoForge
                  </span>
                )}
                {autoForgeCountdown > 0 && autoForgeAutoCheckEnabled && (
                  <span className="text-gray-500 font-mono text-[9px]">({autoForgeCountdown}s)</span>
                )}
              </span>
            ) : (
              <span className="text-gray-500 text-[10px]">AutoForge Off</span>
            )}

            {/* Provider pill */}
            <span className="hidden sm:inline-block text-[10px] text-gray-500 font-mono">
              · {providerSummary.label}
            </span>
          </div>

          {/* Expand chevron */}
          <div className="flex items-center text-gray-500 gap-1 text-[10px]">
            <span className="hidden xs:inline">Details</span>
            {telemetryExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" />
            )}
          </div>
        </button>
        </div>

        {/* Expandable Telemetry Drawer */}
        <AnimatePresence>
          {telemetryExpanded && !telemetryCollapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden border-t border-white/5 bg-[#121218] px-3 py-2.5 text-xs font-mono space-y-2"
            >
              <div className="flex justify-between items-center text-gray-400">
                <span className="text-[10px] uppercase font-bold text-gray-500">System Telemetry</span>
                <span className="text-[10px] text-emerald-400">
                  {readiness.essentialReady ? "Operational" : "Activating"}
                </span>
              </div>

              {/* Last decision if available */}
              {lastAutoForgeDecision ? (
                <div className="bg-black/40 rounded-lg p-2 border border-white/5 space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-orange-400 font-bold uppercase">
                      Decision: {lastAutoForgeDecision.decision}
                    </span>
                    <span className="text-gray-400 font-mono">
                      {(lastAutoForgeDecision.confidence * 100).toFixed(0)}% conf
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-300 font-sans line-clamp-2">
                    {lastAutoForgeDecision.reason}
                  </div>
                  {lastAutoForgeDecision.action_payload && (
                    <div className="text-[10px] text-emerald-300 font-sans italic bg-emerald-500/10 p-1.5 rounded border border-emerald-500/20">
                      "{lastAutoForgeDecision.action_payload}"
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-gray-500 font-sans italic">
                  No AutoForge decisions recorded yet.
                </div>
              )}

              {/* Token Transaction Summary */}
              {lastTokenUsage && (
                <div className="flex items-center justify-between text-[10px] text-gray-400 pt-1 border-t border-white/5">
                  <span>Tokens: {lastTokenUsage.total_tokens}</span>
                  <span>Effort: {lastTokenUsage.effort_given}</span>
                  <span className="text-green-400">${((lastTokenUsage.prompt_tokens * 0.075 + lastTokenUsage.completion_tokens * 0.3) / 1000000).toFixed(5)}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ─── 4. Persistent Bottom Navigation ─── */}
      <nav
        className="shrink-0 h-14 bg-[#0d0d12]/95 backdrop-blur-lg border-t border-white/5 px-2 flex items-center justify-around z-40 safe-bottom"
        role="tablist"
        aria-label="Main Navigation"
      >
        <button
          role="tab"
          aria-selected={mobileTab === "context"}
          aria-label="Context workspace"
          onClick={() => {
            setMobileTab("context");
            playSfx("palette_select");
          }}
          className={cn(
            "flex-1 flex flex-col items-center justify-center gap-1 min-h-[48px] rounded-xl transition-all touch-target",
            mobileTab === "context"
              ? "text-orange-400 bg-orange-500/10 font-bold"
              : "text-gray-400 hover:text-gray-200"
          )}
        >
          <Brain className="w-5 h-5" />
          <span className="text-[11px]">Context</span>
        </button>

        <button
          role="tab"
          aria-selected={mobileTab === "forge"}
          aria-label="Forge workspace"
          onClick={() => {
            setMobileTab("forge");
            playSfx("palette_select");
          }}
          className={cn(
            "flex-1 flex flex-col items-center justify-center gap-1 min-h-[48px] rounded-xl transition-all relative touch-target",
            mobileTab === "forge"
              ? "text-orange-400 bg-orange-500/10 font-bold"
              : "text-gray-400 hover:text-gray-200"
          )}
        >
          <Zap className="w-5 h-5" />
          <span className="text-[11px]">Forge</span>
          {(variants.length > 0 || isAutoForgeThinking) && (
            <span className="absolute top-1.5 right-6 w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
          )}
        </button>

        <button
          role="tab"
          aria-selected={mobileTab === "tuning"}
          aria-label="Tuning workspace"
          onClick={() => {
            setMobileTab("tuning");
            playSfx("palette_select");
          }}
          className={cn(
            "flex-1 flex flex-col items-center justify-center gap-1 min-h-[48px] rounded-xl transition-all touch-target",
            mobileTab === "tuning"
              ? "text-orange-400 bg-orange-500/10 font-bold"
              : "text-gray-400 hover:text-gray-200"
          )}
        >
          <Sparkles className="w-5 h-5" />
          <span className="text-[11px]">Tuning</span>
        </button>
      </nav>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTEXT TAB (Stream → Chat Pulse → Composer → Supporting Accordions)
// ══════════════════════════════════════════════════════════════════════════════

function MobileContextTab(props: {
  activeUser: CoreMobileWorkspaceProps["activeUser"];
  draft: string;
  setDraft: (s: string) => void;
  onVisualCapture: () => void;
  onManualSnapshot: () => void;
  isVisualCapturing: boolean;
  visualCooldown: boolean;
}) {
  const [streamMinimized, setStreamMinimized] = useState(false);
  const [streamMuted, setStreamMuted] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [autoScrollLocked, setAutoScrollLocked] = useState(true);
  const [newMessagesWhileScrolled, setNewMessagesWhileScrolled] = useState(0);

  // Thumbnail Snap — fetches the platform's live preview thumbnail (Twitch
  // CDN / Kick API) and feeds it through the same vision pipeline as desktop
  // canvas capture. Works on mobile where getDisplayMedia is unavailable.
  const [thumbSnapLoading, setThumbSnapLoading] = useState(false);
  const [thumbSnapCooldown, setThumbSnapCooldown] = useState(false);

  // Visual capture capability. getDisplayMedia() (screen/window capture) is not
  // supported on mobile browsers — iOS Safari lacks it entirely and Android
  // Chrome's support is effectively unusable. The stream is also a cross-origin
  // iframe, so it can't be screenshot via canvas either. Without this check the
  // Capture button throws "Failed to start capture" on every tap, and Snap
  // (gated behind Capture being active) is dead too.
  const visualCaptureSupported = !!(navigator.mediaDevices && typeof (navigator.mediaDevices as any).getDisplayMedia === 'function');

  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const platform = useAppStore((s) => s.platform);
  const chatLog = useAppStore((s) => s.chatLog);
  const sentimentHistory = useAppStore((s) => s.sentimentHistory);
  const smartReplies = useAppStore((s) => s.smartReplies);
  const smartRepliesLoading = useAppStore((s) => s.smartRepliesLoading);
  const isAutoForgeThinking = useAppStore((s) => s.isAutoForgeThinking);
  const pinnedMemories = useAppStore((s) => s.pinnedMemories);
  const addPinnedMemory = useAppStore((s) => s.addPinnedMemory);
  const removePinnedMemory = useAppStore((s) => s.removePinnedMemory);
  // Canonical Visual data (same store/source as STUDIO and desktop CORE) —
  // the mobile history sheet is a view over this, never a second store.
  const visualSnapshotHistory = useAppStore((s) => s.visualSnapshotHistory);
  const visualContextTags = useAppStore((s) => s.visualContextTags);
  const setVisualHistoryOpen = useAppStore((s) => s.setVisualHistoryOpen);
  const setVisualSnapshot = useAppStore((s) => s.setVisualSnapshot);
  const recordTokenUsage = useAppStore((s) => s.recordTokenUsage);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastChatLenRef = useRef(chatLog.length);

  const channel = streamMetadata.channelName || "";
  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";

  // Whether the embedded video is on screen. Drives the header/controls
  // overlay treatment so the chrome doesn't eat vertical space the chat needs.
  const videoVisible = !streamMinimized && !!channel;

  // Twitch Player SDK — the embed script (player.twitch.tv/js/embed/v1.js)
  // is loaded by StreamOverlay on desktop STUDIO, but that component never
  // mounts in mobile CORE. Without loading it here, window.Twitch is always
  // undefined and the player div stays empty (no stream video on mobile).
  const twitchPlayerRef = useRef<any>(null);
  const twitchPlayerId = useMemo(() => `mobile-twitch-player-${Math.random().toString(36).slice(2, 8)}`, []);
  const [twitchScriptLoaded, setTwitchScriptLoaded] = useState(() => !!window.Twitch);

  useEffect(() => {
    if (platform === "kick" || platform === "joystick" || twitchScriptLoaded) return;
    const existing = document.querySelector('script[src*="player.twitch.tv/js/embed/v1.js"]');
    if (existing && window.Twitch) { setTwitchScriptLoaded(true); return; }
    if (existing) { existing.addEventListener("load", () => setTwitchScriptLoaded(true)); return; }
    const script = document.createElement("script");
    script.src = "https://player.twitch.tv/js/embed/v1.js";
    script.onload = () => setTwitchScriptLoaded(true);
    document.head.appendChild(script);
  }, [platform, twitchScriptLoaded]);

  useEffect(() => {
    if (platform === "kick" || platform === "joystick" || !channel || !twitchScriptLoaded || !window.Twitch) return;
    const el = document.getElementById(twitchPlayerId);
    if (!el) return;
    if (twitchPlayerRef.current) {
      try { twitchPlayerRef.current.destroy(); } catch {}
    }
    el.innerHTML = "";
    twitchPlayerRef.current = new window.Twitch.Player(twitchPlayerId, {
      channel,
      parent,
      muted: streamMuted,
      autoplay: true,
      width: "100%",
      height: "100%",
    });
  }, [channel, platform, parent, twitchPlayerId, twitchScriptLoaded]);

  // Cleanup the Twitch player on unmount so the iframe doesn't leak.
  useEffect(() => {
    return () => {
      if (twitchPlayerRef.current) { try { twitchPlayerRef.current.destroy(); } catch {} }
      twitchPlayerRef.current = null;
    };
  }, []);

  // Handle scroll events in chat container
  const handleChatScroll = () => {
    const el = chatContainerRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom <= 40) {
      setAutoScrollLocked(true);
      setNewMessagesWhileScrolled(0);
    } else {
      setAutoScrollLocked(false);
    }
  };

  // Auto-scroll on new chat messages
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const newItems = chatLog.length - lastChatLenRef.current;
    lastChatLenRef.current = chatLog.length;

    if (autoScrollLocked) {
      el.scrollTop = el.scrollHeight;
    } else if (newItems > 0) {
      setNewMessagesWhileScrolled((prev) => prev + newItems);
    }
  }, [chatLog, autoScrollLocked]);

  const scrollToBottom = () => {
    const el = chatContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAutoScrollLocked(true);
    setNewMessagesWhileScrolled(0);
  };

  // Thumbnail Snap — fetch the platform's live preview thumbnail and run it
  // through the vision pipeline. This is the mobile-friendly alternative to
  // getDisplayMedia: no screen capture needed, just a public CDN/API image.
  const handleThumbnailSnap = async () => {
    if (thumbSnapLoading || thumbSnapCooldown) return;
    if (!channel) {
      toast.error("No channel set — add a channel first.");
      return;
    }
    if (platform === "joystick") {
      toast.error("Joystick doesn't expose a public thumbnail. Use desktop capture instead.");
      return;
    }
    setThumbSnapLoading(true);
    playSfx("forge_start");
    const toastId = toast.loading("Fetching stream preview…");
    try {
      const dataUrl = await fetchStreamThumbnailDataUrl(platform, channel, 1280, 720);
      if (!dataUrl) {
        toast.error("Couldn't fetch the stream preview. The stream may be offline.", { id: toastId });
        return;
      }
      // Store the raw snapshot immediately so the history sheet shows it.
      setVisualSnapshot(dataUrl, ["Captured"], "manual");
      toast.loading("Analyzing stream frame…", { id: toastId });
      const provider = getActiveProvider();
      const data = await visionRequest(dataUrl, provider, null);
      if (data.tokenUsage) {
        recordTokenUsage("vision", data.tokenUsage);
      }
      if (data.visualContext) {
        setVisualSnapshot(dataUrl, [data.visualContext], "manual");
        toast.success("Stream frame analyzed!", { id: toastId });
        playSfx("send_message");
      } else {
        setVisualSnapshot(dataUrl, ["Captured — no analysis"], "manual");
        toast.success("Snapshot saved (no analysis).", { id: toastId });
      }
      // 5s cooldown — matches the desktop manual capture cooldown.
      setThumbSnapCooldown(true);
      setTimeout(() => setThumbSnapCooldown(false), 5000);
    } catch (e: any) {
      toast.error(e.message || "Failed to analyze stream frame", { id: toastId });
      playSfx("error");
    } finally {
      setThumbSnapLoading(false);
    }
  };

  // Filtered chat messages
  const filteredChat = useMemo(() => {
    if (!chatSearchQuery.trim()) return chatLog;
    const q = chatSearchQuery.toLowerCase();
    return chatLog.filter(
      (m) => !m.marker && (m.user.toLowerCase().includes(q) || m.text.toLowerCase().includes(q))
    );
  }, [chatLog, chatSearchQuery]);

  return (
    <div className="flex flex-col h-full w-full min-h-0 bg-[#0B0B10]">
      {/* ─── Stream Video Area ─── */}
      <div className="shrink-0 border-b border-white/5 bg-black relative">
        {/* Stream Header Bar — overlays the top of the video behind a
            translucent scrim while the video is showing (reclaims its vertical
            space for the chat); falls back to a normal bar when the video is
            hidden or no channel is set. */}
        <div
          className={cn(
            "flex items-center justify-between px-3 py-1.5",
            videoVisible
              ? "absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 via-black/40 to-transparent"
              : "bg-[#121218] border-b border-white/5",
          )}
        >
          <div className="flex items-center gap-2 text-xs font-bold text-gray-300">
            <Tv className="w-3.5 h-3.5 text-purple-400" />
            <span>{channel ? `@${channel}` : "No stream selected"}</span>
            {channel && (
              <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 font-mono">
                {platform}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setStreamMinimized((v) => !v)}
            className="text-[10px] font-bold text-gray-400 hover:text-white px-2 py-1 rounded bg-white/10 transition-colors touch-action-manipulation"
          >
            {streamMinimized ? "Show Video" : "Hide Video"}
          </button>
        </div>

        {/* Video Player */}
        {!streamMinimized && channel && (
          <div className="w-full relative bg-black flex items-center justify-center overflow-hidden">
            <div className="w-full relative aspect-video max-h-[220px]">
              {platform === "kick" ? (
                <iframe
                  src={`https://player.kick.com/${channel}?autoplay=true&muted=true&parent=${parent}`}
                  title="Kick Stream"
                  className="w-full h-full border-0"
                  allow="autoplay; fullscreen"
                />
              ) : platform === "joystick" ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-4 text-center">
                  <span className="text-xs text-orange-400 font-bold">Joystick stream active</span>
                  {visualCaptureSupported && (
                    <button
                      type="button"
                      onClick={props.onVisualCapture}
                      className="px-3 py-1.5 rounded-lg bg-orange-500/20 border border-orange-500/40 text-orange-300 text-xs font-bold"
                    >
                      {props.isVisualCapturing ? "Stop Window Capture" : "Capture Window"}
                    </button>
                  )}
                </div>
              ) : (
                <div id={twitchPlayerId} className="w-full h-full" />
              )}
            </div>
          </div>
        )}

        {/* Stream Controls Bar — overlays the bottom of the video behind a
            translucent scrim so the row doesn't consume vertical space the
            chat could use. */}
        {videoVisible && (
          <div className="absolute inset-x-0 bottom-0 z-20 flex items-center flex-nowrap gap-1 px-2 py-1.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
            {/* Mute — icon-only (label is conveyed via aria-label + icon state) */}
            {platform !== "kick" && platform !== "joystick" && (
              <button
                type="button"
                onClick={() => {
                  const nm = !streamMuted;
                  setStreamMuted(nm);
                  twitchPlayerRef.current?.setMuted(nm);
                }}
                className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center bg-white/5 text-gray-300 hover:text-white transition-colors"
                aria-label={streamMuted ? "Unmute stream" : "Mute stream"}
                title={streamMuted ? "Unmute" : "Mute"}
              >
                {streamMuted ? <VolumeX className="w-3.5 h-3.5 text-orange-400" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
            )}

            {/* Screen Capture + Snap — only when getDisplayMedia is supported.
                On mobile browsers these are dead (getDisplayMedia is undefined),
                so we hide them and show a notice instead of broken buttons. */}
            {visualCaptureSupported && (
              <>
                <button
                  type="button"
                  onClick={props.onVisualCapture}
                  className={cn(
                    "h-8 flex-1 min-w-0 px-1 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1 transition-colors",
                    props.isVisualCapturing
                      ? "bg-red-500/20 text-red-400 border border-red-500/30"
                      : "bg-orange-500/15 text-orange-400 border border-orange-500/25"
                  )}
                >
                  {props.isVisualCapturing ? <StopCircle className="w-3 h-3 shrink-0" /> : <MonitorUp className="w-3 h-3 shrink-0" />}
                  <span>{props.isVisualCapturing ? "Stop" : "Capture"}</span>
                </button>

                {/* SNAP — MANUAL ONLY on mobile. No capture timer runs on a phone
                    (battery, bandwidth, browser limits), so every snapshot is an
                    explicit user action: tap once to arm capture, tap SNAP to
                    analyze the current frame through the normal visual pipeline. */}
                <button
                  type="button"
                  onClick={props.isVisualCapturing ? props.onManualSnapshot : props.onVisualCapture}
                  disabled={props.isVisualCapturing && props.visualCooldown}
                  title={props.isVisualCapturing
                    ? "Analyze the current stream frame"
                    : "Start capture, then tap SNAP again"}
                  aria-label="Capture a stream snapshot (manual)"
                  className={cn(
                    "h-8 flex-1 min-w-0 px-1 rounded-lg text-[10px] font-bold uppercase border flex items-center justify-center gap-1 transition-colors disabled:opacity-50 touch-target",
                    props.isVisualCapturing
                      ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-gray-200"
                  )}
                >
                  <Camera className="w-3 h-3 shrink-0" />
                  <span>Snap</span>
                  {props.isVisualCapturing && !props.visualCooldown && (
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
                  )}
                </button>
              </>
            )}

            {/* Thumbnail Snap — the mobile alternative to getDisplayMedia.
                Fetches the platform's live preview thumbnail (Twitch CDN /
                Kick API) and runs it through the same vision pipeline. Works
                on phones where screen capture is unavailable. Twitch + Kick
                only (Joystick has no public thumbnail). */}
            {!visualCaptureSupported && platform !== "joystick" && channel && (
              <button
                type="button"
                onClick={handleThumbnailSnap}
                disabled={thumbSnapLoading || thumbSnapCooldown}
                title="Analyze the current stream frame from the live preview thumbnail"
                aria-label="Snap stream frame from thumbnail"
                className={cn(
                  "h-8 flex-1 min-w-0 px-1 rounded-lg text-[10px] font-bold uppercase border flex items-center justify-center gap-1 transition-colors disabled:opacity-50 touch-target",
                  thumbSnapLoading
                    ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
                    : thumbSnapCooldown
                    ? "bg-white/5 text-gray-500 border-white/10"
                    : "bg-blue-500/15 text-blue-400 border-blue-500/25"
                )}
              >
                {thumbSnapLoading ? (
                  <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                ) : (
                  <Camera className="w-3 h-3 shrink-0" />
                )}
                <span>{thumbSnapLoading ? "Analyzing…" : thumbSnapCooldown ? "Cooldown" : "Snap"}</span>
                {!thumbSnapLoading && !thumbSnapCooldown && (
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
                )}
              </button>
            )}

            {/* Visual history — opens the canonical snapshot history (pinned /
                delete / inspect) as a compact sheet on phones. Always available
                as a view over previously-captured frames (e.g. from desktop). */}
            <button
              type="button"
              onClick={() => { setVisualHistoryOpen(true); playSfx("hud_open"); }}
              aria-label="Open visual snapshot history"
              className={cn(
                "h-8 px-1 rounded-lg text-[10px] font-bold uppercase bg-teal-500/15 text-teal-300 border border-teal-500/25 flex items-center justify-center gap-1 touch-target",
                visualCaptureSupported ? "flex-1 min-w-0" : "w-auto shrink-0",
              )}
            >
              <Clock className="w-3 h-3 shrink-0" />
              <span>Visual</span>
              {visualSnapshotHistory.length > 0 && (
                <span className="font-mono text-[9px] opacity-80 shrink-0">{visualSnapshotHistory.length}</span>
              )}
            </button>

            {/* External channel link — icon-only on mobile (the platform label is
                redundant; opens the channel in the platform's own app/site). */}
            <button
              type="button"
              onClick={() => {
                const url =
                  platform === "kick"
                    ? `https://kick.com/${channel}`
                    : platform === "joystick"
                    ? `https://joystick.tv/u/${channel}`
                    : `https://twitch.tv/${channel}`;
                window.open(url, "_blank");
              }}
              aria-label={`Open ${channel} on ${platform}`}
              title={`Open @${channel} on ${platform}`}
              className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center bg-[#9146FF]/15 text-[#9146FF] border border-[#9146FF]/30"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* ─── Chat Pulse Header, Sentiment Bar & Search ─── */}
      <div className="shrink-0 border-b border-white/5 bg-[#121217] px-3 py-1.5 flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs font-bold uppercase tracking-wider text-teal-400 flex items-center gap-1.5">
            Chat Pulse
          </span>
          <span className="text-[10px] text-gray-500 font-mono">
            ({filteredChat.length})
          </span>
        </div>

        {/* Sentiment Heatmap — expands across the middle so the entire row is filled */}
        <div className="flex-1 min-w-0 flex items-center justify-center">
          {sentimentHistory.length > 0 ? (
            <div
              className="w-full flex items-center gap-0.5 h-2 rounded overflow-hidden bg-black/40 border border-white/5 px-0.5"
              title="Recent chat sentiment heatmap"
            >
              {sentimentHistory.slice(-35).map((r, i) => (
                <div
                  key={i}
                  className={cn("flex-1 h-full rounded-[0.5px] transition-colors", SENTIMENT_DOT_COLORS[r.label] || "bg-blue-400")}
                  style={{ opacity: 0.4 + (r.score * 0.6) }}
                />
              ))}
            </div>
          ) : (
            <div className="w-full h-1 rounded-full bg-white/[0.04]" />
          )}
        </div>

        {/* Search button indicator square — compact and cleanly aligned */}
        <button
          type="button"
          onClick={() => setChatSearchOpen((v) => !v)}
          className={cn(
            "w-6 h-6 shrink-0 rounded-md flex items-center justify-center transition-all",
            chatSearchOpen
              ? "text-teal-300 bg-teal-500/20 border border-teal-500/30 shadow-[0_0_8px_rgba(20,184,166,0.25)]"
              : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
          )}
          aria-label="Toggle chat search"
          title={chatSearchOpen ? "Close search" : "Search chat"}
        >
          <Search className="w-3 h-3" />
        </button>
      </div>

      {/* Search Input Bar (revealed on demand) */}
      {chatSearchOpen && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-black/40 border-b border-white/5">
          <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <input
            type="text"
            value={chatSearchQuery}
            onChange={(e) => setChatSearchQuery(e.target.value)}
            placeholder="Search chat messages or users…"
            className="flex-1 bg-transparent text-xs text-gray-200 placeholder:text-gray-600 outline-none font-sans"
          />
          {chatSearchQuery && (
            <button
              type="button"
              onClick={() => setChatSearchQuery("")}
              className="text-gray-500 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Smart Replies Chips */}
      {(smartReplies.length > 0 || smartRepliesLoading) && (
        <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-white/5 bg-cyan-500/5 overflow-x-auto">
          {smartRepliesLoading ? (
            <span className="text-[10px] text-cyan-400 animate-pulse">Generating replies…</span>
          ) : (
            smartReplies.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={async () => {
                  try {
                    await sendManualMessage({ message: r.text, channel, source: "manual" });
                    toast.success("Reply sent!");
                  } catch (e: any) {
                    toast.error(e.message || "Failed to send");
                  }
                }}
                className="shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/25 transition-all truncate max-w-[200px]"
              >
                {r.text}
              </button>
            ))
          )}
        </div>
      )}

      {/* ─── Chat Messages Scroll Area ─── */}
      <div
        ref={chatContainerRef}
        onScroll={handleChatScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2.5 space-y-1.5 font-sans relative"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {filteredChat.length > 0 ? (
          filteredChat.map((msg, i) => {
            if (msg.marker) {
              return (
                <div key={msg.id || i} className="flex items-center gap-2 py-1 text-center">
                  <div className="flex-1 h-px bg-orange-500/30" />
                  <span className="text-[9px] font-bold uppercase tracking-wider text-orange-400">
                    AutoForge Sent
                  </span>
                  <div className="flex-1 h-px bg-orange-500/30" />
                </div>
              );
            }

            const badges = msg.badges || [];
            const isSelf = msg.selfSent;
            const isDry = msg.dryRun;

            return (
              <div
                key={msg.id || i}
                className={cn(
                  "p-1.5 rounded-lg border flex items-start gap-1.5 text-xs transition-colors",
                  isSelf
                    ? "bg-yellow-500/[0.04] border-yellow-500/20"
                    : isDry
                    ? "bg-amber-500/[0.04] border-amber-500/20"
                    : "bg-white/[0.015] border-white/[0.03]"
                )}
              >
                {/* Badges */}
                <div className="flex items-center gap-1 shrink-0 mt-0.5">
                  {badges.includes("broadcaster") && <span className="text-[10px]" title="Broadcaster">📹</span>}
                  {badges.includes("moderator") && <span className="text-[10px]" title="Moderator">🛡️</span>}
                  {badges.includes("vip") && <span className="text-[10px]" title="VIP">💎</span>}
                  {badges.includes("subscriber") && <span className="text-[10px]" title="Subscriber">⭐</span>}
                </div>

                {/* Username */}
                <span
                  className={cn(
                    "font-bold shrink-0 truncate max-w-[110px]",
                    isSelf
                      ? "text-yellow-400"
                      : isDry
                      ? "text-amber-400"
                      : "text-teal-400"
                  )}
                >
                  @{msg.user}:
                </span>

                {/* Text */}
                <div className="flex-1 min-w-0 break-words leading-relaxed text-gray-200">
                  <EmoteText text={msg.text} channel={channel} twitchEmotes={msg.twitchEmotes} />
                </div>

                {/* Indicators & Pin */}
                <div className="flex items-center gap-1 shrink-0 self-start">
                  {isDry && (
                    <span className="text-[8px] font-bold uppercase px-1 rounded bg-amber-500/20 text-amber-300">
                      preview
                    </span>
                  )}
                  {isSelf && msg.selfSentSource === "autoforge" && (
                    <span className="text-[8px] font-bold uppercase px-1 rounded bg-orange-500/20 text-orange-300">
                      auto
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      addPinnedMemory({
                        type: "chat",
                        content: `${msg.user}: ${msg.text}`,
                        label: `@${msg.user}: ${msg.text}`,
                        timestamp: Date.now(),
                      });
                      toast.success("Pinned to memory");
                      playSfx("memory_add");
                    }}
                    className="p-1 text-gray-500 hover:text-blue-400 transition-colors"
                    aria-label="Pin to memory"
                  >
                    <Pin className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-gray-500">
            <span className="text-xs font-bold text-gray-400 mb-1">
              {chatSearchQuery ? "No matching messages" : "Chat Pulse is waiting for messages"}
            </span>
            <span className="text-[11px] text-gray-600">
              {channel ? `Listening to @${channel} chat…` : "Connect a channel in Tuning to start."}
            </span>
          </div>
        )}

        {/* AutoForge Thinking Indicator */}
        {isAutoForgeThinking && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs">
            <Bot className="w-3.5 h-3.5 animate-bounce" />
            <span className="font-bold">AutoForge is formulating a response…</span>
          </div>
        )}
      </div>

      {/* Floating "Scroll to Bottom" Pill when user scrolled up */}
      {!autoScrollLocked && newMessagesWhileScrolled > 0 && (
        <div className="shrink-0 flex justify-center py-1 bg-transparent relative z-20">
          <button
            type="button"
            onClick={scrollToBottom}
            className="px-3 py-1 rounded-full bg-orange-500 text-black font-bold text-xs shadow-lg flex items-center gap-1.5 animate-bounce"
          >
            <span>↓ {newMessagesWhileScrolled} new messages</span>
          </button>
        </div>
      )}

      {/* ─── Live Chat Composer ─── */}
      <MobileChatComposer channel={channel} draft={props.draft} setDraft={props.setDraft} />
      {/* ─── Secondary Context (Audio Transcript notice & Pinned Memory) ─── */}
      <div className="shrink-0 border-t border-white/5 bg-[#0D0D14] px-3 py-1.5">
        <details className="group">
          <summary className="text-[11px] font-bold text-gray-500 hover:text-gray-300 cursor-pointer flex items-center justify-between list-none">
            <span>Supporting Context (Audio & Memory)</span>
            <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pt-2 pb-1 space-y-2 text-xs">
            {/* Audio Transcript status */}
            <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[11px]">
              <span className="font-bold block mb-0.5">Audio Transcription</span>
              System audio capture requires a desktop Chromium browser (Chrome/Edge) with WebGPU. Not available on mobile browsers.
            </div>

            {/* Pinned memory items */}
            {pinnedMemories.length > 0 ? (
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-gray-400 uppercase">
                  Pinned Moments ({pinnedMemories.length})
                </span>
                {pinnedMemories.slice(-3).map((mem) => (
                  <div key={mem.id} className="flex items-center justify-between p-1.5 rounded bg-black/40 border border-white/5 text-[11px]">
                    <span className="truncate text-gray-300 mr-2">{mem.label}</span>
                    <button
                      type="button"
                      onClick={() => removePinnedMemory(mem.id)}
                      className="text-gray-500 hover:text-red-400"
                      aria-label="Remove memory"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-[10px] text-gray-600 italic block">
                No memories pinned yet. Tap the pin icon on chat messages to remember key moments.
              </span>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

// ─── Mobile Chat Composer ──────────────────────────────────────────────────

function MobileChatComposer(props: {
  channel: string;
  draft: string;
  setDraft: (s: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tmiReadState = useAppStore((s) => s.tmiReadState);
  const isConnected = tmiReadState === "connected" && !!props.channel.trim();

  const handleSend = async () => {
    const text = props.draft.trim();
    if (!text || sending || !props.channel.trim()) return;
    setSending(true);
    try {
      await sendManualMessage({ message: text, channel: props.channel, source: "manual" });
      props.setDraft("");
      playSfx("send_message");
      toast.success("Sent to chat!");
    } catch (e: any) {
      toast.error(e.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="shrink-0 border-t border-white/5 bg-[#121217] px-3 py-2 flex items-end gap-2">
      <textarea
        ref={inputRef}
        rows={1}
        value={props.draft}
        onChange={(e) => props.setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isConnected ? "Send to stream chat…" : "Connect channel to chat…"}
        disabled={!isConnected || sending}
        className="flex-1 min-h-[38px] max-h-[84px] bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-orange-500/50 resize-none font-sans"
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={!isConnected || sending || !props.draft.trim()}
        className={cn(
          "h-10 w-10 shrink-0 rounded-xl flex items-center justify-center font-bold text-white transition-all touch-target",
          isConnected && props.draft.trim() && !sending
            ? "bg-orange-500 hover:bg-orange-400 text-black shadow-lg"
            : "bg-white/5 text-gray-600 cursor-not-allowed"
        )}
        aria-label="Send message"
      >
        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// FORGE TAB (Unified Fast Action Workspace)
// ══════════════════════════════════════════════════════════════════════════════

function MobileForgeTab(props: {
  readiness: ReturnType<typeof useCoreReadiness>;
  providerSummary: ReturnType<typeof getCoreProviderSummary>;
  activeBots: any[];
  multiBotActive: boolean;
  onSelectTuning?: () => void;
}) {
  // Store state
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const variants = useAppStore((s) => s.variants);
  const setVariants = useAppStore((s) => s.setVariants);
  const updateVariant = useAppStore((s) => s.updateVariant);
  const isForging = useAppStore((s) => s.isForging);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const setAutoForgeEnabled = useAppStore((s) => s.setAutoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const lastTokenUsage = useAppStore((s) => s.lastTokenUsage);
  const setLastTokenUsage = useAppStore((s) => s.setLastTokenUsage);

  // Hold-to-Clear state (1.25s)
  const HOLD_DURATION_MS = 1250;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdRafRef = useRef<number>(0);
  const [holdProgress, setHoldProgress] = useState(0);

  const startHold = () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current);
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / HOLD_DURATION_MS);
      setHoldProgress(progress);
      if (progress < 1) {
        holdRafRef.current = requestAnimationFrame(tick);
      }
    };
    holdRafRef.current = requestAnimationFrame(tick);
    holdTimerRef.current = setTimeout(() => {
      setVariants([]);
      setHoldProgress(0);
      holdTimerRef.current = null;
      playSfx("clear_context");
      toast.success("All variants cleared.");
    }, HOLD_DURATION_MS);
  };

  const cancelHold = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current);
    setHoldProgress(0);
  };

  const holdColor = useMemo(() => {
    const p = holdProgress;
    if (p < 0.5) return "#ef4444";
    return "#f97316";
  }, [holdProgress]);

  // Primary Forge action with optional variant count (1, 2, smart/undefined, 3, 4)
  const handleForge = (count?: number) => {
    if (isForging) return;
    playSfx("forge_start");
    window.dispatchEvent(new CustomEvent("forge-trigger", { detail: { count } }));
  };

  // Send message
  const handleSend = async (message: string, botId?: string) => {
    const toastId = toast.loading("Sending to stream chat…");
    try {
      await sendManualMessage({
        message,
        channel: streamMetadata.channelName,
        botId,
        source: "manual",
      });
      if (useAppStore.getState().messageSoundEnabled) playMessageSound();
      speakMessage(message);
      toast.success("Sent to chat!", { id: toastId });
      playSfx("send_message");
    } catch (e: any) {
      toast.error(e.message || "Failed to send message", { id: toastId });
      playSfx("error");
    }
  };

  // Refine suggestion
  const handleRefine = async (id: number, type: string, customInstruction?: string) => {
    const variant = variants.find((v) => v.variant_id === id);
    if (!variant) return;
    const toastId = toast.loading(`Refining variant #${id}…`);
    try {
      const provider = getActiveProvider();
      const data = await refineSuggestion({
        suggestion: variant,
        refinementType: type,
        customInstruction,
        streamMetadata,
        activeProvider: provider,
      });
      if (data.tokenUsage) {
        setLastTokenUsage({
          prompt_tokens: data.tokenUsage.prompt_tokens,
          completion_tokens: data.tokenUsage.completion_tokens,
          total_tokens: data.tokenUsage.total_tokens,
          effort_given: config?.effortLevel === "smart" ? "smart" : config?.effortLevel || "medium",
          feature: "refine",
        });
      }
      updateVariant(id, {
        message: data.message,
        why_it_fits: data.why_it_fits,
      });
      toast.success("Variant refined!", { id: toastId });
      playSfx("refine_complete");
    } catch (e: any) {
      toast.error(e.message || "Error refining variant", { id: toastId });
      playSfx("error");
    }
  };

  const personas = PERSONA_DATA;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 space-y-3 font-sans pb-6">
      {/* ─── Actionable state (only when something Forge needs is missing) ───
          The channel and provider readouts that used to live here were
          redundant: connection state is in the telemetry strip and provider
          configuration is in Tuning. Forge only speaks up when it cannot
          operate — a persistent status block is not failure feedback. */}
      {(!props.readiness.aiReady || !props.readiness.platformReady) && (
        <button
          type="button"
          onClick={props.onSelectTuning}
          className={cn(
            "w-full flex items-start gap-2 p-2.5 rounded-xl border text-left transition-all touch-target",
            !props.readiness.aiReady
              ? "bg-red-500/10 border-red-500/25 hover:bg-red-500/15"
              : "bg-amber-500/10 border-amber-500/25 hover:bg-amber-500/15"
          )}
        >
          <AlertTriangle className={cn("w-4 h-4 shrink-0 mt-0.5", !props.readiness.aiReady ? "text-red-400" : "text-amber-400")} />
          <span className="min-w-0">
            <span className={cn("block text-[11px] font-bold", !props.readiness.aiReady ? "text-red-300" : "text-amber-300")}>
              {!props.readiness.aiReady ? "No AI provider configured" : "No channel connected"}
            </span>
            <span className="block text-[10px] text-gray-400 leading-snug">
              {!props.readiness.aiReady
                ? "Forge can't generate until a provider is set. Tap to open Tuning → AI Provider."
                : "Chat context and mentions need a channel. Tap to open Tuning → Platform & Stream."}
            </span>
          </span>
        </button>
      )}

      {/* ─── Persona Selector ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-2">
        <div className="flex items-center justify-between text-xs font-bold text-gray-300">
          <span className="flex items-center gap-1.5">
            <Bot className="w-3.5 h-3.5 text-orange-400" />
            Persona Style
          </span>
          <span className="text-[10px] font-mono text-gray-500">
            {config.primaryProfile || "Default"}
          </span>
        </div>

        <div className="grid grid-cols-2 xs:grid-cols-3 gap-2">
          {personas.map((p) => {
            const active = config.primaryProfile === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  updateConfig({ primaryProfile: active ? "none" : p.value });
                  playSfx("palette_select");
                }}
                className={cn(
                  "group relative flex flex-col items-center justify-center gap-1.5 py-2.5 px-1.5 rounded-xl border text-[11px] font-bold transition-all touch-target overflow-hidden",
                  active
                    ? p.activeColor
                    : cn("bg-black/30 border-white/5 text-gray-400 hover:border-white/20", p.color)
                )}
                aria-pressed={active}
              >
                <PersonaPortrait
                  image={p.image}
                  still={p.imageStatic}
                  active={active}
                  size={36}
                />
                <div className="flex flex-col items-center text-center gap-0.5">
                  <span className={cn("text-[11px] leading-tight", p.fontClass)}>{p.label}</span>
                  <span className="text-[9px] font-mono opacity-60 leading-none">{p.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Humor & Chaos Sliders ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-3">
        {/* Humor */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs font-bold">
            <span className="text-gray-300">Humor Level</span>
            <span
              className={cn(
                "text-[10px] font-mono px-2 py-0.5 rounded border font-bold",
                config.humorLevel === 100
                  ? "bg-red-500/20 text-yellow-400 border-red-500/40"
                  : "bg-orange-500/10 text-orange-400 border-orange-500/20"
              )}
            >
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
            className="mobile-slider"
            aria-label="Humor level"
          />
        </div>

        {/* Chaos */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs font-bold">
            <span className="text-gray-300">Chaos Level</span>
            <span
              className={cn(
                "text-[10px] font-mono px-2 py-0.5 rounded border font-bold",
                config.chaosLevel === 100
                  ? "bg-purple-500/20 text-fuchsia-300 border-purple-500/40"
                  : "bg-purple-500/10 text-purple-400 border-purple-500/20"
              )}
            >
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
            className="mobile-slider mobile-slider-purple"
            aria-label="Chaos level"
          />
        </div>
      </div>

      {/* ─── Forge Variants Button Group ("1 | 2 | SMART | 3 | 4") ─── */}
      <div>
        <div className="flex items-center justify-between text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-1.5 px-0.5">
          <span className="flex items-center gap-1.5 text-orange-400">
            <Flame className="w-3.5 h-3.5" />
            <span>Forge Variants</span>
          </span>
          <span className="text-[10px] font-mono text-gray-500 lowercase">
            {isForging ? "forging…" : "pick batch size"}
          </span>
        </div>

        <div className="flex items-stretch gap-1 rounded-xl bg-[#121218] p-1 border border-white/5 shadow-lg">
          {/* 1 Card */}
          <button
            type="button"
            onClick={() => handleForge(1)}
            disabled={isForging || !props.readiness.aiReady}
            title="Forge 1 variant"
            className={cn(
              "flex-1 min-h-[46px] rounded-lg font-mono font-bold text-sm flex items-center justify-center transition-all touch-target border",
              isForging || !props.readiness.aiReady
                ? "bg-white/[0.02] border-transparent text-gray-600 cursor-not-allowed"
                : "bg-white/[0.04] hover:bg-orange-500/15 border-white/5 hover:border-orange-500/30 text-gray-200 hover:text-orange-300 active:scale-[0.98]"
            )}
          >
            1
          </button>

          {/* 2 Cards */}
          <button
            type="button"
            onClick={() => handleForge(2)}
            disabled={isForging || !props.readiness.aiReady}
            title="Forge 2 variants"
            className={cn(
              "flex-1 min-h-[46px] rounded-lg font-mono font-bold text-sm flex items-center justify-center transition-all touch-target border",
              isForging || !props.readiness.aiReady
                ? "bg-white/[0.02] border-transparent text-gray-600 cursor-not-allowed"
                : "bg-white/[0.04] hover:bg-orange-500/15 border-white/5 hover:border-orange-500/30 text-gray-200 hover:text-orange-300 active:scale-[0.98]"
            )}
          >
            2
          </button>

          {/* SMART Button (Hero center button) */}
          <button
            type="button"
            onClick={() => handleForge()}
            disabled={isForging || !props.readiness.aiReady}
            title="SMART: AI dynamically chooses variant count"
            className={cn(
              "flex-[1.6] min-h-[46px] px-2 rounded-lg font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition-all touch-target border relative overflow-hidden shadow-md",
              isForging
                ? "bg-orange-500/20 border-orange-500/50 text-orange-200"
                : props.readiness.aiReady
                ? "bg-gradient-to-r from-orange-500 via-orange-600 to-red-600 text-white border-orange-400/50 hover:brightness-110 active:scale-[0.98] shadow-orange-500/25"
                : "bg-white/5 border-white/5 text-gray-500 cursor-not-allowed"
            )}
          >
            {isForging ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
            )}
            <span className="truncate">{isForging ? "Forging" : "SMART"}</span>
          </button>

          {/* 3 Cards */}
          <button
            type="button"
            onClick={() => handleForge(3)}
            disabled={isForging || !props.readiness.aiReady}
            title="Forge 3 variants"
            className={cn(
              "flex-1 min-h-[46px] rounded-lg font-mono font-bold text-sm flex items-center justify-center transition-all touch-target border",
              isForging || !props.readiness.aiReady
                ? "bg-white/[0.02] border-transparent text-gray-600 cursor-not-allowed"
                : "bg-white/[0.04] hover:bg-orange-500/15 border-white/5 hover:border-orange-500/30 text-gray-200 hover:text-orange-300 active:scale-[0.98]"
            )}
          >
            3
          </button>

          {/* 4 Cards */}
          <button
            type="button"
            onClick={() => handleForge(4)}
            disabled={isForging || !props.readiness.aiReady}
            title="Forge 4 variants"
            className={cn(
              "flex-1 min-h-[46px] rounded-lg font-mono font-bold text-sm flex items-center justify-center transition-all touch-target border",
              isForging || !props.readiness.aiReady
                ? "bg-white/[0.02] border-transparent text-gray-600 cursor-not-allowed"
                : "bg-white/[0.04] hover:bg-orange-500/15 border-white/5 hover:border-orange-500/30 text-gray-200 hover:text-orange-300 active:scale-[0.98]"
            )}
          >
            4
          </button>
        </div>

        {!props.readiness.aiReady && (
          <p className="text-[10px] text-gray-500 text-center mt-1.5">
            Configure an AI provider in Tuning to start forging.
          </p>
        )}
      </div>

      {/* ─── Generated Variant Cards (When Available) ───
          Rendered below the Forge buttons so the action row stays anchored
          at the top of the tab and results fill in underneath, matching the
          mobile mental model (action first, results below). */}
      {variants.length > 0 && (
        <div className="space-y-2.5">
          {/* Variants Header & Hold to Clear */}
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5">
              <Flame className="w-3.5 h-3.5" />
              Forged Variants ({variants.length})
            </span>

            {/* Hold to Clear */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                startHold();
              }}
              onPointerUp={(e) => {
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
                cancelHold();
              }}
              onPointerCancel={cancelHold}
              className="relative px-3 py-1 rounded-lg border text-[10px] font-bold uppercase tracking-wider overflow-hidden select-none touch-none transition-all flex items-center gap-1"
              style={{
                color: holdProgress > 0 ? "#fff" : "#f87171",
                backgroundColor: holdProgress > 0 ? holdColor : "rgba(239, 68, 68, 0.08)",
                borderColor: holdProgress > 0 ? holdColor : "rgba(239, 68, 68, 0.3)",
              }}
              aria-label="Hold to clear all variants"
            >
              <Trash2 className="w-3 h-3" />
              <span>{holdProgress > 0 ? "Clearing…" : "Hold to Clear"}</span>
              {holdProgress > 0 && (
                <span
                  className="absolute bottom-0 left-0 h-0.5 bg-white transition-none"
                  style={{ width: `${holdProgress * 100}%` }}
                />
              )}
            </button>
          </div>

          {/* Cards List */}
          <div className="space-y-2.5">
            {variants.map((v) => (
              <VariantCard
                key={v.variant_id}
                variant={v}
                onSend={handleSend}
                onRefine={handleRefine}
                onClose={(id) => setVariants(variants.filter((item) => item.variant_id !== id))}
                multiBotActive={props.multiBotActive}
                activeBots={props.activeBots}
              />
            ))}
          </div>
        </div>
      )}

      {/* ─── AutoForge Controls ─── */}
      <div
        onClick={() => {
          const nv = !autoForgeEnabled;
          setAutoForgeEnabled(nv);
          playSfx(nv ? "autoforge_on" : "autoforge_off");
          toast.success(`AutoForge is now ${nv ? "enabled" : "disabled"}`);
        }}
        className="p-3 rounded-xl bg-[#121218] border border-white/5 flex items-center justify-between cursor-pointer hover:border-white/10 transition-colors touch-target"
        role="checkbox"
        aria-checked={autoForgeEnabled}
        aria-label="Toggle AutoForge"
      >
        <div className="flex items-center gap-2.5">
          <Bot className={cn("w-4 h-4", autoForgeEnabled ? "text-orange-400" : "text-gray-500")} />
          <div>
            <div className="text-xs font-bold text-gray-200">AutoForge</div>
            <div className="text-[10px] text-gray-500">
              {autoForgeEnabled
                ? autoForgeDryRun
                  ? "Dry run — decisions previewed only"
                  : "MADchatter automatically chimes into chat"
                : "Disabled — manual forge only"}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "w-11 h-6 rounded-full border p-0.5 transition-colors relative shrink-0",
            autoForgeEnabled
              ? "bg-orange-500/30 border-orange-500/50"
              : "bg-black/40 border-white/10"
          )}
        >
          <div
            className={cn(
              "w-4 h-4 rounded-full transition-transform",
              autoForgeEnabled
                ? "translate-x-5 bg-orange-400 shadow-[0_0_8px_rgba(249,115,22,0.6)]"
                : "translate-x-0 bg-gray-600"
            )}
          />
        </div>
      </div>

      {/* Auto-Check cadence — the user's control over how often AutoForge may
          spend an evaluation (replaces the old implicit 15s re-check). */}
      {autoForgeEnabled && (
        <div className="p-3 rounded-xl bg-[#121218] border border-white/5">
          <AutoCheckControls variant="compact" />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TUNING TAB (Comprehensive, Comfortable System Adjustments)
// ══════════════════════════════════════════════════════════════════════════════

const USABLE_CLOUD_PROVIDERS = [
  {
    id: "gemini",
    label: "Google Gemini",
    shortLabel: "Gemini",
    desc: "Fast & generous free tier",
    keyField: "geminiKey" as const,
    placeholder: "Paste AIzaSy... key",
    color: "text-blue-400",
  },
  {
    id: "openai",
    label: "OpenAI",
    shortLabel: "OpenAI",
    desc: "GPT-4o & ChatGPT models",
    keyField: "chatGptKey" as const,
    placeholder: "Paste sk-... key",
    color: "text-emerald-400",
  },
  {
    id: "claude",
    label: "Anthropic Claude",
    shortLabel: "Claude",
    desc: "Sonnet & Haiku models",
    keyField: "claudeKey" as const,
    placeholder: "Paste sk-ant-... key",
    color: "text-orange-400",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    desc: "Aggregator for 100+ models",
    keyField: "openRouterKey" as const,
    placeholder: "Paste sk-or-... key",
    color: "text-purple-400",
  },
  {
    id: "custom-openai",
    label: "Custom OpenAI-Compatible",
    shortLabel: "Custom",
    desc: "Groq, Cerebras, proxies & any OpenAI API",
    // customOpenAIKey is the closest key field; configured state is derived
    // from base URL + model (key optional), handled in the render below.
    keyField: "customOpenAIKey" as const,
    placeholder: "API key (optional)",
    color: "text-sky-400",
  },
] as const;

function MobileTuningTab(props: {
  readiness: ReturnType<typeof useCoreReadiness>;
  providerSummary: ReturnType<typeof getCoreProviderSummary>;
  activeUser: CoreMobileWorkspaceProps["activeUser"];
  activeLogin: () => void;
  activeLogout: () => void;
}) {
  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const setAutoForgeEnabled = useAppStore((s) => s.setAutoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  const setAutoForgeDryRun = useAppStore((s) => s.setAutoForgeDryRun);
  const autoForgeConfidenceThreshold = useAppStore((s) => s.autoForgeConfidenceThreshold);
  const setAutoForgeConfidenceThreshold = useAppStore((s) => s.setAutoForgeConfidenceThreshold);
  const r34lEnabled = useAppStore((s) => s.r34lEnabled);
  const setR34lEnabled = useAppStore((s) => s.setR34lEnabled);
  const sfxEnabled = useAppStore((s) => s.sfxEnabled);
  const setSfxEnabled = useAppStore((s) => s.setSfxEnabled);
  const ttsEnabled = useAppStore((s) => s.ttsEnabled);
  const setTtsEnabled = useAppStore((s) => s.setTtsEnabled);
  const smartRepliesEnabled = useAppStore((s) => s.smartRepliesEnabled);
  const setSmartRepliesEnabled = useAppStore((s) => s.setSmartRepliesEnabled);

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const authTick = useAppStore((s) => s.authTick);
  const activeProvider = getActiveProvider();
  const keys = getKeys();

  const handleSaveKey = (providerId: string, label: string, keyField: keyof ReturnType<typeof getKeys>) => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      toast.error("Please paste an API key");
      return;
    }
    saveKeys({ [keyField]: trimmed });
    setActiveProvider(providerId);
    setExpandedProvider(null);
    setApiKeyInput("");
    toast.success(`${label} key saved — active now!`);
    playSfx("welcome_dismiss");
  };

  const handleRemoveKey = (providerId: string, label: string, keyField: keyof ReturnType<typeof getKeys>) => {
    saveKeys({ [keyField]: "" });
    setApiKeyInput("");
    toast.success(`${label} key removed`);
    playSfx("memory_remove");
    if (activeProvider === providerId) {
      const fallback = getProviderWithKey() || "gemini";
      setActiveProvider(fallback);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 space-y-3.5 font-sans pb-8">
      {/* ─── 1. Platform & Channel Connection ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-2.5">
        <div className="text-xs font-bold uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
          <Tv className="w-3.5 h-3.5" />
          Platform & Stream
        </div>

        {/* Platform Selector */}
        <div className="flex gap-1.5">
          {(["twitch", "kick", "joystick"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setPlatform(p);
                playSfx("palette_select");
              }}
              className={cn(
                "flex-1 py-2 rounded-lg border text-xs font-bold capitalize transition-all touch-target",
                platform === p
                  ? "bg-purple-500/20 border-purple-500/50 text-purple-200"
                  : "bg-black/30 border-white/5 text-gray-400 hover:text-white"
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Channel Row */}
        <div>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">
            Watching Channel
          </span>
          <ChannelEditRow
            channelName={streamMetadata.channelName || ""}
            onSave={async (name) => {
              try {
                if (await switchChannel(name)) {
                  toast.success(`Now watching @${name}`);
                  playSfx("memory_add");
                }
              } catch (e: any) {
                toast.error(e.message || "Failed to switch channel");
              }
            }}
          />
        </div>

        {/* Account identity intentionally NOT repeated here — the persistent
            mobile header owns it (username + disconnect). This section stays
            focused on platform, channel, and stream configuration. */}
      </div>

      {/* ─── 2. AI Engine & Provider ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5" />
            AI Provider & Keys
          </div>
          <span
            className={cn(
              "text-[10px] px-2 py-0.5 rounded border font-mono font-bold",
              props.readiness.aiReady
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-red-500/10 border-red-500/30 text-red-300"
            )}
          >
            {props.readiness.aiReady ? "Ready" : "No Key Set"}
          </span>
        </div>

        {/* Notice if Ollama was active from desktop */}
        {activeProvider === "ollama" && (
          <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 flex items-start gap-2 text-xs">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-amber-300">Ollama is desktop-only</span>
              <p className="text-[11px] text-amber-200/80 mt-0.5 leading-snug">
                Local Ollama models cannot run on this mobile device. Select and insert a cloud provider key below.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          {USABLE_CLOUD_PROVIDERS.map((p) => {
            const isCustom = p.id === "custom-openai";
            const savedKey = keys[p.keyField];
            // Custom OpenAI-compatible is "configured" on base URL + model;
            // the API key itself is optional for no-auth endpoints.
            const hasKey = isCustom
              ? !!(keys.customOpenAIBaseUrl && keys.customOpenAIModel)
              : !!savedKey;
            const isActive = activeProvider === p.id && hasKey;
            const isExpanded = expandedProvider === p.id;

            return (
              <div key={p.id} className="rounded-lg border border-white/5 bg-black/20 overflow-hidden">
                {/* Provider Row */}
                <div
                  className={cn(
                    "p-2.5 flex items-center justify-between transition-colors cursor-pointer touch-target",
                    isActive
                      ? "bg-white/[0.06] border-l-2 border-l-cyan-400"
                      : "hover:bg-white/[0.02]"
                  )}
                  onClick={() => {
                    if (hasKey && !isActive) {
                      setActiveProvider(p.id);
                      toast.success(`Switched to ${p.shortLabel}`);
                      playSfx("palette_select");
                    } else {
                      const nextExpanded = isExpanded ? null : p.id;
                      setExpandedProvider(nextExpanded);
                      setApiKeyInput(nextExpanded && hasKey ? String(savedKey) : "");
                      if (nextExpanded) {
                        setTimeout(() => apiKeyInputRef.current?.focus(), 80);
                      }
                    }
                  }}
                >
                  <div className="flex-1 min-w-0 pr-2">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-xs font-bold", p.color)}>
                        {p.label}
                      </span>
                      {isActive && (
                        <span className="text-[9px] font-bold uppercase tracking-wider text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 px-1.5 py-0.2 rounded">
                          Active
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-gray-500 block truncate">
                      {p.desc}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {hasKey ? (
                      isCustom ? (
                        // Key optional — show a configured badge, not a mask.
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <Check className="w-2.5 h-2.5" />
                          configured
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <Check className="w-2.5 h-2.5" />
                          ••{String(savedKey).slice(-4)}
                        </span>
                      )
                    ) : (
                      <span className="text-[10px] text-gray-500 font-medium">
                        {isCustom ? "add endpoint" : "add key"}
                      </span>
                    )}

                    <button
                      type="button"
                      aria-label={isExpanded ? "Collapse" : "Edit API Key"}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextExpanded = isExpanded ? null : p.id;
                        setExpandedProvider(nextExpanded);
                        setApiKeyInput(nextExpanded && hasKey ? String(savedKey) : "");
                        if (nextExpanded) {
                          setTimeout(() => apiKeyInputRef.current?.focus(), 80);
                        }
                      }}
                      className="p-1 text-gray-400 hover:text-white"
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-cyan-400" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Inline Key Configuration Drawer */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden border-t border-white/5 bg-[#0e0e14] p-3 space-y-2.5"
                    >
                      {isCustom ? (
                        <CustomProviderConfigFields onActive={() => setExpandedProvider(null)} />
                      ) : (
                        <>
                          <div className="flex items-center justify-between text-[11px] text-gray-400">
                            <span className="font-bold text-gray-300">
                              {hasKey ? `Update ${p.shortLabel} API Key` : `Enter ${p.shortLabel} API Key`}
                            </span>
                            {hasKey && (
                              <span className="text-emerald-400 text-[10px]">Saved in browser</span>
                            )}
                          </div>

                          <div className="space-y-1">
                            <input
                              ref={apiKeyInputRef}
                              type="password"
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  handleSaveKey(p.id, p.shortLabel, p.keyField);
                                }
                                if (e.key === "Escape") {
                                  setExpandedProvider(null);
                                  setApiKeyInput("");
                                }
                              }}
                              placeholder={p.placeholder}
                              className="w-full px-3 py-2 rounded-lg bg-black/60 border border-white/10 text-xs text-white placeholder-gray-600 focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 font-mono"
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck="false"
                            />
                          </div>

                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => handleSaveKey(p.id, p.shortLabel, p.keyField)}
                              className="flex-1 py-1.5 px-3 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-xs font-bold transition-all flex items-center justify-center gap-1.5 touch-target"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{hasKey ? "Update & Activate" : "Save & Activate"}</span>
                            </button>

                            {hasKey && (
                              <button
                                type="button"
                                onClick={() => handleRemoveKey(p.id, p.shortLabel, p.keyField)}
                                className="py-1.5 px-2.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-bold transition-all touch-target"
                                title="Remove saved key"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                setExpandedProvider(null);
                                setApiKeyInput("");
                              }}
                              className="py-1.5 px-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 text-xs font-medium transition-all"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── 3. Behavior & Voice Options ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5">
          <Sliders className="w-3.5 h-3.5" />
          Voice & Interaction Tuning
        </div>

        {/* Effort level */}
        <div className="space-y-1">
          <span className="text-[11px] text-gray-400 font-bold">Effort / Reasoning Mode</span>
          <div className="grid grid-cols-4 gap-1">
            {(["low", "medium", "high", "smart"] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => updateConfig({ effortLevel: lvl })}
                className={cn(
                  "py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target",
                  (config.effortLevel || "medium") === lvl
                    ? "bg-orange-500/20 border-orange-500/50 text-orange-300"
                    : "bg-black/30 border-white/5 text-gray-500"
                )}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-2 pt-1 border-t border-white/5">
          {/* TTS */}
          <div
            onClick={() => setTtsEnabled(!ttsEnabled)}
            className="flex items-center justify-between text-xs cursor-pointer py-1 touch-target"
          >
            <span className="text-gray-300">Text-to-Speech (TTS)</span>
            <span
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded border",
                ttsEnabled
                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                  : "bg-white/5 border-white/5 text-gray-500"
              )}
            >
              {ttsEnabled ? "ON" : "OFF"}
            </span>
          </div>

          {/* Sound Effects */}
          <div
            onClick={() => setSfxEnabled(!sfxEnabled)}
            className="flex items-center justify-between text-xs cursor-pointer py-1 touch-target"
          >
            <span className="text-gray-300">Sound Effects & SFX</span>
            <span
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded border",
                sfxEnabled
                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                  : "bg-white/5 border-white/5 text-gray-500"
              )}
            >
              {sfxEnabled ? "ON" : "OFF"}
            </span>
          </div>

          {/* R34L Typing */}
          <div
            onClick={() => setR34lEnabled(!r34lEnabled)}
            className="flex items-center justify-between text-xs cursor-pointer py-1 touch-target"
          >
            <span className="text-gray-300">R34L Human Typing Emulation</span>
            <span
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded border",
                r34lEnabled
                  ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                  : "bg-white/5 border-white/5 text-gray-500"
              )}
            >
              {r34lEnabled ? "ON" : "OFF"}
            </span>
          </div>

          {/* Smart Replies — generates click-to-send reply suggestions when
              the bot is mentioned. Works with AutoForge off (mention-only
              loop) or on. The generation loop is mounted globally, so this
              toggle is all mobile users need to turn it on. */}
          <div
            onClick={() => setSmartRepliesEnabled(!smartRepliesEnabled)}
            className="flex items-center justify-between text-xs cursor-pointer py-1 touch-target"
          >
            <div className="flex flex-col min-w-0">
              <span className="text-gray-300">Smart Replies</span>
              <span className="text-[9px] text-gray-600 truncate">
                Suggest replies when your bot is mentioned
              </span>
            </div>
            <span
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded border shrink-0",
                smartRepliesEnabled
                  ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300"
                  : "bg-white/5 border-white/5 text-gray-500"
              )}
            >
              {smartRepliesEnabled ? "ON" : "OFF"}
            </span>
          </div>
        </div>
      </div>

      {/* ─── 4. Message Style ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-pink-400 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          Message Style
        </div>

        {/* Emote Density */}
        <div className="space-y-1">
          <span className="text-[11px] text-gray-400 font-bold">Emote Density</span>
          <div className="grid grid-cols-3 gap-1">
            {(["minimal", "moderate", "heavy"] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => updateConfig({ emoteDensity: lvl })}
                className={cn(
                  "py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target",
                  (config.emoteDensity || "moderate") === lvl
                    ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                    : "bg-black/30 border-white/5 text-gray-500"
                )}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        {/* Message Length */}
        <div className="space-y-1">
          <span className="text-[11px] text-gray-400 font-bold">Message Length</span>
          <div className="grid grid-cols-3 gap-1">
            {(["short", "medium", "long"] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => updateConfig({ lengthPreference: lvl })}
                className={cn(
                  "py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target",
                  (config.lengthPreference || "short") === lvl
                    ? "bg-pink-500/20 border-pink-500/50 text-pink-300"
                    : "bg-black/30 border-white/5 text-gray-500"
                )}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        {/* Toxicity Filter */}
        <div className="space-y-1 pt-1 border-t border-white/5">
          <span className="text-[11px] text-gray-400 font-bold">Content Filter</span>
          <div className="grid grid-cols-3 gap-1">
            {(["family", "standard", "unfiltered"] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => updateConfig({ toxicityFilter: lvl })}
                className={cn(
                  "py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target",
                  (config.toxicityFilter || "standard") === lvl
                    ? lvl === "family"
                      ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
                      : lvl === "unfiltered"
                        ? "bg-red-500/20 border-red-500/50 text-red-300"
                        : "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-black/30 border-white/5 text-gray-500"
                )}
              >
                {lvl}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-gray-500">
            {config.toxicityFilter === "family"
              ? "Family-friendly — strict language filter"
              : config.toxicityFilter === "unfiltered"
                ? "No filter — raw output"
                : "Standard — default moderation"}
          </div>
        </div>
      </div>

      {/* ─── 5. AutoForge Tuning ─── */}
      <div className="p-3 rounded-xl bg-[#121218] border border-white/5 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5" />
          AutoForge Automation Tuning
        </div>

        {/* Dry Run Toggle */}
        <div
          onClick={() => {
            const nd = !autoForgeDryRun;
            setAutoForgeDryRun(nd);
            toast.info(`Dry run mode ${nd ? "enabled" : "disabled"}`);
          }}
          className="flex items-center justify-between text-xs cursor-pointer py-1 touch-target"
        >
          <div>
            <div className="text-gray-200 font-bold">Dry Run Mode</div>
            <div className="text-[10px] text-gray-500">Preview decisions in chat log without live sends</div>
          </div>
          <span
            className={cn(
              "text-[10px] font-bold px-2 py-0.5 rounded border",
              autoForgeDryRun
                ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                : "bg-white/5 border-white/5 text-gray-500"
            )}
          >
            {autoForgeDryRun ? "DRY RUN" : "LIVE"}
          </span>
        </div>

        {/* Confidence Threshold */}
        <div className="space-y-1 pt-1 border-t border-white/5">
          <div className="flex justify-between items-center text-xs font-bold">
            <span className="text-gray-300">Confidence Threshold</span>
            <span className="text-[10px] font-mono text-amber-400">
              {(autoForgeConfidenceThreshold * 100).toFixed(0)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={autoForgeConfidenceThreshold}
            onChange={(e) => setAutoForgeConfidenceThreshold(parseFloat(e.target.value))}
            className="mobile-slider mobile-slider-amber"
            aria-label="Confidence threshold"
          />
        </div>
      </div>

    </div>
  );
}
