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
  CheckCircle2,
  LogIn,
  LogOut,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
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
import { useAppStore, selectMultiBotActive, MOBILE_DIRECTOR_NOTE_LIMIT } from "../store";
import { useCoreReadiness } from "../hooks/useCoreReadiness";
import { useNowTick } from "../hooks/useNowTick";
import { useEffectiveMode, useStudioAvailable } from "../hooks/useMediaQuery";
import { useEffectiveAutoForgeDecision } from "../hooks/useEffectiveAutoForgeDecision";
import { getCoreProviderSummary } from "../lib/coreProviderSummary";
import { getActiveProvider, getKeys, setActiveProvider, saveKeys, getProviderWithKey } from "../lib/keys";
import { useHoldToConfirm } from "../hooks/useHoldToConfirm";
import { isDecisionPayloadSent } from "../lib/autoForgeCore";
import { sendManualMessage } from "../lib/manualSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { playSfx } from "../lib/sfx";
import { switchChannel } from "../lib/channelSwitch";
import { getPlatformSendFn } from "../lib/platformSend";
import { refineSuggestion, visionRequest } from "../lib/ai";
import { resolveCurrentR34lAdaptation } from "../lib/r34lAdaptation";
import { R34lInlineDetails } from "./R34lReadout";
import { MobileIntentRange } from "./MobileIntentRange";
import { MobileWelcomeOverlay } from "./MobileWelcomeOverlay";
import { MobileFriendTrialCard } from "./MobileFriendTrialCard";
import { acknowledgeMobileWelcome, hasSeenMobileWelcome } from "../lib/mobileOnboarding";
import { perception, classifyVisionError } from "../lib/perceptionLiveness";
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
import { RoomReadCard } from "./RoomReadCard";
import { mergeAutoForgeDecisionHistory, navigateAutoForgeHistory, resolveAutoForgeHistorySelection } from "../lib/autoForgeHistory";
import {
  collapseMobileProviderDisclosure,
  isAdaptiveLengthPreference,
  isMobileLengthOptionActive,
  toggleMobileLengthPreference,
  type MobileLengthOption,
} from "../lib/mobileControls";
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
  snapDisabled?: boolean;
  smartLevel: number;
  onCycleSmartLevel: () => void;
  visualCaptureInterval: number;
  setVisualCaptureInterval: (v: number) => void;
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
  snapDisabled?: boolean;
  smartLevel: number;
  onCycleSmartLevel: () => void;
  visualCaptureInterval: number;
  setVisualCaptureInterval: (v: number) => void;
}) {
  const [mobileTab, setMobileTab] = useState<"context" | "forge" | "tuning">("forge");
  const [mobileWelcomeOpen, setMobileWelcomeOpen] = useState(() => !hasSeenMobileWelcome());
  const [tuningOnboardingRequest, setTuningOnboardingRequest] = useState(0);
  const tuningScrollRef = useRef<HTMLDivElement>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [telemetryExpanded, setTelemetryExpanded] = useState(false);
  // null follows the newest entry. A key pins the page the operator chose, so
  // a new decision cannot yank an intentional historical view back to latest.
  const [selectedTelemetryHistoryKey, setSelectedTelemetryHistoryKey] = useState<string | null>(null);
  const [sendingDecisionKeys, setSendingDecisionKeys] = useState<ReadonlySet<string>>(() => new Set());

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
  const { decision: lastAutoForgeDecision, bot: lastDecisionBot } = useEffectiveAutoForgeDecision();
  const autoForgeDecisionHistory = useAppStore((s) => s.autoForgeDecisionHistory);
  const autoForgeNextActionMs = useAppStore((s) => s.autoForgeNextActionMs);
  // Shared app clock (hooks/useNowTick).
  const now = useNowTick();
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
  const mergedDecisionHistory = useMemo(
    () => mergeAutoForgeDecisionHistory(
      autoForgeDecisionHistory,
      multiBotActive ? activeBots : [],
    ),
    [autoForgeDecisionHistory, multiBotActive, activeBots],
  );
  const telemetryHistorySelection = resolveAutoForgeHistorySelection(
    mergedDecisionHistory,
    selectedTelemetryHistoryKey,
  );
  const selectedTelemetryEntry = telemetryHistorySelection.entry;
  const telemetryDecision = selectedTelemetryEntry?.decision ?? lastAutoForgeDecision;
  const telemetryDecisionBot = selectedTelemetryEntry?.bot ?? lastDecisionBot;
  const telemetryDecisionKey = selectedTelemetryEntry?.key
    ?? `effective:${telemetryDecisionBot?.id ?? "legacy"}:${telemetryDecision?.timestamp ?? 0}:${telemetryDecision?.decision ?? "none"}`;

  const setDecisionSending = useCallback((key: string, sending: boolean) => {
    setSendingDecisionKeys((current) => {
      const next = new Set(current);
      if (sending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const dismissWelcomeToTuning = useCallback(() => {
    acknowledgeMobileWelcome();
    setMobileWelcomeOpen(false);
    setMobileTab("tuning");
    // A first-run handoff should expose providers even if this browser tab had
    // previously retained the session-scoped disclosure as collapsed.
    try { sessionStorage.setItem("core-mobile-provider-collapsed", "0"); } catch { /* private mode */ }
    setTuningOnboardingRequest((request) => request + 1);
    requestAnimationFrame(() => {
      if (tuningScrollRef.current) tuningScrollRef.current.scrollTop = 0;
    });
  }, []);

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
        {/* Room Read — shared Room Model surface, compact on mobile (once a
            channel is live). Pure consumer of the store mirror. */}
        {readiness.phase !== "setup" && !!streamMetadata?.channelName && (
          <div className="shrink-0 px-3 pt-2">
            <RoomReadCard compact />
          </div>
        )}
        <MobileContextTab
          activeUser={props.activeUser}
          draft={chatDraft}
          setDraft={setChatDraft}
          onVisualCapture={props.onVisualCapture}
          onManualSnapshot={props.onManualSnapshot}
          isVisualCapturing={props.isVisualCapturing}
          visualCooldown={props.visualCooldown}
          snapDisabled={props.snapDisabled}
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
            scrollRef={tuningScrollRef}
            onboardingRequest={tuningOnboardingRequest}
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
            onClick={() => {
              if (!telemetryExpanded) setSelectedTelemetryHistoryKey(null);
              setTelemetryExpanded(!telemetryExpanded);
            }}
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

              {/* Chronological decision history shared with the desktop HUD. */}
              {telemetryDecision ? (
                <div className="bg-black/40 rounded-lg p-2 border border-white/5 space-y-1.5 min-w-0">
                  {mergedDecisionHistory.length > 0 && (
                    <div className="grid grid-cols-[44px_1fr_44px] items-center gap-1 border-b border-white/5 pb-1.5">
                      <button
                        type="button"
                        onClick={() => setSelectedTelemetryHistoryKey(navigateAutoForgeHistory(
                          mergedDecisionHistory,
                          telemetryHistorySelection.index,
                          "previous",
                        ))}
                        disabled={telemetryHistorySelection.index <= 0}
                        aria-label="Previous AutoForge decision"
                        className="touch-target inline-flex items-center justify-center rounded-md border border-white/10 bg-white/5 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-center text-[10px] text-gray-400 font-mono" aria-live="polite">
                        {telemetryHistorySelection.index + 1} / {mergedDecisionHistory.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedTelemetryHistoryKey(navigateAutoForgeHistory(
                          mergedDecisionHistory,
                          telemetryHistorySelection.index,
                          "next",
                        ))}
                        disabled={telemetryHistorySelection.index >= mergedDecisionHistory.length - 1}
                        aria-label="Next AutoForge decision"
                        className="touch-target inline-flex items-center justify-center rounded-md border border-white/10 bg-white/5 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] min-w-0">
                    <span className="text-orange-400 font-bold uppercase break-words min-w-0">
                      Decision: {telemetryDecision.decision}
                      {telemetryDecisionBot && (
                        <span className="text-purple-300 font-mono normal-case"> @{telemetryDecisionBot.session?.username ?? telemetryDecisionBot.label}</span>
                      )}
                    </span>
                    <span className="text-gray-400 font-mono shrink-0">
                      {(telemetryDecision.confidence * 100).toFixed(0)}% conf
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-300 font-sans leading-snug break-words">
                    {typeof telemetryDecision.reason === "string" ? telemetryDecision.reason : "No reason recorded."}
                  </div>
                  {typeof telemetryDecision.action_payload === "string" && telemetryDecision.action_payload.trim() ? (
                    <DecisionSendButton
                      decisionKey={telemetryDecisionKey}
                      payload={telemetryDecision.action_payload}
                      botId={telemetryDecisionBot?.id}
                      botSentMessages={telemetryDecisionBot?.runtime.sentMessages}
                      sending={sendingDecisionKeys.has(telemetryDecisionKey)}
                      onSendingChange={(sending) => setDecisionSending(telemetryDecisionKey, sending)}
                      onSent={(text) => {
                        // TTS after successful delivery only — a failed send
                        // never speaks. speakMessage owns its own enable check.
                        speakMessage(text);
                      }}
                    />
                  ) : (
                    <div className="text-[10px] text-gray-500 font-sans italic rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
                      No message to deliver for this decision.
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

      {mobileWelcomeOpen && (
        <MobileWelcomeOverlay onDismissToTuning={dismissWelcomeToTuning} />
      )}
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
  snapDisabled?: boolean;
}) {
  const [streamMinimized, setStreamMinimized] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [autoScrollLocked, setAutoScrollLocked] = useState(true);
  const [newMessagesWhileScrolled, setNewMessagesWhileScrolled] = useState(0);

  // Audio Transcription notice dismissal — session-scoped (sessionStorage),
  // so it stays hidden for the duration of the user's visit but returns on a
  // fresh session. Matches the telemetry strip collapse pattern.
  const [audioNoticeDismissed, setAudioNoticeDismissed] = useState(() => {
    try { return sessionStorage.getItem("core-audio-notice-dismissed") === "1"; } catch { return false; }
  });
  const dismissAudioNotice = () => {
    setAudioNoticeDismissed(true);
    try { sessionStorage.setItem("core-audio-notice-dismissed", "1"); } catch { /* private mode */ }
  };

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
    // The player div is always mounted while a channel is set — when the
    // video is hidden it shrinks to an invisible 2px box so stream audio
    // keeps playing. The player is therefore created once per channel and
    // never needs recreation on hide/show.
    const el = document.getElementById(twitchPlayerId);
    if (!el) return;
    if (twitchPlayerRef.current) {
      try { twitchPlayerRef.current.destroy(); } catch {}
    }
    el.innerHTML = "";
    twitchPlayerRef.current = new window.Twitch.Player(twitchPlayerId, {
      channel,
      parent,
      muted: false,
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
    let dataUrl: string | null = null;
    try {
      dataUrl = await fetchStreamThumbnailDataUrl(platform, channel, 1280, 720);
      if (!dataUrl) {
        toast.error("Couldn't fetch the stream preview. The stream may be offline.", { id: toastId });
        return;
      }
      // Store the raw capture in the CURRENT snapshot state (skipHistory —
      // this is not the canonical record yet). One physical Snap must produce
      // exactly ONE history entry, created below with the real analysis
      // outcome (analyzed / no analysis / vision failed).
      setVisualSnapshot(dataUrl, ["Captured"], "manual", undefined, true);
      toast.loading("Analyzing stream frame…", { id: toastId });
      const provider = getActiveProvider();
      const data = await visionRequest(dataUrl, provider, null);
      // Perception Liveness: manual thumbnail snap round-trip succeeded — the
      // mobile vision lane reports LIVE even though screen capture is
      // unsupported (the engine evaluates evidence, not capability defaults).
      perception.noteVisionSemantic({ ok: true });
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
      // Perception Liveness: semantic-stage failure with a stable reason code
      // (stream offline fetch failure vs provider failure).
      perception.noteVisionSemantic({ ok: false, code: classifyVisionError(e) });
      // If the capture itself succeeded but vision failed, record the canonical
      // history entry with the real outcome (one Snap = one entry).
      if (dataUrl) {
        setVisualSnapshot(dataUrl, ["Captured — vision failed"], "manual");
      }
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
            "flex items-center justify-between px-3 py-1.5 gap-2",
            videoVisible
              ? "absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 via-black/40 to-transparent"
              : "bg-[#121218] border-b border-white/5",
          )}
        >
          <div className="flex items-center gap-2 text-xs font-bold text-gray-300 shrink-0">
            <Tv className="w-3.5 h-3.5 text-purple-400" />
            <span>{channel ? `@${channel}` : "No stream selected"}</span>
            {channel && (
              <span className="text-[9px] uppercase px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 font-mono">
                {platform}
              </span>
            )}
          </div>

          {/* Snap / Visual controls — moved to the header so they don't cover
              the embed's bottom volume slider. Same compact sizing as before.
              Fades out when the video is hidden (streamMinimized) since they
              only make sense while the stream is visible. */}
          <AnimatePresence>
            {!streamMinimized && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-1 shrink-0"
              >
                {/* Screen Capture + Snap — only when getDisplayMedia is supported.
                    On mobile browsers these are dead (getDisplayMedia is undefined),
                    so we hide them and show a notice instead of broken buttons. */}
                {visualCaptureSupported && (
                  <>
                    <button
                      type="button"
                      onClick={props.onVisualCapture}
                      className={cn(
                        "h-7 shrink-0 px-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-1 transition-colors",
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
                      disabled={props.isVisualCapturing && (props.visualCooldown || props.snapDisabled)}
                      title={props.snapDisabled
                        ? "Disabled in Friend Trial (60s auto-loop)"
                        : props.isVisualCapturing
                          ? "Analyze the current stream frame"
                          : "Start capture, then tap SNAP again"}
                      aria-label="Capture a stream snapshot (manual)"
                      className={cn(
                        "h-7 shrink-0 px-1.5 rounded-lg text-[10px] font-bold uppercase border flex items-center justify-center gap-1 transition-colors disabled:opacity-50 touch-target",
                        props.isVisualCapturing && !props.visualCooldown && !props.snapDisabled
                          ? "bg-blue-500/15 text-blue-400 border-blue-500/25"
                          : "bg-white/5 text-gray-400 border-white/10 hover:text-gray-200"
                      )}
                    >
                      <Camera className="w-3 h-3 shrink-0" />
                      <span>Snap</span>
                      {props.isVisualCapturing && !props.visualCooldown && !props.snapDisabled && (
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
                      "h-7 shrink-0 px-1.5 rounded-lg text-[10px] font-bold uppercase border flex items-center justify-center gap-1 transition-colors disabled:opacity-50 touch-target",
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
                  className="h-7 shrink-0 px-1.5 rounded-lg text-[10px] font-bold uppercase bg-teal-500/15 text-teal-300 border border-teal-500/25 flex items-center justify-center gap-1 touch-target"
                >
                  <Clock className="w-3 h-3 shrink-0" />
                  <span>Visual</span>
                  {visualSnapshotHistory.length > 0 && (
                    <span className="font-mono text-[9px] opacity-80 shrink-0">{visualSnapshotHistory.length}</span>
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <button
            type="button"
            onClick={() => setStreamMinimized((v) => !v)}
            className={cn(
              "font-bold rounded transition-colors touch-action-manipulation shrink-0",
              streamMinimized
                ? "text-xs text-purple-200 px-3 py-1.5 bg-purple-500/25 border border-purple-500/40 hover:bg-purple-500/35 flex items-center gap-1.5"
                : "text-[10px] text-gray-400 hover:text-white px-2 py-1 bg-white/10",
            )}
          >
            {streamMinimized ? (
              <>
                {channel && platform !== "joystick" && (
                  <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" aria-label="Audio playing" />
                )}
                <Tv className="w-3.5 h-3.5" />
                <span>Show Video</span>
              </>
            ) : (
              "Hide Video"
            )}
          </button>
        </div>

        {/* Video Player — always mounted when a channel is set so stream
            audio keeps playing when the video is hidden. When minimized the
            wrapper collapses to 0px and the player shrinks to an invisible
            2px box (opacity-0 keeps it in the render tree — display:none
            would let the browser pause the media). */}
        {channel && (
          <div
            className={cn(
              "w-full relative bg-black overflow-hidden",
              streamMinimized ? "h-0" : "flex items-center justify-center"
            )}
          >
            <div
              className={cn(
                streamMinimized
                  ? "absolute top-0 left-0 w-[2px] h-[2px] opacity-0 pointer-events-none overflow-hidden"
                  : "w-full relative aspect-video max-h-[220px]"
              )}
            >
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
            {/* Audio Transcript status — dismissible for the session */}
            {!audioNoticeDismissed && (
              <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-300 text-[11px] relative pr-8">
                <span className="font-bold block mb-0.5">Audio Transcription</span>
                System audio capture requires a desktop Chromium browser (Chrome/Edge) with WebGPU. Not available on mobile browsers.
                <button
                  type="button"
                  onClick={dismissAudioNotice}
                  className="absolute top-1.5 right-1.5 p-1 text-purple-400 hover:text-purple-200 transition-colors"
                  aria-label="Dismiss audio transcription notice"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Pinned memory items — horizontal scroll strip so all pinned
                moments are reachable by swiping instead of a vertical list
                that gets cut off. */}
            {pinnedMemories.length > 0 ? (
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-gray-400 uppercase">
                  Pinned Moments ({pinnedMemories.length})
                </span>
                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin snap-x snap-mandatory">
                  {pinnedMemories.slice().reverse().map((mem) => (
                    <div
                      key={mem.id}
                      className="flex items-center gap-1.5 shrink-0 snap-start w-[200px] p-1.5 rounded bg-black/40 border border-white/5 text-[11px]"
                    >
                      <Pin className="w-3 h-3 text-orange-400 shrink-0" />
                      <span className="truncate text-gray-300 flex-1 min-w-0">{mem.label}</span>
                      <button
                        type="button"
                        onClick={() => removePinnedMemory(mem.id)}
                        className="text-gray-500 hover:text-red-400 shrink-0"
                        aria-label="Remove memory"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
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

  // Hold-to-Clear state (1.25s) — shared deterministic controller
  // (src/lib/holdToClear.ts via useHoldToConfirm). The old duplicated
  // timer/RAF logic could leave a stale final RAF frame stuck at
  // "Clearing…" after completion; the generation guard makes that impossible.
  const { progress: holdProgress, start: startHold, cancel: cancelHold } = useHoldToConfirm({
    durationMs: 1250,
    onConfirm: () => {
      setVariants([]);
      playSfx("clear_context");
      toast.success("All variants cleared.");
    },
  });

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
        r34lContext: useAppStore.getState().r34lEnabled
          ? resolveCurrentR34lAdaptation().promptBlock
          : undefined,
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
          <MobileIntentRange
            min={0}
            max={100}
            step={1}
            value={config.humorLevel}
            onValueChange={(value) => updateConfig({ humorLevel: value })}
            ariaLabel="Humor level"
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
          <MobileIntentRange
            min={0}
            max={100}
            step={1}
            value={config.chaosLevel}
            onValueChange={(value) => updateConfig({ chaosLevel: value })}
            className="mobile-slider-purple"
            ariaLabel="Chaos level"
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

const MOBILE_EMOTE_STYLE = {
  minimal: {
    base: "bg-pink-500/[0.04] border-pink-500/15 text-pink-200/55",
    active: "bg-pink-500/20 border-pink-300/70 text-pink-100 ring-1 ring-pink-400/35",
  },
  moderate: {
    base: "bg-pink-500/[0.09] border-pink-500/25 text-pink-200/70",
    active: "bg-pink-500/25 border-pink-300/80 text-pink-100 ring-1 ring-pink-400/45 shadow-[0_0_10px_rgba(236,72,153,0.15)]",
  },
  heavy: {
    base: "bg-fuchsia-500/[0.15] border-fuchsia-500/35 text-fuchsia-200/90 shadow-[0_0_8px_rgba(217,70,239,0.08)]",
    active: "bg-fuchsia-500/30 border-fuchsia-200/90 text-white ring-1 ring-fuchsia-300/60 shadow-[0_0_14px_rgba(217,70,239,0.28)]",
  },
} as const;

const MOBILE_LENGTH_STYLE = {
  short: {
    base: "bg-rose-500/[0.04] border-rose-500/15 text-rose-200/55",
    active: "bg-rose-500/20 border-rose-300/70 text-rose-100 ring-1 ring-rose-400/35",
  },
  medium: {
    base: "bg-rose-500/[0.09] border-rose-500/25 text-rose-200/70",
    active: "bg-rose-500/25 border-rose-300/80 text-rose-100 ring-1 ring-rose-400/45 shadow-[0_0_10px_rgba(244,63,94,0.15)]",
  },
  long: {
    base: "bg-pink-500/[0.15] border-pink-500/35 text-pink-200/90 shadow-[0_0_8px_rgba(236,72,153,0.08)]",
    active: "bg-pink-500/30 border-pink-200/90 text-white ring-1 ring-pink-300/60 shadow-[0_0_14px_rgba(236,72,153,0.28)]",
  },
} as const;

const MOBILE_FILTER_STYLE = {
  family: {
    base: "bg-emerald-500/[0.06] border-emerald-500/20 text-emerald-300/70",
    active: "bg-emerald-500/22 border-emerald-300/80 text-emerald-100 ring-1 ring-emerald-400/45",
  },
  standard: {
    base: "bg-amber-500/[0.10] border-amber-500/28 text-amber-300/80",
    active: "bg-amber-500/25 border-amber-300/80 text-amber-100 ring-1 ring-amber-400/50 shadow-[0_0_10px_rgba(245,158,11,0.15)]",
  },
  unfiltered: {
    base: "bg-red-500/[0.15] border-red-500/35 text-red-300/90 shadow-[0_0_8px_rgba(239,68,68,0.08)]",
    active: "bg-red-500/30 border-red-300/90 text-white ring-1 ring-red-400/60 shadow-[0_0_14px_rgba(239,68,68,0.25)]",
  },
} as const;

/**
 * Mobile CORE decision Send button — Send → Sending… → ✓ Sent.
 *
 * One decision payload can be manually sent exactly once: after a successful
 * send (or while one is in flight) the button disables so rapid taps can
 * never produce duplicate platform sends. Delivery accounting remains the
 * single source of truth: `isDecisionPayloadSent` checks the sending
 * identity's own delivered history (shared with the desktop AutoForge HUD),
 * so the Sent state survives remounts and reflects desktop-sent payloads too.
 */
function DecisionSendButton({
  decisionKey,
  payload,
  botId,
  botSentMessages,
  sending,
  onSendingChange,
  onSent,
}: {
  decisionKey: string;
  payload: string;
  botId?: string;
  botSentMessages?: ReadonlyArray<{ message: string }>;
  sending: boolean;
  onSendingChange: (sending: boolean) => void;
  onSent?: (text: string) => void;
}) {
  const channel = useAppStore((s) => s.streamMetadata.channelName);
  const legacySentMessages = useAppStore((s) => s.sentMessages);
  const alreadySent = isDecisionPayloadSent(
    payload,
    botId ? (botSentMessages ?? []) : legacySentMessages,
  );

  const handleSend = async () => {
    const text = payload.trim();
    if (!text || !channel) return;
    // In-flight + already-delivered protection: UI-level enforcement on top
    // of sendManualMessage's own pending-send defense.
    if (sending || alreadySent) return;
    onSendingChange(true);
    try {
      await sendManualMessage({ message: text, channel, source: "manual", botId });
      toast.success("Decision sent to chat!");
      playSfx("send_message");
      onSent?.(text);
    } catch (e: any) {
      // Failed delivery — re-arm the button, never speak.
      toast.error(e.message || "Failed to send");
    } finally {
      onSendingChange(false);
    }
  };

  const disabled = alreadySent || sending;
  const label = sending ? "Sending…"
    : alreadySent ? "✓ Sent"
    : "Send";

  return (
    <div className="text-[10px] text-emerald-300 font-sans italic bg-emerald-500/10 p-1.5 rounded border border-emerald-500/20 flex items-center justify-between gap-2">
      <span className="line-clamp-2">"{payload}"</span>
      <button
        key={decisionKey}
        type="button"
        onClick={handleSend}
        disabled={disabled}
        title={disabled
          ? (alreadySent ? "This decision was already delivered" : "Sending…")
          : "Send this decision's message to chat (bypasses Dry Run)"}
        aria-label={
          sending ? "Sending decision message"
          : alreadySent ? "Decision message sent"
          : "Send decision message to chat"
        }
        className={cn(
          "shrink-0 px-2 py-1 rounded-md border transition-colors flex items-center gap-1 text-[10px] font-bold not-italic",
          disabled
            ? "bg-white/5 text-gray-500 border-white/10 opacity-70 cursor-not-allowed"
            : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/30",
        )}
      >
        {sending ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : alreadySent ? (
          <CheckCircle2 className="w-3 h-3" />
        ) : (
          <Send className="w-3 h-3" />
        )}
        <span>{label}</span>
      </button>
    </div>
  );
}

/**
 * Mobile Director — compact single-bot surface over the EXISTING director
 * notes system (no parallel "mobile thoughts" architecture). Up to 3 active
 * thoughts (MOBILE_DIRECTOR_NOTE_LIMIT, aligned with the PRIORITY 1–3
 * emphasis in formatDirectorNotesContext). "Until canceled" is the default
 * (and only) mobile duration; desktop keeps the richer duration options.
 * Notes are addable, dismissible, and reorderable (▲/▼ buttons — reliable
 * on touch). They flow into manual Forge AND AutoForge via
 * formatDirectorNotesContext / formatMemoryContext, with or without
 * AutoMemory enabled.
 */
function MobileDirectorPanel() {
  const directorNotes = useAppStore((s) => s.directorNotes);
  const addDirectorNoteMobile = useAppStore((s) => s.addDirectorNoteMobile);
  const removeDirectorNote = useAppStore((s) => s.removeDirectorNote);
  const reorderDirectorNotes = useAppStore((s) => s.reorderDirectorNotes);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");

  const now = Date.now();
  const activeNotes = directorNotes.filter((n) => n.expiresAt == null || n.expiresAt > now);
  const atLimit = activeNotes.length >= MOBILE_DIRECTOR_NOTE_LIMIT;

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const err = addDirectorNoteMobile(trimmed);
    if (err) {
      toast.error(err);
      playSfx("error");
      return;
    }
    setText("");
    playSfx("memory_add");
  };

  const move = (index: number, delta: -1 | 1) => {
    const ids = activeNotes.map((n) => n.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderDirectorNotes(ids);
  };

  return (
    <div>
      <div
        onClick={() => { setExpanded(!expanded); playSfx(expanded ? "hud_close" : "hud_open"); }}
        className="flex items-center justify-between text-xs cursor-pointer py-1 touch-target"
        role="button"
        aria-expanded={expanded}
        aria-label={`Director notes, ${activeNotes.length} of ${MOBILE_DIRECTOR_NOTE_LIMIT} active`}
      >
        <div className="flex flex-col min-w-0 pr-2">
          <span className="text-gray-300">Director · {activeNotes.length}/{MOBILE_DIRECTOR_NOTE_LIMIT}</span>
          <span className="text-[9px] text-gray-600 truncate">
            Private directives that steer Forge and AutoForge
          </span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-1 pb-2">
              {/* Add input — disabled at the 3-note limit */}
              <div className="flex gap-1.5">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
                  }}
                  disabled={atLimit}
                  maxLength={200}
                  placeholder={atLimit ? `Max ${MOBILE_DIRECTOR_NOTE_LIMIT} active thoughts` : "e.g. talk about the boss fight"}
                  className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-gray-200 placeholder:text-gray-600 outline-none focus:border-purple-500/40 disabled:opacity-50"
                  aria-label="New director note"
                />
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={atLimit || !text.trim()}
                  aria-label="Add director note"
                  className={cn(
                    "shrink-0 px-2.5 rounded-lg border text-[10px] font-bold transition-colors touch-target",
                    atLimit || !text.trim()
                      ? "bg-white/5 border-white/10 text-gray-600 cursor-not-allowed"
                      : "bg-purple-500/20 border-purple-500/40 text-purple-200 hover:bg-purple-500/30",
                  )}
                >
                  Add
                </button>
              </div>
              {atLimit && (
                <div className="text-[9px] text-amber-400/80">
                  Limit is {MOBILE_DIRECTOR_NOTE_LIMIT} active thoughts — remove or reorder one to add another.
                </div>
              )}
              {/* Active notes — order is priority (PRIORITY 1–3) */}
              {activeNotes.map((n, i) => (
                <DirectorNoteRow
                  key={n.id}
                  note={n}
                  index={i}
                  isFirst={i === 0}
                  isLast={i === activeNotes.length - 1}
                  onMoveUp={() => move(i, -1)}
                  onMoveDown={() => move(i, 1)}
                  onRemove={() => { removeDirectorNote(n.id); playSfx("memory_remove"); }}
                />
              ))}
              {activeNotes.length === 0 && (
                <div className="text-[9px] text-gray-600 italic">
                  No active thoughts. Directives persist until canceled and are never sent to chat.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One active mobile director thought: priority label, reorder, dismiss. */
function DirectorNoteRow({ note, index, isFirst, isLast, onMoveUp, onMoveDown, onRemove }: {
  note: { id: string; text: string };
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 bg-black/30 border border-white/5 rounded-lg px-2 py-1.5">
      <span className="text-[8px] font-mono font-bold text-purple-400 shrink-0">
        {index < 3 ? `P${index + 1}` : "STD"}
      </span>
      <span className="flex-1 min-w-0 text-[10px] text-gray-300 break-words">{note.text}</span>
      <div className="flex flex-col shrink-0">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          aria-label="Raise priority"
          className="text-gray-500 hover:text-white disabled:opacity-30 p-0.5"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          aria-label="Lower priority"
          className="text-gray-500 hover:text-white disabled:opacity-30 p-0.5"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove director note"
        className="shrink-0 text-gray-500 hover:text-red-400 p-0.5"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function MobileTuningTab(props: {
  readiness: ReturnType<typeof useCoreReadiness>;
  providerSummary: ReturnType<typeof getCoreProviderSummary>;
  activeUser: CoreMobileWorkspaceProps["activeUser"];
  activeLogin: () => void;
  activeLogout: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onboardingRequest: number;
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
  const r34lLearningFrozen = useAppStore((s) => s.r34lLearningFrozen);
  const setR34lLearningFrozen = useAppStore((s) => s.setR34lLearningFrozen);
  const sfxEnabled = useAppStore((s) => s.sfxEnabled);
  const setSfxEnabled = useAppStore((s) => s.setSfxEnabled);
  const ttsEnabled = useAppStore((s) => s.ttsEnabled);
  const setTtsEnabled = useAppStore((s) => s.setTtsEnabled);
  const smartRepliesEnabled = useAppStore((s) => s.smartRepliesEnabled);
  const setSmartRepliesEnabled = useAppStore((s) => s.setSmartRepliesEnabled);

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [providerSectionExpanded, setProviderSectionExpanded] = useState(() => {
    try { return sessionStorage.getItem("core-mobile-provider-collapsed") !== "1"; }
    catch { return true; }
  });
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const authTick = useAppStore((s) => s.authTick);
  const activeProvider = getActiveProvider();
  const keys = getKeys();

  useEffect(() => {
    try { sessionStorage.setItem("core-mobile-provider-collapsed", providerSectionExpanded ? "0" : "1"); }
    catch { /* private mode */ }
  }, [providerSectionExpanded]);

  useEffect(() => {
    if (props.onboardingRequest <= 0) return;
    setProviderSectionExpanded(true);
    try { sessionStorage.setItem("core-mobile-provider-collapsed", "0"); } catch { /* private mode */ }
  }, [props.onboardingRequest]);

  const toggleProviderSection = () => {
    if (providerSectionExpanded) {
      const collapsed = collapseMobileProviderDisclosure();
      setProviderSectionExpanded(collapsed.expanded);
      setExpandedProvider(collapsed.expandedProvider);
      setApiKeyInput(collapsed.apiKeyDraft);
    } else {
      setProviderSectionExpanded(true);
    }
    playSfx("panel_collapse");
  };

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
    <div ref={props.scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 space-y-3.5 font-sans pb-8">
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
        <button
          type="button"
          onClick={toggleProviderSection}
          aria-expanded={providerSectionExpanded}
          aria-label={`${providerSectionExpanded ? "Collapse" : "Expand"} AI Provider and Keys configuration`}
          className="w-full min-h-[44px] flex items-center justify-between gap-2 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
        >
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">AI Provider & Keys</span>
            </div>
            <div className="mt-0.5 pl-5 text-[10px] text-gray-500 font-mono truncate">
              {props.providerSummary.label}
              {props.providerSummary.model ? ` · ${props.providerSummary.model}` : ""}
              {` · ${props.providerSummary.configured ? "configured" : "not configured"}`}
            </div>
          </div>
          <span className="flex items-center gap-1.5 shrink-0">
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
            {providerSectionExpanded
              ? <ChevronUp className="w-4 h-4 text-cyan-400" />
              : <ChevronDown className="w-4 h-4 text-gray-500" />}
          </span>
        </button>

        {providerSectionExpanded && (
          <div className="space-y-3">
          <MobileFriendTrialCard />
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
        )}
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
          {/* Director — compact single-bot surface over the existing
              directorNotes system (max 3 active thoughts on mobile). */}
          <MobileDirectorPanel />

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

          {/* R34L Human Typing — true three-state control (tap cycle:
              OFF → FROZEN → ON → OFF). No modifier keys required on touch:
              gray = inactive (learned data preserved, not applied/updated),
              yellow ❄ = apply-only (frozen learning), green = applying + learning. */}
          <div className="flex items-center justify-between text-xs py-1 touch-target">
            <div className="flex flex-col min-w-0 pr-2">
              <span className="text-gray-300">R34L Human Typing Emulation</span>
              <span className="text-[9px] text-gray-600 truncate">
                {r34lLearningFrozen
                  ? "Apply-only: uses learned style, collects nothing new"
                  : r34lEnabled
                    ? "Applying learned style and learning live chat"
                    : "Inactive: learned style preserved, not applied or updated"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (r34lLearningFrozen) {
                  setR34lLearningFrozen(false);
                  toast.success("R34L ON — applying learned style and learning new evidence");
                } else if (r34lEnabled) {
                  setR34lEnabled(false);
                  toast.success("R34L OFF — learned style preserved, not applied or updated");
                } else {
                  setR34lLearningFrozen(true);
                  toast.success("R34L FROZEN — applying learned style, collecting nothing new");
                }
                playSfx("palette_select");
              }}
              aria-label={`R34L mode: ${r34lLearningFrozen ? "FROZEN (apply only)" : r34lEnabled ? "ON (learning)" : "OFF"}. Tap to cycle OFF, FROZEN, ON.`}
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 transition-colors touch-target",
                r34lLearningFrozen
                  ? "bg-yellow-500/20 border-yellow-500/40 text-yellow-300"
                  : r34lEnabled
                    ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                    : "bg-white/5 border-white/5 text-gray-500"
              )}
            >
              {r34lLearningFrozen ? "❄ FROZEN" : r34lEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <R34lInlineDetails showDesktopShortcutHint={false} />

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
            {(["minimal", "moderate", "heavy"] as const).map((lvl) => {
              const active = config.emoteDensity === lvl;
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => updateConfig({ emoteDensity: lvl })}
                  aria-pressed={active}
                  className={cn(
                    "relative py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-300/80",
                    active ? MOBILE_EMOTE_STYLE[lvl].active : MOBILE_EMOTE_STYLE[lvl].base,
                  )}
                >
                  {lvl}
                  {active && <span aria-hidden="true" className="absolute top-1 right-1 w-1 h-1 rounded-full bg-current" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Message Length */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-gray-400 font-bold">Message Length</span>
            {isAdaptiveLengthPreference(config.lengthPreference) && (
              <span className="text-[9px] uppercase font-mono font-bold tracking-wider text-cyan-300 bg-cyan-500/10 border border-cyan-500/25 rounded px-1.5 py-0.5">
                Adaptable
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(["short", "medium", "long"] as const).map((lvl: MobileLengthOption) => {
              const active = isMobileLengthOptionActive(config.lengthPreference, lvl);
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => updateConfig({ lengthPreference: toggleMobileLengthPreference(config.lengthPreference, lvl) })}
                  aria-pressed={active}
                  aria-label={`${lvl} message length${active ? "; tap again for adaptable length" : ""}`}
                  className={cn(
                    "relative py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/80",
                    active ? MOBILE_LENGTH_STYLE[lvl].active : MOBILE_LENGTH_STYLE[lvl].base,
                  )}
                >
                  {lvl}
                  {active && <span aria-hidden="true" className="absolute top-1 right-1 w-1 h-1 rounded-full bg-current" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Toxicity Filter */}
        <div className="space-y-1 pt-1 border-t border-white/5">
          <span className="text-[11px] text-gray-400 font-bold">Content Filter</span>
          <div className="grid grid-cols-3 gap-1">
            {(["family", "standard", "unfiltered"] as const).map((lvl) => {
              const active = config.toxicityFilter === lvl;
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => updateConfig({ toxicityFilter: lvl })}
                  aria-pressed={active}
                  className={cn(
                    "relative py-1.5 rounded-lg border text-[10px] font-bold uppercase transition-all touch-target focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                    active ? MOBILE_FILTER_STYLE[lvl].active : MOBILE_FILTER_STYLE[lvl].base,
                  )}
                >
                  {lvl}
                  {active && <span aria-hidden="true" className="absolute top-1 right-1 w-1 h-1 rounded-full bg-current" />}
                </button>
              );
            })}
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
          <MobileIntentRange
            min={0}
            max={1}
            step={0.05}
            value={autoForgeConfidenceThreshold}
            onValueChange={setAutoForgeConfidenceThreshold}
            className="mobile-slider-amber"
            ariaLabel="Confidence threshold"
          />
        </div>
      </div>

    </div>
  );
}
