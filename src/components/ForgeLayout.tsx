import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { PanelImperativeHandle } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { TheForge } from "./TheForge";
import { TuningDeck } from "./TuningDeck";
import { FidgetSpinner } from "./FidgetSpinner";
import { useAppStore } from "../store";
import { buttonVariants } from "./ui/button";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useTwitchAuth } from "../hooks/useTwitchAuth";
import { useKickAuth } from "../hooks/useKickAuth";
import { MultiBotPanel, MultiBotButton, MultiBotModeBadge } from "./MultiBotPanel";
import { useJoystickAuth } from "../hooks/useJoystickAuth";
import { useDeepgramTranscription } from "../hooks/useDeepgramTranscription";
import { ensureMicPermission } from "../hooks/usePushToTalk";
import { useAudioEnergy } from "../hooks/useAudioEnergy";
import { 
  Users, 
  Tv, 
  Volume2, 
  ChevronRight, 
  ChevronLeft,
  AudioLines,
  MessageSquare,
  Eye,
  Brain,
  LogIn,
  LogOut,
  User as UserIcon,
  AlertCircle,
  X,
  ExternalLink,
  Anchor,
  Camera,
  Zap,
  CirclePause,
  Pin,
  ChevronDown,
  Trash2,
  Star,
  Download,
  Upload,
  PanelLeftClose,
  Orbit,
  MessageCircle,
  Send,
  Sparkles,
  Search,
  Clock,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { motion, AnimatePresence } from "motion/react";
import { SENTIMENT_DOT_COLORS } from "../lib/sentiment";
import type { SentimentLabel } from "../types";
import { visionRequest } from "../lib/ai";
import { getActiveProvider } from "../lib/keys";
import { getPlatformSendFn } from "../lib/platformSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { playSfx } from "../lib/sfx";
import { computeFrameDelta, DELTA_THRESHOLD } from "../lib/frameDiff";
import { createMarker } from "../lib/chatUtils";
import { loadChannelEmotes, clearEmoteCache } from "../lib/emotes";
import { isNameMentioned } from "../lib/nameMatch";
import { getTwitchSession } from "../lib/twitch";
import { EmoteText } from "./EmoteText";
import { StreamOverlay } from "./StreamOverlay";
import { ActionTimeline } from "./ActionTimeline";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, ThemedTooltip } from "./ui/tooltip";
import logoUrl from "../../madchatter-logo1.png";
import twitchLogoUrl from "../../assets/twitch-logo.png";
import deffySigUrl from "/deffy-sig_whiteblack.png";

function DeffySigLogo() {
  const imgRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Glow ramps up as the mouse approaches within 200px; caps at 1.0
        const intensity = Math.max(0, Math.min(1, 1 - dist / 200));
        el.style.filter = `drop-shadow(0 0 ${4 + intensity * 14}px rgba(255,255,255,${0.15 + intensity * 0.55}))`;
        el.style.opacity = String(0.35 + intensity * 0.55);
      });
    };
    window.addEventListener("mousemove", onMove);
    return () => { window.removeEventListener("mousemove", onMove); cancelAnimationFrame(raf); };
  }, []);

  return (
    <a
      ref={imgRef}
      href="https://deffy.me"
      target="_blank"
      rel="noopener noreferrer"
      className="absolute bottom-2 right-2 z-30 transition-opacity duration-300 pointer-events-auto"
      style={{ filter: "drop-shadow(0 0 4px rgba(255,255,255,0.15))", opacity: 0.35 }}
      aria-label="Deffy — visit deffy.me"
    >
      <img
        src={deffySigUrl}
        alt="Deffy signature"
        className="h-7 w-auto select-none"
        draggable={false}
      />
    </a>
  );
}

function CollapseButtonPortal({ targetRef, onClick }: { targetRef: React.RefObject<HTMLDivElement | null>, onClick: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const posRef = useRef<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const node = targetRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const next = { left: rect.right, top: rect.top };
      const prev = posRef.current;
      if (!prev || prev.left !== next.left || prev.top !== next.top) {
        posRef.current = next;
        setPos(next);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (targetRef.current) ro.observe(targetRef.current);
    window.addEventListener("resize", update);
    const interval = setInterval(update, 200);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      clearInterval(interval);
    };
  }, [targetRef]);

  if (!pos) return null;

  return createPortal(
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <button
            {...props}
            type="button"
            onClick={onClick}
            style={{ position: "fixed", left: `${pos.left}px`, top: `${pos.top}px` }}
            className="z-[99999] h-11 w-4.5 rounded-lg rounded-t-none bg-emerald-500/20 hover:bg-emerald-500/40 border border-l-0 border-t-0 border-emerald-600/30 hover:border-emerald-300/40 text-emerald-300 hover:text-emerald-200 flex items-center justify-center transition-all focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none shadow-[4px_0_12px_rgba(0,0,0,0.4)]"
            aria-label="Collapse Context Rail (Ctrl+B)"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      />
      <TooltipContent side="right">Collapse · Ctrl+B</TooltipContent>
    </Tooltip>,
    document.body
  );
}

// --- Right sidebar size persistence -------------------------------------------
// Single source of truth for the right-panel localStorage key, default size,
// and stale keys to clean up. Bump RIGHT_SIZE_KEY_VERSION when changing the
// default so returning users get the new value instead of their old saved one.
const RIGHT_SIZE_KEY_VERSION = 6;
const RIGHT_SIZE_KEY = `forge-panel-right-size-v${RIGHT_SIZE_KEY_VERSION}`;
const RIGHT_SIZE_STALE_KEYS = [
  "forge-panel-right-size",
  "forge-panel-right-size-v2",
  "forge-panel-right-size-v3",
  "forge-panel-right-size-v4",
  "forge-panel-right-size-v5",
].filter((k) => k !== RIGHT_SIZE_KEY);

const isFHDViewport = () =>
  typeof window !== "undefined" && Math.round(window.innerWidth) === 1920;

const getRightSizeDefault = () => (isFHDViewport() ? 43.125 : 21.6);

export function ForgeLayout() {
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<"context" | "forge" | "tuning">("forge");
  const {
    streamMetadata,
    updateStreamMetadata,
    setVisualSnapshot,
    visualSnapshotUrl,
    visualContextTags,
    visualSnapshotHistory,
    setVisualHistoryOpen,
    config,
    updateConfig,
    isForging,
    variants,
    setVariants,
    audioTranscript,
    setAudioTranscript,
    appendAudioTranscript,
    chatLog,
    longTermMemory,
    pinnedMemories,
    addPinnedMemory,
    removePinnedMemory,
    clearPinnedMemories,
    goldenMemoryId,
    setGoldenMemory,
    clearAllContext,
    theme,
    setStreamCaptureActive,
    sentMessages,
    bots,
    appendChatLog,
    messageSoundEnabled,
    chatSearchQuery,
    setChatSearchQuery,
    smartReplies,
    setSmartReplies,
    smartRepliesLoading,
    isAutoForgeThinking,
    sentimentHistory,
    addSentMessage,
    incrementMessagesSent,
    addAutoForgeEvent,
    setLastManualSendMs,
    addBotSentMessage,
    incrementBotStat,
    addBotAutoForgeEvent,
  } = useAppStore();

  const {
    user,
    loading: authLoading,
    loginError,
    loginInProgress,
    login,
    logout,
    loginWithDevToken,
    clearLoginError,
  } = useTwitchAuth();

  const kickAuth = useKickAuth();
  const joystickAuth = useJoystickAuth();

  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);

  // Active auth based on platform
  const activeAuth = platform === 'kick' ? kickAuth : platform === 'joystick' ? joystickAuth : { user, loading: authLoading, loginError, loginInProgress, login, logout, loginWithDevToken, clearLoginError };
  const activeUser = activeAuth.user;
  const activeAuthLoading = activeAuth.loading;
  const activeLoginError = activeAuth.loginError;
  const activeLoginInProgress = activeAuth.loginInProgress;
  const activeLogin = activeAuth.login;
  const activeLogout = activeAuth.logout;
  const activeLoginWithDevToken = activeAuth.loginWithDevToken;
  const activeClearLoginError = activeAuth.clearLoginError;

  // Panels Size States (remembered in localStorage)
  const [leftPanelSize, setLeftPanelSize] = useState(() => {
    const saved = localStorage.getItem("forge-panel-left-expanded-size");
    const parsed = saved ? parseFloat(saved) : 18;
    return isNaN(parsed) || parsed <= 0 || parsed >= 100 ? 18 : parsed;
  });
  const [leftCollapsedSize, setLeftCollapsedSize] = useState(() => {
    const saved = localStorage.getItem("forge-panel-left-collapsed-size");
    const parsed = saved ? parseFloat(saved) : 3;
    return isNaN(parsed) || parsed < 2 || parsed > 8 ? 3 : parsed;
  });
  const [rightSize, setRightSize] = useState(() => {
    const saved = localStorage.getItem(RIGHT_SIZE_KEY);
    const defaultSize = getRightSizeDefault();
    const parsed = saved ? parseFloat(saved) : defaultSize;
    return isNaN(parsed) || parsed <= 0 || parsed >= 100 ? defaultSize : parsed;
  });

  useEffect(() => {
    // Clean up stale right-size keys and ensure the current default is stored
    RIGHT_SIZE_STALE_KEYS.forEach((k) => localStorage.removeItem(k));
    if (!localStorage.getItem(RIGHT_SIZE_KEY)) {
      localStorage.setItem(RIGHT_SIZE_KEY, getRightSizeDefault().toString());
    }
  }, []);

  // Collapsible states
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    return localStorage.getItem("forge-panel-left-collapsed") === "true";
  });

  // Chat anchor (auto-scroll to bottom) — default on
  const [chatAnchored, setChatAnchored] = useState(() => {
    return localStorage.getItem("forge-chat-anchored") !== "false";
  });
  const expandedChatRef = useRef<HTMLDivElement>(null);
  const flyoutChatRef = useRef<HTMLDivElement>(null);

  // Audio anchor (auto-scroll to bottom) — default on
  const [audioAnchored, setAudioAnchored] = useState(() => {
    return localStorage.getItem("forge-audio-anchored") !== "false";
  });
  const expandedAudioRef = useRef<HTMLDivElement>(null);
  const flyoutAudioRef = useRef<HTMLDivElement>(null);
  const [audioPanelHeight, setAudioPanelHeight] = useState(() => {
    const saved = localStorage.getItem("forge-audio-panel-height");
    const parsed = saved ? parseFloat(saved) : 180;
    return isNaN(parsed) || parsed < 80 ? 180 : parsed;
  });
  const audioResizeRef = useRef<{ startY: number; startH: number } | null>(null);

  // Chat panel height (resizable in expanded mode)
  const [chatPanelHeight, setChatPanelHeight] = useState(() => {
    const saved = localStorage.getItem("forge-chat-panel-height");
    const parsed = saved ? parseFloat(saved) : 500;
    return isNaN(parsed) || parsed < 80 ? 500 : parsed;
  });
  const chatResizeRef = useRef<{ startY: number; startH: number } | null>(null);

  // Visual snapshot auto-capture
  const [visualAutoCapture, setVisualAutoCapture] = useState(() => {
    return localStorage.getItem("forge-visual-auto") !== "false";
  });
  const [visualCaptureInterval, setVisualCaptureInterval] = useState(() => {
    const saved = localStorage.getItem("forge-visual-interval");
    const parsed = saved ? parseFloat(saved) : 10;
    return isNaN(parsed) || parsed < 2 || parsed > 120 ? 10 : parsed;
  });
  const [visualCooldown, setVisualCooldown] = useState(false);
  const visualCooldownRef = useRef<number | null>(null);
  const handleManualCaptureRef = useRef<(forceStreamCrop?: boolean) => void>(() => {});
  const [windowSelected, setWindowSelected] = useState(false);
  const cachedStreamRef = useRef<MediaStream | null>(null);
  const captureVideoRef = useRef<HTMLVideoElement | null>(null);
  const prevFrameDataRef = useRef<ImageData | null>(null);
  const prevVisualContextRef = useRef<string | null>(null);
  const [visualFlashRed, setVisualFlashRed] = useState(false);
  const visualFlashRef = useRef<number | null>(null);
  const [visualAutoFlash, setVisualAutoFlash] = useState(false);
  const visualAutoFlashRef = useRef<number | null>(null);
  const [visualManualFlash, setVisualManualFlash] = useState(false);
  const visualManualFlashRef = useRef<number | null>(null);
  const [visualCountdown, setVisualCountdown] = useState(0);
  const [tabCaptureMode, setTabCaptureMode] = useState(false);
  const tabCaptureModeRef = useRef(false);
  // Stores the display surface type ("monitor" | "window" | "browser") from the
  // capture track settings. Used to adjust crop coordinates — monitor and window
  // captures include the browser chrome (search bar, tabs) in the video frame,
  // so viewport-relative coordinates need an offset to map correctly.
  const captureSurfaceTypeRef = useRef<string>("window");
  // Smart capture — AI dynamically adjusts interval based on scene change rate
  // Levels: 0=Off, 1=Light, 2=Balanced, 3=Aggressive
  const SMART_LEVELS = [
    { name: 'Off', color: 'gray', highDelta: 0, midDelta: 0, lowDelta: 0, fastMult: 1, midMult: 1, slowMult: 1, minInt: 10, maxInt: 120, desc: 'Smart capture is disabled. Auto-capture uses the fixed interval you set.' },
    { name: 'Light', color: 'cyan', highDelta: 0.20, midDelta: 0.08, lowDelta: 0.01, fastMult: 0.7, midMult: 0.85, slowMult: 1.3, minInt: 5, maxInt: 90, desc: 'Gentle adjustments. Captures slightly faster during action, slightly slower when idle. Best for steady streams with occasional peaks.' },
    { name: 'Balanced', color: 'blue', highDelta: 0.15, midDelta: 0.05, lowDelta: 0.01, fastMult: 0.5, midMult: 0.75, slowMult: 1.5, minInt: 3, maxInt: 60, desc: 'Moderate responsiveness. Halves interval during high activity, 1.5× slower when static. Good default for most streams.' },
    { name: 'Aggressive', color: 'violet', highDelta: 0.08, midDelta: 0.03, lowDelta: 0.005, fastMult: 0.35, midMult: 0.6, slowMult: 2.0, minInt: 2, maxInt: 45, desc: 'Maximum reactivity. Captures every 2s during action, slows to 45s when nothing moves. Best for fast-paced games with frequent scene changes.' },
  ] as const;
  const [smartLevel, setSmartLevel] = useState(() => {
    const saved = localStorage.getItem("forge-visual-smart");
    const parsed = saved ? parseInt(saved) : 0;
    return isNaN(parsed) || parsed < 0 || parsed > 3 ? 0 : parsed;
  });
  const smartCapture = smartLevel > 0;
  useEffect(() => {
    localStorage.setItem("forge-visual-smart", smartLevel.toString());
  }, [smartLevel]);
  const cycleSmartLevel = () => setSmartLevel((prev) => (prev + 1) % 4);

  // When Smart mode is activated, auto-enable auto-capture
  useEffect(() => {
    if (smartCapture && !visualAutoCapture) {
      setVisualAutoCapture(true);
    }
  }, [smartCapture]);
  const [isMicCapturing, setIsMicCapturing] = useState(false);
  const [visualContextExpanded, setVisualContextExpanded] = useState(false);
  const [micStreamForEnergy, setMicStreamForEnergy] = useState<MediaStream | null>(null);
  useAudioEnergy(micStreamForEnergy);

  useEffect(() => {
    localStorage.setItem("forge-visual-auto", visualAutoCapture.toString());
  }, [visualAutoCapture]);

  useEffect(() => {
    localStorage.setItem("forge-visual-interval", visualCaptureInterval.toString());
  }, [visualCaptureInterval]);

  useEffect(() => {
    if (!visualAutoCapture || !windowSelected) return;
    setVisualCountdown(visualCaptureInterval);
    const tickId = setInterval(() => {
      setVisualCountdown((prev) => (prev <= 1 ? visualCaptureInterval : prev - 1));
    }, 1000);
    const id = setInterval(() => {
      handleCaptureWindow();
      setVisualCountdown(visualCaptureInterval);
    }, visualCaptureInterval * 1000);
    return () => { clearInterval(tickId); clearInterval(id); };
  }, [visualAutoCapture, visualCaptureInterval, windowSelected]);

  const handleManualCapture = (forceStreamCrop = false) => {
    if (visualCooldown) return;
    if (!windowSelected) {
      setVisualFlashRed(true);
      if (visualFlashRef.current) clearTimeout(visualFlashRef.current);
      visualFlashRef.current = window.setTimeout(() => {
        setVisualFlashRed(false);
      }, 1500);
      toast.error("Start capture first using the Capture button.");
      return;
    }
    handleCaptureWindow(true, forceStreamCrop);
    setVisualCooldown(true);
    if (visualCooldownRef.current) clearTimeout(visualCooldownRef.current);
    visualCooldownRef.current = window.setTimeout(() => {
      setVisualCooldown(false);
    }, 5000);
  };
  handleManualCaptureRef.current = handleManualCapture;

  useEffect(() => {
    localStorage.setItem("forge-chat-anchored", chatAnchored.toString());
  }, [chatAnchored]);

  useEffect(() => {
    localStorage.setItem("forge-audio-anchored", audioAnchored.toString());
  }, [audioAnchored]);

  useEffect(() => {
    localStorage.setItem("forge-audio-panel-height", audioPanelHeight.toString());
  }, [audioPanelHeight]);

  useEffect(() => {
    localStorage.setItem("forge-chat-panel-height", chatPanelHeight.toString());
  }, [chatPanelHeight]);

  useEffect(() => {
    if (!audioAnchored) return;
    if (expandedAudioRef.current) {
      expandedAudioRef.current.scrollTop = expandedAudioRef.current.scrollHeight;
    }
    if (flyoutAudioRef.current) {
      flyoutAudioRef.current.scrollTop = flyoutAudioRef.current.scrollHeight;
    }
  }, [audioTranscript, audioAnchored, leftCollapsed]);

  useEffect(() => {
    if (!chatAnchored) return;
    if (expandedChatRef.current) {
      const scrollEl = expandedChatRef.current.querySelector('.forge-scroll') as HTMLElement | null;
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }
    if (flyoutChatRef.current) {
      const scrollEl = flyoutChatRef.current.querySelector('.forge-scroll') as HTMLElement | null;
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }, [chatLog, chatAnchored, leftCollapsed]);


  const panelDragActiveRef = useRef(false);
  const lastLeftResizeRef = useRef<number | null>(null);

  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const leftRailDomRef = useRef<HTMLDivElement>(null);
  type WidgetType = "audio" | "chat" | "visual" | "memory" | "stream";
  const [openWidgets, setOpenWidgets] = useState<Set<WidgetType>>(new Set());
  const [closingWidgets, setClosingWidgets] = useState<Set<WidgetType>>(new Set());
  const [widgetPositions, setWidgetPositions] = useState<Record<string, { top: number; left: number }>>({});
  const [draggingWidget, setDraggingWidget] = useState<WidgetType | null>(null);

  const streamCaptureWarningId = "stream-capture-warning-toast";
  useEffect(() => {
    setStreamCaptureActive(windowSelected);
  }, [windowSelected, setStreamCaptureActive]);

  useEffect(() => {
    const streamOpen = openWidgets.has("stream");
    if (tabCaptureMode && windowSelected && !streamOpen) {
      toast.warning(
        "Stream Embed is closed while same-tab capturing! Visual frames may be wrong — open the Stream Embed widget to ensure proper crop alignment.",
        { id: streamCaptureWarningId, duration: Infinity }
      );
    } else {
      toast.dismiss(streamCaptureWarningId);
    }
  }, [tabCaptureMode, windowSelected, openWidgets]);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const iconBarRef = useRef<HTMLDivElement>(null);
  const [streamOverlaySize, setStreamOverlaySize] = useState(() => {
    const saved = localStorage.getItem("forge-stream-overlay-size");
    if (saved) { try { const p = JSON.parse(saved); if (p.w && p.h) return { w: p.w, h: p.h }; } catch {} }
    return { w: 480, h: 270 };
  });
  const [streamChatActive, setStreamChatActive] = useState(false);
  const [sidebarChatOpen, setSidebarChatOpen] = useState(false);
  const [sidebarChatMsg, setSidebarChatMsg] = useState("");
  const [sidebarChatSending, setSidebarChatSending] = useState(false);

  // Icon reorder state (persisted)
  const [iconOrder, setIconOrder] = useState<WidgetType[]>(() => {
    const saved = localStorage.getItem("forge-icon-order");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 5 &&
            ["audio", "chat", "visual", "memory", "stream"].every((w) => parsed.includes(w))) {
          return parsed as WidgetType[];
        }
      } catch { /* ignore */ }
    }
    return ["stream", "audio", "chat", "memory", "visual"];
  });
  const [draggingIcon, setDraggingIcon] = useState<WidgetType | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [memoryClearConfirm, setMemoryClearConfirm] = useState(false);
  const [multiBotPanelOpen, setMultiBotPanelOpen] = useState(false);
  const memoryClearTimerRef = useRef<number | null>(null);
  const iconRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const iconDragStartRef = useRef<{ x: number; y: number; widget: WidgetType } | null>(null);
  const iconDragActiveRef = useRef(false);
  const iconJustDraggedRef = useRef(false);
  const dragOverIndexRef = useRef<number | null>(null);

  // Voice capture state via custom Deepgram hook
  const { voiceEnabled, isConnecting, error: voiceError, voiceMode, whisperPrompt, whisperDownloading, startEmbedCapture, startEmbedWhisper, confirmWhisperDownload, cancelWhisperDownload, stopDeepgram } = useDeepgramTranscription();
  const isVoiceCapturing = voiceEnabled || isConnecting;

  useEffect(() => {
    if (voiceError) {
      toast.error(voiceError);
    }
  }, [voiceError]);

  // Chat activity tracking (last 30 seconds)
  const chatMsgTimesRef = useRef<number[]>([]);
  const prevChatLineCountRef = useRef(0);
  const logoClickTimesRef = useRef<number[]>([]);
  const [chatActivity, setChatActivity] = useState(0); // 0=dead, 1=slow, 2=moderate, 3=active, 4=poppin

  // Unread chat message count (since chat widget was last opened)
  const [chatUnreadCount, setChatUnreadCount] = useState(0);

  useEffect(() => {
    const lineCount = chatLog.length;
    if (lineCount > prevChatLineCountRef.current) {
      const newMsgs = lineCount - prevChatLineCountRef.current;
      const now = Date.now();
      for (let i = 0; i < newMsgs; i++) {
        chatMsgTimesRef.current.push(now);
      }
      // Increment unread count when chat widget is not open
      if (!openWidgets.has("chat")) {
        setChatUnreadCount((prev) => prev + newMsgs);
      }
    }
    prevChatLineCountRef.current = lineCount;
  }, [chatLog, openWidgets]);

  // Insert colored marker into chat log when a message is sent from Forge or AutoForge
  const prevSentCountRef = useRef(0);
  useEffect(() => {
    if (sentMessages.length > prevSentCountRef.current) {
      const lastSent = sentMessages[sentMessages.length - 1];
      if (lastSent.source === "manual") {
        appendChatLog(createMarker("manual"));
      } else if (lastSent.source === "autoforge" || lastSent.source === "followup") {
        appendChatLog(createMarker("autoforge"));
      }
    }
    prevSentCountRef.current = sentMessages.length;
  }, [sentMessages, appendChatLog]);

  // Multi-bot: insert a colored marker into the chat log when ANY bot's own
  // runtime.sentMessages grows (per-bot manual ChatSender sends + per-bot
  // AutoForge sends). Per-bot sends are recorded against bots[i].runtime, not
  // the global sentMessages, so without this the Chat Pulse line never appears
  // for multi-bot activity.
  const prevBotSentCountsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    let appended = false;
    for (const bot of bots) {
      const prev = prevBotSentCountsRef.current[bot.id] ?? 0;
      const cur = bot.runtime.sentMessages.length;
      if (cur > prev) {
        const lastSent = bot.runtime.sentMessages[cur - 1];
        if (lastSent?.source === "manual") {
          appendChatLog(createMarker("manual"));
          appended = true;
        } else if (lastSent?.source === "autoforge" || lastSent?.source === "followup") {
          appendChatLog(createMarker("autoforge"));
          appended = true;
        }
      }
      prevBotSentCountsRef.current[bot.id] = cur;
    }
    // Bumping chat activity so the pulse ring fires for our own sends too.
    if (appended) {
      chatMsgTimesRef.current.push(Date.now());
    }
  }, [bots, appendChatLog]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const cutoff = now - 30000;
      chatMsgTimesRef.current = chatMsgTimesRef.current.filter((t) => t > cutoff);
      const count = chatMsgTimesRef.current.length;
      let level = 0;
      if (count >= 20) level = 4;
      else if (count >= 10) level = 3;
      else if (count >= 5) level = 2;
      else if (count >= 1) level = 1;
      setChatActivity(level);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Dispatch chat activity level to AnimatedBackground
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('bg-chat-activity', { detail: { level: chatActivity } }));
  }, [chatActivity]);

  // Inline channel name editing
  const [editingChannel, setEditingChannel] = useState(false);
  const [channelInput, setChannelInput] = useState("");
  const channelInputRef = useRef<HTMLInputElement>(null);
  const [offlineTitle, setOfflineTitle] = useState("BRB... touching grass 🌱");

  useEffect(() => {
    if (!streamMetadata?.channelName) {
      const titles = [
        "BRB... touching grass 🌱",
        "Stream went to get snacks 🍿",
        "Raid shadow legends irl 🏰",
        "Currently arguing with a wall 🧱",
        "Gone fishing... for viewers 🎣",
        "Stream is charging its social battery 🔋",
        "Taking a mental health pixel break 🎮",
        "Stream got distracted by a butterfly 🦋",
        "AFK — Away From Keyboard (and sanity) ⌨️",
        "Stream is vibing in the void 🕳️",
        "Plotting world domination... slowly 🌍",
        "Stream caught a case of the Mondays 😵",
        "Currently being a NPC in real life 🤖",
        "Stream is loading... please wait ⏳",
        "Gone to find the missing sock 🧦",
      ];
      setOfflineTitle(titles[Math.floor(Math.random() * titles.length)]);
    }
  }, [streamMetadata?.channelName]);

  // Load 7TV + FrankerFaceZ + BTTV emotes for the current channel
  useEffect(() => {
    const channel = streamMetadata?.channelName;
    if (!channel) return;
    let cancelled = false;
    const state = useAppStore.getState();
    const twitchUserId = getTwitchSession()?.userId || undefined;
    loadChannelEmotes(channel, {
      providers: state.emoteProviders,
      twitchUserId,
    }).then(() => {
      if (cancelled) return;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [streamMetadata?.channelName]);

  useEffect(() => {
    if (editingChannel && channelInputRef.current) {
      channelInputRef.current.focus();
      channelInputRef.current.select();
    }
  }, [editingChannel]);

  // Send a smart reply and record it in the sent log / stats so anti-repetition
  // and analytics see it (previously smart replies were sent but not tracked).
  const sendSmartReply = async (text: string) => {
    const channel = streamMetadata?.channelName;
    if (!channel) return;
    const state = useAppStore.getState();
    // Default to the first active authenticated bot in multi-bot mode.
    // The header SendAsPicker was removed; the ChatSender dropdown in the
    // MultiBotPanel still sets manualSendBotId for the direct-send path.
    const fallbackBotId = state.multiBotEnabled
      ? (state.bots.find((b) => b.active && b.session)?.id ?? state.manualSendBotId ?? undefined)
      : state.manualSendBotId ?? undefined;
    const selectedBotId = fallbackBotId;
    const sendFn = getPlatformSendFn(state.platform, selectedBotId);
    try {
      await sendFn(channel, text);
      state.setLastManualSendMs(Date.now());
      if (state.messageSoundEnabled) playMessageSound();
      const sentBot = selectedBotId ? state.bots.find((b) => b.id === selectedBotId) : null;
      if (state.multiBotEnabled && sentBot) {
        state.addBotSentMessage(sentBot.id, {
          message: text,
          channel,
          timestamp: Date.now(),
          source: "manual",
          botId: sentBot.id,
        });
        state.incrementBotStat(sentBot.id, "messagesSent");
        state.addBotAutoForgeEvent(sentBot.id, {
          timestamp: Date.now(),
          type: "action_sent",
          severity: "high",
          summary: `Smart reply as @${sentBot.session?.username}: "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`,
          details: { source: "smart_reply", message: text, channel, botId: sentBot.id },
        });
      } else {
        addSentMessage({ message: text, channel, timestamp: Date.now(), source: "manual" });
        incrementMessagesSent();
        useAppStore.getState().incrementStat("manualActions");
        addAutoForgeEvent({
          timestamp: Date.now(),
          type: "action_sent",
          severity: "high",
          summary: `Smart reply: "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`,
          details: { source: "smart_reply", message: text, channel },
        });
      }
      toast.success("Reply sent!");
      playSfx('send_message');
    } catch (e: any) {
      toast.error(e.message || "Failed to send reply");
      playSfx('error');
    }
    setSmartReplies([]);
  };

  // Smart reply keyboard shortcuts (1/2/3 to send)
  useEffect(() => {
    if (smartReplies.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < smartReplies.length) {
        e.preventDefault();
        sendSmartReply(smartReplies[idx].text);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [smartReplies, streamMetadata?.channelName, platform]);

  const startEditingChannel = () => {
    setChannelInput(streamMetadata?.channelName || "");
    setEditingChannel(true);
  };

  const commitChannel = () => {
    const trimmed = channelInput.trim().replace(/^@/, "");
    if (trimmed) {
      const currentName = streamMetadata?.channelName || "";
      if (trimmed.toLowerCase() !== currentName.toLowerCase()) {
        clearAllContext();
        setVariants([]);
      }
      updateStreamMetadata({ channelName: trimmed });
    }
    setEditingChannel(false);
  };

  // Collapsed panel width tracking for icon scaling
  const [collapsedWidth, setCollapsedWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1200
  );
  const collapsedWidthRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onWinResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  useEffect(() => {
    if (!collapsedWidthRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCollapsedWidth(entry.contentRect.width);
      }
    });
    observer.observe(collapsedWidthRef.current);
    return () => observer.disconnect();
  }, [leftCollapsed]);

  // Base collapsed width is ~3% of viewport. Icons scale from 1x up to 4.5x.
  const COLLAPSED_BASE_PX = viewportWidth * 0.03;
  const iconScale = Math.min(4.5, Math.max(1, collapsedWidth / COLLAPSED_BASE_PX));

  // FHD-tuned default widget flyout sizes
  const widgetDefaultSizes: Record<WidgetType, { w: number; h: number }> = {
    audio: { w: 400, h: 480 },
    chat: { w: 420, h: 520 },
    visual: { w: 480, h: 400 },
    memory: { w: 380, h: 440 },
    stream: { w: 480, h: 360 },
  };

  const handleSidebarChatSend = async () => {
    const msg = sidebarChatMsg.trim();
    const channel = streamMetadata?.channelName;
    if (!msg || !channel || sidebarChatSending) return;
    setSidebarChatSending(true);
    try {
      const sendFn = getPlatformSendFn(platform);
      await sendFn(channel, msg);
      if (messageSoundEnabled && platform === 'joystick') playMessageSound();
      speakMessage(msg);
      setSidebarChatMsg("");
      toast.success("Message sent to chat!");
    } catch (e: any) {
      toast.error("Failed to send message", { description: e?.message || String(e) });
    } finally {
      setSidebarChatSending(false);
    }
  };

  const toggleWidget = (w: WidgetType) => {
    setOpenWidgets((prev) => {
      const next = new Set(prev);
      if (next.has(w)) {
        next.delete(w);
        setClosingWidgets((c) => new Set(c).add(w));
        setTimeout(() => {
          setClosingWidgets((c) => {
            const nc = new Set(c);
            nc.delete(w);
            return nc;
          });
        }, 200);
      } else {
        next.add(w);
        if (w === "chat") setChatUnreadCount(0);
        if (!widgetPositions[w]) {
          const iconRect = iconRefs.current[w]?.getBoundingClientRect();
          const iconBarRect = iconBarRef.current?.getBoundingClientRect();
          const baseLeft = iconBarRect ? iconBarRect.right + 8 : 100;
          const baseTop = iconRect ? iconRect.top : (iconBarRect ? iconBarRect.top : 100);
          // Clamp to viewport so flyouts don't start off-screen at FHD
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const def = widgetDefaultSizes[w];
          const isStream = w === "stream";
          const streamChatBoost = isStream && streamChatActive ? (platform === 'kick' || platform === 'joystick' ? 44 : 138) : 0;
          const streamW = streamOverlaySize.w;
          const streamH = streamOverlaySize.h + 40 + streamChatBoost;
          const clampW = isStream ? streamW : def.w;
          const clampH = isStream ? streamH : def.h;
          const clampedLeft = Math.min(baseLeft, vw - clampW - 16);
          const clampedTop = Math.min(baseTop, vh - clampH - 16);
          setWidgetPositions((p) => ({
            ...p,
            [w]: { top: Math.max(8, clampedTop), left: Math.max(8, clampedLeft) },
          }));
        }
      }
      return next;
    });
  };

  const handleClearMemories = () => {
    if (memoryClearConfirm) {
      clearPinnedMemories();
      setMemoryClearConfirm(false);
      if (memoryClearTimerRef.current) {
        clearTimeout(memoryClearTimerRef.current);
        memoryClearTimerRef.current = null;
      }
      toast.success("All memories cleared");
    } else {
      setMemoryClearConfirm(true);
      toast.warning("Click Clear again to confirm — this will erase all memories");
      if (memoryClearTimerRef.current) {
        clearTimeout(memoryClearTimerRef.current);
      }
      memoryClearTimerRef.current = window.setTimeout(() => {
        setMemoryClearConfirm(false);
        memoryClearTimerRef.current = null;
      }, 4000);
    }
  };

  const handleExportMemories = () => {
    if (pinnedMemories.length === 0) {
      toast.error("No memories to export");
      return;
    }
    const data = {
      exportedAt: new Date().toISOString(),
      memories: pinnedMemories,
      goldenMemoryId,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `madchatter-memories-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${pinnedMemories.length} memories`);
  };

  const handleImportMemories = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data.memories || !Array.isArray(data.memories)) {
          toast.error("Invalid memory file format");
          return;
        }
        const valid = data.memories.filter((m: any) => m.type && m.label && m.timestamp);
        if (valid.length === 0) {
          toast.error("No valid memories found in file");
          return;
        }
        valid.forEach((m: any) => {
          addPinnedMemory({ type: m.type, label: m.label, content: m.content || "", timestamp: m.timestamp, imageUrl: m.imageUrl });
        });
        if (data.goldenMemoryId) {
          setGoldenMemory(data.goldenMemoryId);
        }
        toast.success(`Imported ${valid.length} memories`);
      } catch {
        toast.error("Failed to parse memory file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // --- Icon reorder drag handlers ---
  const setDragOverIndexBoth = (idx: number | null) => {
    dragOverIndexRef.current = idx;
    setDragOverIndex(idx);
  };

  const computeDropTarget = (clientY: number) => {
    for (let i = 0; i < iconOrder.length; i++) {
      const el = iconRefs.current[iconOrder[i]];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (clientY < midpoint) {
        setDragOverIndexBoth(i);
        return;
      }
    }
    setDragOverIndexBoth(iconOrder.length);
  };

  const onIconMouseDown = (e: React.MouseEvent, widget: WidgetType) => {
    if (e.button !== 0) return;
    iconDragStartRef.current = { x: e.clientX, y: e.clientY, widget };
    iconDragActiveRef.current = false;

    const onMove = (ev: MouseEvent) => {
      if (!iconDragStartRef.current) return;
      if (!iconDragActiveRef.current) {
        const dx = ev.clientX - iconDragStartRef.current.x;
        const dy = ev.clientY - iconDragStartRef.current.y;
        if (Math.sqrt(dx * dx + dy * dy) > 5) {
          iconDragActiveRef.current = true;
          setDraggingIcon(iconDragStartRef.current.widget);
        }
      }
      if (iconDragActiveRef.current) {
        computeDropTarget(ev.clientY);
      }
    };

    const onUp = () => {
      if (iconDragActiveRef.current && iconDragStartRef.current) {
        iconJustDraggedRef.current = true;
        const fromWidget = iconDragStartRef.current.widget;
        const fromIndex = iconOrder.indexOf(fromWidget);
        const toIndex = dragOverIndexRef.current;
        if (toIndex !== null && toIndex !== fromIndex && toIndex !== fromIndex + 1) {
          const newOrder = [...iconOrder];
          newOrder.splice(fromIndex, 1);
          const insertPos = toIndex > fromIndex ? toIndex - 1 : toIndex;
          newOrder.splice(insertPos, 0, fromWidget);
          setIconOrder(newOrder);
          localStorage.setItem("forge-icon-order", JSON.stringify(newOrder));
        }
      }
      iconDragStartRef.current = null;
      iconDragActiveRef.current = false;
      setDraggingIcon(null);
      setDragOverIndexBoth(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onIconClick = (widget: WidgetType) => {
    if (iconJustDraggedRef.current) {
      iconJustDraggedRef.current = false;
      return;
    }
    toggleWidget(widget);
  };

  const startAudioResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    audioResizeRef.current = { startY: e.clientY, startH: audioPanelHeight };
    const onMove = (ev: MouseEvent) => {
      if (!audioResizeRef.current) return;
      const delta = ev.clientY - audioResizeRef.current.startY;
      const maxH = Math.round(window.innerHeight * 0.7);
      const newH = Math.max(80, Math.min(maxH, audioResizeRef.current.startH + delta));
      setAudioPanelHeight(newH);
    };
    const onUp = () => {
      audioResizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startChatResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    chatResizeRef.current = { startY: e.clientY, startH: chatPanelHeight };
    const onMove = (ev: MouseEvent) => {
      if (!chatResizeRef.current) return;
      const delta = ev.clientY - chatResizeRef.current.startY;
      const maxH = Math.round(window.innerHeight * 0.7);
      const newH = Math.max(80, Math.min(maxH, chatResizeRef.current.startH + delta));
      setChatPanelHeight(newH);
    };
    const onUp = () => {
      chatResizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startDrag = (e: React.MouseEvent, widget: WidgetType) => {
    e.preventDefault();
    const panel = (e.currentTarget as HTMLElement).closest('[data-widget-panel]') as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDraggingWidget(widget);
  };

  const togglePanel = () => {
    setOpenWidgets(new Set());
    setLeftCollapsed(!leftCollapsed);
    playSfx(leftCollapsed ? 'panel_expand' : 'panel_collapse');
  };

  // Reset Layout to FHD Defaults — clears all spatial localStorage keys and reloads
  const resetFHDDefaults = () => {
    const keysToRemove = [
      "forge-panel-left-expanded-size",
      "forge-panel-left-collapsed-size",
      "forge-panel-left-collapsed",
      ...RIGHT_SIZE_STALE_KEYS,
      RIGHT_SIZE_KEY,
      "forge-chat-anchored",
      "forge-audio-anchored",
      "forge-audio-panel-height",
      "forge-chat-panel-height",
      "forge-icon-order",
      "forge-visual-auto",
      "forge-visual-interval",
      "forge-visual-smart",
      "forge-stream-overlay-size",
    ];
    keysToRemove.forEach((k) => localStorage.removeItem(k));
    toast.success("Layout reset to FHD defaults — reloading...");
    setTimeout(() => window.location.reload(), 600);
  };

  // Drag effect — track mouse movement while dragging a widget (with viewport clamping)
  useEffect(() => {
    if (!draggingWidget) return;
    const onMove = (e: MouseEvent) => {
      const def = widgetDefaultSizes[draggingWidget];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isStream = draggingWidget === "stream";
      const streamChatBoost = isStream && streamChatActive ? (platform === 'kick' || platform === 'joystick' ? 44 : 138) : 0;
      const streamW = streamOverlaySize.w;
      const streamH = streamOverlaySize.h + 40 + streamChatBoost;
      const clampW = isStream ? streamW : def.w;
      const clampH = isStream ? streamH : def.h;
      const newLeft = Math.max(0, Math.min(vw - clampW, e.clientX - dragOffsetRef.current.x));
      const newTop = Math.max(0, Math.min(vh - clampH, e.clientY - dragOffsetRef.current.y));
      setWidgetPositions((prev) => ({
        ...prev,
        [draggingWidget]: { top: newTop, left: newLeft },
      }));
    };
    const onUp = () => setDraggingWidget(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingWidget]);

  // Keyboard: Escape closes all widgets, Ctrl+B toggles panel
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openWidgets.size > 0) {
        setOpenWidgets(new Set());
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openWidgets, leftCollapsed, leftPanelSize]);

  useEffect(() => {
    localStorage.setItem("forge-panel-left-collapsed", leftCollapsed.toString());
  }, [leftCollapsed]);

  useEffect(() => {
    localStorage.setItem("forge-panel-left-expanded-size", leftPanelSize.toString());
  }, [leftPanelSize]);

  useEffect(() => {
    localStorage.setItem("forge-panel-left-collapsed-size", leftCollapsedSize.toString());
  }, [leftCollapsedSize]);

  // Listen for reset-layout event from command palette
  useEffect(() => {
    const onReset = () => resetFHDDefaults();
    window.addEventListener("forge-reset-layout", onReset);
    return () => window.removeEventListener("forge-reset-layout", onReset);
  }, []);

  // Listen for tutorial-open-widget event to auto-open widgets during tutorial
  useEffect(() => {
    const onOpenWidget = (e: Event) => {
      const widget = (e as CustomEvent).detail?.widget as WidgetType | undefined;
      if (!widget) return;
      setOpenWidgets((prev) => {
        if (prev.has(widget)) return prev;
        const next = new Set(prev);
        next.add(widget);
        return next;
      });
    };
    window.addEventListener("tutorial-open-widget", onOpenWidget);
    return () => window.removeEventListener("tutorial-open-widget", onOpenWidget);
  }, []);

  const handleVoiceCaptureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const onCapture = () => {
      handleVoiceCaptureRef.current();
    };
    window.addEventListener("capture-trigger", onCapture);
    return () => window.removeEventListener("capture-trigger", onCapture);
  }, []);

  useEffect(() => {
    const onSnap = () => {
      handleManualCaptureRef.current(true);
    };
    window.addEventListener("snap-capture", onSnap);
    return () => window.removeEventListener("snap-capture", onSnap);
  }, []);

  // When a new audio segment arrives, check if any active bot's name is
  // mentioned (using fuzzy matching for Whisper mishears). If so, dispatch a
  // targeted force-check so the mentioned bot responds immediately instead of
  // waiting up to 15s for the next interval tick.
  const checkAudioMention = (segment: string) => {
    const state = useAppStore.getState();
    if (!state.multiBotEnabled || !state.autoForgeEnabled) return;
    for (const bot of state.bots) {
      if (!bot.active || !bot.session?.username) continue;
      if (isNameMentioned(segment, bot.session.username)) {
        console.log(`[AudioMention] @${bot.session.username} mentioned in audio — forcing check`);
        window.dispatchEvent(new CustomEvent("autoforge-force-check", {
          detail: { botId: bot.id, audioMention: true },
        }));
      }
    }
  };

  const handleVoiceCapture = async () => {
    if (windowSelected) {
      if (!isMicCapturing) {
        stopDeepgram();
      }
      setWindowSelected(false);
      setTabCaptureMode(false);
      tabCaptureModeRef.current = false;
      captureSurfaceTypeRef.current = "window";
      if (cachedStreamRef.current) {
        cachedStreamRef.current.getTracks().forEach(t => t.stop());
        cachedStreamRef.current = null;
      }
      if (captureVideoRef.current) {
        captureVideoRef.current.pause();
        captureVideoRef.current.srcObject = null;
        captureVideoRef.current = null;
      }
      toast.success("Capture stopped");
      return;
    }

    try {
      const displayMediaOptions: any = {
        video: true,
        audio: true,
      };
      const captureStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      cachedStreamRef.current = captureStream;
      setWindowSelected(true);

      // Detect capture type from the actual track settings (not the requested constraint)
      const videoTrack = captureStream.getVideoTracks()[0];
      const trackSettings = videoTrack?.getSettings() || {};
      const surfaceType = trackSettings.displaySurface || "window";
      const trackLabel = videoTrack?.label || "";
      const isTabCapture = surfaceType === "browser" || trackLabel.toLowerCase().includes("tab");
      tabCaptureModeRef.current = isTabCapture;
      captureSurfaceTypeRef.current = surfaceType;
      if (isTabCapture) {
        setTabCaptureMode(true);
        toast.warning("Same-tab capture detected — frames will be cropped to the stream embed only. Do NOT collapse the left sidepanel or resize panels, or the crop region will be wrong!", { duration: 8000 });
      } else {
        setTabCaptureMode(false);
        toast.success(`Capture started — source: ${surfaceType === "monitor" ? "full screen" : "window"}`, { duration: 4000 });
      }

      const audioTracks = captureStream.getAudioTracks();
      if (audioTracks.length > 0 && !isMicCapturing) {
        const audioOnlyStream = new MediaStream(audioTracks.map(t => t.clone()));
        const showedPrompt = await startEmbedWhisper(audioOnlyStream, (formattedSegment) => {
          appendAudioTranscript(formattedSegment);
          checkAudioMention(formattedSegment);
        });
        if (!showedPrompt) {
          toast.success("Capture started — video + audio transcription via Whisper...");
        }
      } else if (audioTracks.length > 0 && isMicCapturing) {
        toast.success("Capture started — video added (mic transcription already active)...");
      } else {
        toast.success("Capture started — video only (no audio track shared)...");
      }

      handleCaptureWindow();
    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        toast.error("Permission denied to capture screen.");
      } else {
        toast.error("Failed to start capture");
      }
      setWindowSelected(false);
    }
  };
  handleVoiceCaptureRef.current = handleVoiceCapture;

  const handleMicrophoneCaptureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const onMicCapture = () => {
      handleMicrophoneCaptureRef.current();
    };
    window.addEventListener("mic-capture-trigger", onMicCapture);
    return () => window.removeEventListener("mic-capture-trigger", onMicCapture);
  }, []);

  const handleMicrophoneCapture = async () => {
    if (isMicCapturing) {
      if (!windowSelected) {
        stopDeepgram();
      }
      setIsMicCapturing(false);
      setMicStreamForEnergy(null);
      toast.success("Microphone capture stopped");
      return;
    }

    try {
      const micStream = await ensureMicPermission();
      if (!micStream) {
        toast.error("Microphone permission denied. Allow mic access in your browser.");
        return;
      }

      const sharedStream = new MediaStream(micStream.getTracks().map((t) => t.clone()));
      setMicStreamForEnergy(sharedStream);
      toast.info("Starting microphone transcription via Whisper...");
      const showedPrompt = await startEmbedWhisper(sharedStream, (formattedSegment) => {
        appendAudioTranscript(formattedSegment);
        checkAudioMention(formattedSegment);
      });
      if (!showedPrompt) {
        setIsMicCapturing(true);
        toast.success("Microphone capture started — audio transcription via Whisper...");
      }
    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        toast.error("Microphone permission denied.");
      } else {
        toast.error("Failed to start microphone capture: " + (e.message || 'Unknown error'));
      }
    }
  };
  handleMicrophoneCaptureRef.current = handleMicrophoneCapture;

  const handleCaptureWindow = async (isManual = false, forceStreamCrop = false) => {
    try {
      if (!cachedStreamRef.current || !cachedStreamRef.current.active) {
        toast.error("Start capture first using the Capture button.");
        return;
      }
      const captureStream = cachedStreamRef.current;

      if (!captureVideoRef.current) {
        captureVideoRef.current = document.createElement("video");
        captureVideoRef.current.muted = true;
        captureVideoRef.current.srcObject = captureStream;
        await captureVideoRef.current.play();
      }
      const video = captureVideoRef.current;

      // Ensure video is still playing; re-play if it paused
      if (video.paused) {
        try { await video.play(); } catch {}
      }

      const videoWidth = video.videoWidth || 1280;
      const videoHeight = video.videoHeight || 720;

      if (videoWidth === 0 || videoHeight === 0) {
        console.warn("[Visual] Video dimensions are 0x0 — stream may have ended");
        toast.error("Capture stream lost", { description: "The screen share may have been stopped. Re-capture the window." });
        setWindowSelected(false);
        return;
      }

      // ── Stream embed cropping ──────────────────────────────────────────────
      // The SNAP keybind (P) always forces a crop to the stream embed element.
      // Regular captures only crop when same-tab capture is detected (the user
      // shared this tab, so the full frame includes the MADchatter UI).
      let cropX = 0, cropY = 0, cropW = videoWidth, cropH = videoHeight;

      // Helper: find the best visible [data-stream-embed] element and crop to it.
      // Returns true if a crop was applied.
      const cropToStreamEmbed = (): boolean => {
        const streamEls = document.querySelectorAll('[data-stream-embed]');
        let streamEl: HTMLElement | null = null;
        let bestArea = 0;
        streamEls.forEach((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; streamEl = el as HTMLElement; }
        });
        // Fallback: iframe with "stream" in the title (e.g. Kick)
        if (!streamEl) {
          streamEl = document.querySelector('iframe[title*="stream" i]') as HTMLIFrameElement | null;
        }
        if (!streamEl) return false;

        const rect = streamEl.getBoundingClientRect();
        // Clip to the visible viewport so only the visible portion of the stream embed is captured
        const visLeft = Math.max(0, rect.left);
        const visTop = Math.max(0, rect.top);
        const visRight = Math.min(window.innerWidth, rect.right);
        const visBottom = Math.min(window.innerHeight, rect.bottom);
        if (visRight <= visLeft || visBottom <= visTop) return false; // not visible

        // ── Coordinate mapping: viewport CSS px → video frame px ──────────
        // getBoundingClientRect() returns coordinates relative to the browser
        // viewport (below the chrome). For tab captures, the video frame IS
        // the viewport, so the mapping is a simple scale. For monitor/window
        // captures, the video frame includes the browser chrome (search bar,
        // tabs, etc.) above the viewport, so we need to add an offset.
        const surface = captureSurfaceTypeRef.current;
        const isTab = surface === "browser";
        // Chrome height = browser UI above the viewport (tabs + address bar + bookmarks)
        const chromeHeight = window.outerHeight - window.innerHeight;

        let scaleX: number, scaleY: number;
        let offsetX = 0, offsetY = 0;

        if (isTab) {
          // Tab capture: video frame = viewport content area
          scaleX = videoWidth / window.innerWidth;
          scaleY = videoHeight / window.innerHeight;
        } else if (surface === "monitor") {
          // Monitor capture: video frame = full screen.
          // The browser window is at (screenX, screenY) on the screen, and the
          // viewport starts at (screenX, screenY + chromeHeight).
          // Scale from CSS screen px to video px.
          const screenW = window.screen.width || window.outerWidth;
          const screenH = window.screen.height || window.outerHeight;
          scaleX = videoWidth / screenW;
          scaleY = videoHeight / screenH;
          offsetX = window.screenX;
          offsetY = window.screenY + chromeHeight;
        } else {
          // Window capture: video frame = browser window (includes chrome).
          // The viewport starts at (0, chromeHeight) within the window.
          scaleX = videoWidth / window.outerWidth;
          scaleY = videoHeight / window.outerHeight;
          offsetY = chromeHeight;
        }

        cropX = Math.round((offsetX + visLeft) * scaleX);
        cropY = Math.round((offsetY + visTop) * scaleY);
        cropW = Math.round((visRight - visLeft) * scaleX);
        cropH = Math.round((visBottom - visTop) * scaleY);
        // Clamp to video bounds
        cropX = Math.max(0, Math.min(cropX, videoWidth - 1));
        cropY = Math.max(0, Math.min(cropY, videoHeight - 1));
        cropW = Math.max(1, Math.min(cropW, videoWidth - cropX));
        cropH = Math.max(1, Math.min(cropH, videoHeight - cropY));
        console.log(`[Visual] Cropping to stream embed: ${cropX},${cropY} ${cropW}x${cropH} (video ${videoWidth}x${videoHeight}, surface=${surface})`);
        return true;
      };

      if (forceStreamCrop) {
        // SNAP keybind — crop to the stream embed ONLY when the capture is
        // MADchatter's own tab/window/monitor. When the user captured a
        // different window or tab, the full video frame IS the stream —
        // cropping to MADchatter's [data-stream-embed] DOM coordinates would
        // map to the wrong region and zoom into a sub-area.
        const surface = captureSurfaceTypeRef.current;
        const dpr = window.devicePixelRatio || 1;
        let shouldCrop = false;

        if (surface === "browser") {
          // Tab capture — crop only if it's the same tab (viewport × DPR)
          const expectedW = Math.round(window.innerWidth * dpr);
          const expectedH = Math.round(window.innerHeight * dpr);
          shouldCrop = Math.abs(videoWidth - expectedW) <= 4 && Math.abs(videoHeight - expectedH) <= 4;
          if (!shouldCrop) {
            console.log('[Visual] SNAP: Different tab — full frame is the stream, no crop');
          }
        } else if (surface === "monitor") {
          // Monitor capture — the full screen is shown, which includes
          // MADchatter's UI, so cropping to the stream embed makes sense.
          shouldCrop = true;
        } else {
          // Window capture — crop only if it's the MADchatter window.
          // Match video dimensions against outerWidth/outerHeight × DPR.
          const expectedW = Math.round(window.outerWidth * dpr);
          const expectedH = Math.round(window.outerHeight * dpr);
          shouldCrop = Math.abs(videoWidth - expectedW) <= 10 && Math.abs(videoHeight - expectedH) <= 10;
          if (!shouldCrop) {
            console.log(`[Visual] SNAP: Different window (video=${videoWidth}x${videoHeight}, expected=${expectedW}x${expectedH}) — full frame is the stream, no crop`);
          }
        }

        if (shouldCrop) {
          const cropped = cropToStreamEmbed();
          if (!cropped) {
            console.log('[Visual] SNAP: No stream embed element found — using full frame');
          }
        }
      } else if (tabCaptureModeRef.current) {
        // Regular capture in tab mode — verify it's the same tab.
        // For tab captures, the video frame IS the viewport content area, so
        // video dimensions should match innerWidth/innerHeight × DPR closely.
        // A loose tolerance (< 200) caused flaky same-tab detection, which
        // made cropping toggle on/off unpredictably between captures.
        const dpr = window.devicePixelRatio || 1;
        const expectedW = Math.round(window.innerWidth * dpr);
        const expectedH = Math.round(window.innerHeight * dpr);
        // Tight tolerance: tab captures match viewport × DPR exactly (±2px
        // for sub-pixel rounding). If it doesn't match, this is a different
        // tab whose content is the stream itself — no crop needed.
        const dimMatch = Math.abs(videoWidth - expectedW) <= 4 && Math.abs(videoHeight - expectedH) <= 4;
        console.log(`[Visual] Tab capture: video=${videoWidth}x${videoHeight}, expected=${expectedW}x${expectedH}, dpr=${dpr}, sameTab=${dimMatch}`);
        if (dimMatch) {
          cropToStreamEmbed();
        } else {
          // Different tab capture — the full frame is the stream, no cropping needed
          console.log('[Visual] Different tab detected — using full frame');
          tabCaptureModeRef.current = false;
          setTabCaptureMode(false);
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);

      // Don't stop the stream — keep it cached for reuse
      // captureStream.getTracks().forEach((track) => track.stop());

      setVisualSnapshot(dataUrl, ["Captured"], isManual ? "manual" : "auto", undefined, true);
      window.dispatchEvent(new CustomEvent('bg-visual-capture'));

      // Trigger icon animation
      if (isManual) {
        setVisualManualFlash(true);
        if (visualManualFlashRef.current) clearTimeout(visualManualFlashRef.current);
        visualManualFlashRef.current = window.setTimeout(() => setVisualManualFlash(false), 1000);
      } else {
        setVisualAutoFlash(true);
        if (visualAutoFlashRef.current) clearTimeout(visualAutoFlashRef.current);
        visualAutoFlashRef.current = window.setTimeout(() => setVisualAutoFlash(false), 600);
      }

      // Frame diffing — skip vision API call if scene hasn't meaningfully changed
      const { delta, imageData, isFirstFrame } = computeFrameDelta(canvas, prevFrameDataRef.current);
      prevFrameDataRef.current = imageData;

      // Smart capture: dynamically adjust interval based on scene change rate
      if (smartCapture && !isManual) {
        const cfg = SMART_LEVELS[smartLevel];
        let nextInterval = visualCaptureInterval;
        if (delta > cfg.highDelta) {
          nextInterval = Math.max(cfg.minInt, Math.round(visualCaptureInterval * cfg.fastMult));
        } else if (delta > cfg.midDelta) {
          nextInterval = Math.max(cfg.minInt, Math.round(visualCaptureInterval * cfg.midMult));
        } else if (delta < cfg.lowDelta) {
          nextInterval = Math.min(cfg.maxInt, Math.round(visualCaptureInterval * cfg.slowMult));
        }
        if (nextInterval !== visualCaptureInterval) {
          console.log(`[Visual] Smart [${cfg.name}] adjust: ${visualCaptureInterval}s → ${nextInterval}s (delta: ${(delta * 100).toFixed(1)}%)`);
          setVisualCaptureInterval(nextInterval);
        }
      }

      // C3: Skip vision API on first frame (no baseline to compare against),
      // but still store the snapshot. Only manual captures force a vision call on first frame.
      if (isFirstFrame && !isManual) {
        console.log(`[Visual] First frame captured — storing baseline, skipping vision API`);
        setVisualSnapshot(dataUrl, ["First frame — baseline"], "auto", delta);
        return;
      }

      if (!isManual && delta < DELTA_THRESHOLD) {
        console.log(`[Visual] Frame unchanged (delta: ${(delta * 100).toFixed(1)}%), skipping vision API`);
        setVisualSnapshot(dataUrl, ["Unchanged frame"], "auto", delta);
        return;
      }

      console.log(`[Visual] Frame changed (delta: ${(delta * 100).toFixed(1)}%), calling vision API`);

      // Async vision request with previous context for delta-aware prompting
      try {
        const provider = getActiveProvider();
        const data = await visionRequest(dataUrl, provider, prevVisualContextRef.current);
        if (data.tokenUsage) {
          useAppStore.getState().recordTokenUsage("vision", data.tokenUsage);
        }
        if (data.visualContext) {
          prevVisualContextRef.current = data.visualContext;
          setVisualSnapshot(dataUrl, [data.visualContext], isManual ? "manual" : "auto", delta);
        } else {
          setVisualSnapshot(dataUrl, ["Captured — no analysis"], isManual ? "manual" : "auto", delta);
        }
      } catch (visionErr: any) {
        const vErrMsg = visionErr?.message || String(visionErr);
        if (!vErrMsg.includes('No API key configured')) {
          console.error("[Visual] Vision API error:", visionErr);
          toast.error("Vision API failed", { description: vErrMsg });
        }
        setVisualSnapshot(dataUrl, ["Captured — vision failed"], isManual ? "manual" : "auto", delta);
      }
    } catch (e: any) {
      console.error("[Visual] Capture error:", e);
      toast.error("Failed to capture window", { description: e?.message || String(e) });
    }
  };

  const renderWidgetContent = (widget: WidgetType, embedded = false) => {
    if (widget === "audio") {
      return (
        <div className="text-xs text-gray-300 space-y-1.5 font-mono">
          {isMobile && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-orange-400 shrink-0" />
                <span className="text-[11px] text-orange-200 leading-snug">
                  Audio transcription isn't available on mobile. System audio capture and in-browser Whisper both require a desktop Chromium browser (Chrome or Edge) with WebGPU support.
                </span>
              </div>
            </div>
          )}
          {!isMobile && whisperPrompt && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex items-center gap-2">
                <AudioLines className="w-4 h-4 text-purple-400 shrink-0" />
                <span className="text-[11px] text-purple-200">
                  In-browser Whisper transcription needs to download a speech model (~150MB, cached after first use). No API key required.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => confirmWhisperDownload()}
                  className="px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-purple-500/30 text-purple-200 hover:bg-purple-500/50 border border-purple-500/30 transition-all"
                >
                  Yes, download
                </button>
                <button
                  type="button"
                  onClick={() => cancelWhisperDownload()}
                  className="px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-white/5 text-gray-400 hover:bg-white/10 border border-white/10 transition-all"
                >
                  No, cancel
                </button>
              </div>
            </div>
          )}
          {!isMobile && whisperDownloading && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <AudioLines className="w-4 h-4 text-purple-400 shrink-0 animate-pulse" />
              <span className="text-[11px] text-purple-200">
                Downloading Whisper model<span className="whisper-dots"><span>.</span><span>.</span><span>.</span></span>
              </span>
            </div>
          )}
          {!isMobile && audioTranscript ? (
            audioTranscript.split("\n").map((line, i) => {
              const match = line.match(/^\[(.*?)\]\s*(.*)$/);
              const time = match ? match[1] : "Audio";
              const text = match ? match[2] : line;
              return (
                <div key={i} className="group relative flex justify-between items-start hover:bg-white/5 p-1 rounded transition-colors">
                  <div className="flex-1 min-w-0 pr-2">
                    <span className="text-purple-400 font-bold text-[10px] uppercase mr-1">{time}:</span>
                    <span className="text-gray-200 leading-snug break-words">{text}</span>
                  </div>
                  <ThemedTooltip content="Pin to Long-Term Memory">
                    <button
                      type="button"
                      onClick={() => {
                        addPinnedMemory({ type: "audio", content: line, label: `[${time}] ${text}`, timestamp: Date.now() });
                        toast.success("Pinned to Long-Term Memory");
                        playSfx('memory_add');
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity absolute -right-1 top-0.5 p-0.5 rounded text-blue-400 hover:text-blue-300 hover:bg-blue-500/15"
                    >
                      <Pin className="w-3 h-3" />
                    </button>
                  </ThemedTooltip>
                </div>
              );
            })
          ) : !isMobile ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <AudioLines className="w-8 h-8 text-purple-500/30" />
              <span className="text-[11px] text-gray-600 italic text-center">
                Audio sync inactive.
              </span>
            </div>
          ) : null}
        </div>
      );
    }
    if (widget === "chat") {
      const filteredChatLog = chatSearchQuery
        ? chatLog.filter((msg) => {
            if (msg.marker) return false;
            const q = chatSearchQuery.toLowerCase();
            return msg.user.toLowerCase().includes(q) || msg.text.toLowerCase().includes(q);
          })
        : chatLog;
      return (
        <div className="flex flex-col h-full">
          {/* Chat Search Bar */}
          <div className="flex items-center gap-1.5 px-2 py-1 border-b border-white/5 bg-black/30 shrink-0">
            <Search className="w-3 h-3 text-gray-500 shrink-0" />
            <input
              type="text"
              value={chatSearchQuery}
              onChange={(e) => setChatSearchQuery(e.target.value)}
              placeholder="Search chat..."
              className="flex-1 bg-transparent text-[11px] text-gray-300 placeholder:text-gray-600 outline-none font-mono min-w-0"
            />
            {chatSearchQuery && (
              <button
                type="button"
                onClick={() => setChatSearchQuery("")}
                className="text-gray-500 hover:text-white transition-colors shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {/* E2: Chat Sentiment Heatmap Overlay — pinned to top with search */}
          {sentimentHistory.length > 0 && (
            <ThemedTooltip content="Recent chat sentiment heatmap">
              <div className="flex items-center gap-px h-1.5 mb-1 rounded overflow-hidden bg-black/30 shrink-0">
                {sentimentHistory.slice(-40).map((r, idx) => (
                  <div
                    key={idx}
                    className={cn("flex-1 h-full transition-colors", SENTIMENT_DOT_COLORS[r.label as SentimentLabel])}
                    style={{ opacity: 0.3 + (r.score * 0.7) }}
                  />
                ))}
              </div>
            </ThemedTooltip>
          )}
          {/* Smart Reply Chips */}
          {(smartReplies.length > 0 || smartRepliesLoading) && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5 bg-cyan-500/5 shrink-0 flex-wrap">
              {smartRepliesLoading ? (
                <span className="text-[10px] text-cyan-400 animate-pulse">Generating replies...</span>
              ) : (
                <>
                  <span className="text-[9px] text-cyan-500 font-bold uppercase shrink-0">Reply:</span>
                  {smartReplies.map((reply, idx) => (
                    <ThemedTooltip content={reply.text}>
                      <button
                        key={reply.id}
                        type="button"
                        onClick={() => sendSmartReply(reply.text)}
                        className="text-[10px] px-2 py-1 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/25 hover:border-cyan-400/50 transition-all max-w-[200px] truncate flex items-center gap-1"
                      >
                        <kbd className="text-[8px] font-mono bg-cyan-500/20 rounded px-0.5 text-cyan-400 shrink-0">{idx + 1}</kbd>
                        {reply.text}
                      </button>
                    </ThemedTooltip>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSmartReplies([])}
                    className="text-gray-500 hover:text-white transition-colors shrink-0 ml-auto"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          )}
          <div className="text-xs text-gray-300 space-y-1 font-mono flex-1 overflow-y-auto overflow-x-hidden forge-scroll">
          {/* B5: Bot Typing Indicator */}
          <AnimatePresence>
            {isAutoForgeThinking && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="flex items-center gap-1.5 py-1 px-2 my-0.5 rounded-md bg-orange-500/10 border border-orange-500/20"
              >
                <span className="text-[8px] font-bold uppercase tracking-wider text-orange-400 shrink-0">AutoForge</span>
                <div className="flex items-center gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="w-1 h-1 rounded-full bg-orange-400"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                    />
                  ))}
                </div>
                <span className="text-[9px] text-orange-300/70 italic">thinking...</span>
              </motion.div>
            )}
          </AnimatePresence>
          {filteredChatLog.length > 0 ? (
            <>
            {filteredChatLog.map((msg, i) => {
              if (msg.marker === "manual") {
                return (
                  <div
                    key={`manual-${i}`}
                    className="flex items-center gap-1.5 py-0.5 my-0.5"
                  >
                    <div className="flex-1 h-0.5 bg-yellow-400/80 rounded-full" />
                    <span className="text-[8px] font-bold uppercase tracking-wider text-yellow-400/90 shrink-0">Forge</span>
                    <div className="flex-1 h-0.5 bg-yellow-400/80 rounded-full" />
                  </div>
                );
              }
              if (msg.marker === "autoforge") {
                return (
                  <div
                    key={`af-${i}`}
                    className="flex items-center gap-1.5 py-0.5 my-0.5"
                  >
                    <div className="flex-1 h-0.5 bg-orange-500/80 rounded-full" />
                    <span className="text-[8px] font-bold uppercase tracking-wider text-orange-400/90 shrink-0">AutoForge</span>
                    <div className="flex-1 h-0.5 bg-orange-500/80 rounded-full" />
                  </div>
                );
              }
              const username = msg.user;
              const text = msg.text;
              const badges = msg.badges || [];
              const isBanned = msg.banned;
              const sentimentColor = msg.sentiment ? SENTIMENT_DOT_COLORS[msg.sentiment as SentimentLabel] : null;
              return (
                <div
                  key={msg.id || `msg-${i}`}
                  className={`group relative flex items-start hover:bg-teal-500/5 p-1.5 rounded-md border-b border-white/[0.02]${isBanned ? ' banned-message' : ''}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    navigator.clipboard.writeText(`${username}: ${text}`).then(() => {
                      toast.success("Copied to clipboard");
                    }).catch(() => {});
                  }}
                >
                  <div className="flex items-center gap-1 shrink-0 mr-1.5">
                    {badges.includes('broadcaster') && <ThemedTooltip content="Broadcaster"><span className="text-[8px] text-purple-400">📹</span></ThemedTooltip>}
                    {badges.includes('moderator') && (
                      <ThemedTooltip content="Moderator"><span className="text-[8px] text-green-400 cursor-help">🛡️</span></ThemedTooltip>
                    )}
                    {badges.includes('vip') && <ThemedTooltip content="VIP"><span className="text-[8px] text-pink-400">💎</span></ThemedTooltip>}
                    {badges.includes('subscriber') && (
                      <ThemedTooltip content="Subscriber"><span className="text-[8px] text-purple-400 cursor-help">⭐</span></ThemedTooltip>
                    )}
                  </div>
                  <span className={`font-bold text-[10px] shrink-0${isBanned ? ' banned-username' : ' text-teal-400'}`}>@{username}:</span>
                  <EmoteText text={text} channel={streamMetadata?.channelName} className={`leading-snug break-words flex-1 min-w-0 ml-1.5${isBanned ? ' banned-text' : ' text-gray-200'}`} />
                  {sentimentColor && (
                    <ThemedTooltip content={`Sentiment: ${msg.sentiment}`}>
                      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0 self-center', sentimentColor)} />
                    </ThemedTooltip>
                  )}
                  <ThemedTooltip content="Pin to Long-Term Memory">
                    <button
                      type="button"
                      onClick={() => {
                        addPinnedMemory({ type: "chat", content: `${username}: ${text}`, label: `@${username}: ${text}`, timestamp: Date.now() });
                        toast.success("Pinned to Long-Term Memory");
                        playSfx('memory_add');
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity absolute -right-1 top-0.5 p-0.5 rounded text-blue-400 hover:text-blue-300 hover:bg-blue-500/15"
                    >
                      <Pin className="w-3 h-3" />
                    </button>
                  </ThemedTooltip>
                </div>
              );
            })}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <MessageSquare className="w-8 h-8 text-teal-500/30" />
              <span className="text-[11px] text-gray-600 italic text-center">
                {chatSearchQuery ? "No messages match your search." : <>Waiting for stream chat...<br />Connect via {platform === 'kick' ? 'Kick' : platform === 'joystick' ? 'Joystick' : 'Twitch'} to see messages.</>}
              </span>
            </div>
          )}
          </div>
        </div>
      );
    }
    if (widget === "visual") {
      return (
        <div className="flex flex-col gap-3">
          {visualSnapshotUrl ? (
            <div className="group relative">
              <img
                src={visualSnapshotUrl}
                alt="Visual Context"
                referrerPolicy="no-referrer"
                className="w-full rounded-lg border border-white/10 object-cover"
              />
              <ThemedTooltip content="Pin to Long-Term Memory">
                <button
                  type="button"
                  onClick={() => {
                    addPinnedMemory({ type: "visual", content: visualContextTags.join(", "), label: `Visual Snapshot — ${visualContextTags[0]?.slice(0, 60) || "Captured"}${visualContextTags[0] && visualContextTags[0].length > 60 ? "…" : ""}`, timestamp: Date.now(), imageUrl: visualSnapshotUrl });
                    toast.success("Pinned to Long-Term Memory");
                    playSfx('memory_add');
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 backdrop-blur-sm text-blue-400 hover:text-blue-300 hover:bg-blue-500/20 border border-white/10"
                >
                  <Pin className="w-4 h-4" />
                </button>
              </ThemedTooltip>
            </div>
          ) : (
            <div className="aspect-video w-full bg-black/40 rounded-lg border border-white/10 flex flex-col items-center justify-center gap-2">
              <Eye className="w-8 h-8 text-orange-500/30" />
              <span className="text-[10px] text-gray-600 font-mono">No frame captured</span>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {visualContextTags.length > 0 && visualContextTags[0] ? (
              <>
                <button
                  onClick={() => setVisualContextExpanded((v) => !v)}
                  className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-orange-400 transition-colors"
                >
                  <ChevronDown className={cn("w-3 h-3 transition-transform", visualContextExpanded && "rotate-180")} />
                  {visualContextExpanded ? "Hide" : "Show"} Analysis
                </button>
                {visualContextExpanded ? (
                  <div className="max-h-24 overflow-y-auto bg-black/30 border border-white/10 rounded-lg p-2 text-[10px] text-gray-300 leading-relaxed font-mono whitespace-pre-wrap break-words">
                    {visualContextTags.join("\n")}
                  </div>
                ) : (
                  <p className="text-[10px] text-gray-500 leading-snug font-mono truncate">
                    {visualContextTags[0].slice(0, 80)}{visualContextTags[0].length > 80 ? "…" : ""}
                  </p>
                )}
              </>
            ) : (
              <span className="text-[10px] text-gray-600 font-mono italic">
                Awaiting screen capture analysis...
              </span>
            )}
            {visualAutoCapture && windowSelected && visualCountdown > 0 && (
              <span className="text-[9px] text-orange-400/60 font-mono text-right">
                {visualCountdown}s
              </span>
            )}
            {visualSnapshotHistory.length > 0 && (
              <ThemedTooltip content="View visual snapshot history">
                <button
                  onClick={() => { setVisualHistoryOpen(true); playSfx('hud_open'); }}
                  className="flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-orange-400 py-1.5 rounded-md border border-white/10 hover:border-orange-500/30 hover:bg-orange-500/5 transition-all"
                >
                  <Clock className="w-3 h-3" />
                  History · {visualSnapshotHistory.length}
                </button>
              </ThemedTooltip>
            )}
          </div>
        </div>
      );
    }
    if (widget === "memory") {
      return (
        <div className="flex flex-col gap-1 text-xs font-mono">
          {pinnedMemories.length > 0 ? (
            pinnedMemories.map((mem) => {
              const isGolden = goldenMemoryId === mem.id;
              return (
                <div key={mem.id} className={`group relative flex items-start gap-2 border rounded-lg p-2 transition-colors ${isGolden ? "bg-yellow-500/10 border-yellow-500/40" : "bg-black/20 border-white/5 hover:border-blue-500/20"}`}>
                  {mem.imageUrl && (
                    <img src={mem.imageUrl} alt="" className="w-14 h-14 rounded object-cover shrink-0 border border-white/10" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${mem.type === "chat" ? "text-teal-400 bg-teal-500/10" : mem.type === "audio" ? "text-purple-400 bg-purple-500/10" : "text-orange-400 bg-orange-500/10"}`}>
                        {mem.type}
                      </span>
                      <span className="text-[9px] text-gray-600">{new Date(mem.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      {isGolden && (
                        <span className="text-[8px] font-bold uppercase tracking-wider text-yellow-400 bg-yellow-500/15 px-1 py-0.5 rounded flex items-center gap-0.5">
                          <Star className="w-2 h-2 fill-yellow-400" /> Golden
                        </span>
                      )}
                    </div>
                    <p className={`leading-snug break-words pr-10 ${isGolden ? "text-yellow-200" : "text-gray-300"}`}>{mem.label}</p>
                  </div>
                  <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                    <ThemedTooltip content={isGolden ? "Remove golden star" : "Set as golden memory (extra impact on forge)"}>
                      <button
                        type="button"
                        onClick={() => {
                          setGoldenMemory(isGolden ? null : mem.id);
                          toast.success(isGolden ? "Golden star removed" : "Golden star set — this memory will have extra impact on forged comments");
                        }}
                        className={`p-0.5 rounded transition-all ${isGolden ? "text-yellow-400 hover:text-yellow-300" : "opacity-0 group-hover:opacity-100 text-gray-500 hover:text-yellow-400 hover:bg-yellow-500/15"}`}
                      >
                        <Star className={`w-3 h-3 ${isGolden ? "fill-yellow-400" : ""}`} />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content="Unpin from memory">
                      <button
                        type="button"
                        onClick={() => {
                          if (isGolden) setGoldenMemory(null);
                          removePinnedMemory(mem.id);
                          playSfx('memory_remove');
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/15"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </ThemedTooltip>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <Brain className="w-8 h-8 text-blue-500/30" />
              <span className="text-[11px] text-gray-600 italic text-center">
                No pinned context yet. Pin key moments from chat, audio transcripts, or visual snapshots to build a running memory.
              </span>
            </div>
          )}
        </div>
      );
    }
    if (widget === "stream") {
      return (
        <StreamOverlay
          channel={streamMetadata?.channelName || ""}
          onClose={() => toggleWidget("stream")}
          size={streamOverlaySize}
          onResize={(newSize) => {
            setStreamOverlaySize(newSize);
            localStorage.setItem("forge-stream-overlay-size", JSON.stringify(newSize));
          }}
          onVisualCapture={handleVoiceCapture}
          onMicrophoneCapture={handleMicrophoneCapture}
          isMicCapturing={isMicCapturing}
          onManualSnapshot={handleManualCapture}
          isVisualCapturing={windowSelected}
          visualCooldown={visualCooldown}
          tabCaptureMode={tabCaptureMode}
          onChatModeChange={setStreamChatActive}
          embedded={embedded}
        />
      );
    }
    return null;
  };

  return (
    <TooltipProvider>
      {isMobile ? (
        /* ═══ Mobile Layout — tabbed, bottom bar, single panel at a time ═══ */
        <div className="flex flex-col h-full w-full bg-transparent relative z-10 overflow-hidden">
          {/* Compact Header — logo + login only */}
          <div className="shrink-0 h-[42px] border-b border-white/5 bg-[#121217]/90 backdrop-blur-md px-3 flex items-center justify-between gap-2 z-40 safe-top">
            <div className="flex items-center shrink-0 gap-2">
              <img src={logoUrl} alt="MADchatter" className="relative z-10 h-[28px] w-auto forge-logo-glow cursor-pointer select-none" style={{ opacity: 0.8 }} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {activeUser ? (
                <div className="flex items-center h-7 rounded-md overflow-hidden border bg-[#18181B] border-white/10">
                  <span className="text-[11px] font-bold tracking-wide text-white truncate max-w-[80px] px-2">
                    @{activeUser.display_name || activeUser.login || activeUser.username}
                  </span>
                  <ThemedTooltip content="Disconnect">
                    <button onClick={activeLogout} className="h-full px-2 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors">
                      <LogOut className="w-3.5 h-3.5" />
                    </button>
                  </ThemedTooltip>
                </div>
              ) : (
                <button
                  onClick={activeLogin}
                  disabled={activeLoginInProgress}
                  className={cn(
                    "h-8 px-3 flex items-center gap-1.5 disabled:opacity-70 text-white text-[11px] font-bold uppercase tracking-wider rounded-md transition-colors touch-target",
                    platform === 'kick' ? "bg-[#53fc18] hover:bg-[#44d014] text-black"
                      : platform === 'joystick' ? "bg-[#FF6B35] hover:bg-[#e55a25]"
                        : "bg-[#9146FF] hover:bg-[#772ce8]"
                  )}
                >
                  {activeLoginInProgress ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                  <span>Login</span>
                </button>
              )}
            </div>
          </div>

          {/* Tab Content — single panel visible at a time */}
          <div className="mobile-panel-stack">
            {mobileTab === "forge" && (
              <div className="mobile-panel">
                <TheForge />
              </div>
            )}
            {mobileTab === "tuning" && (
              <div className="mobile-panel">
                <TuningDeck rightSize={22} />
              </div>
            )}
            {mobileTab === "context" && (
              <div className="mobile-panel forge-scroll-main select-text p-3 space-y-3">
                {iconOrder.map((widget) => {
                  const widgetIcon: Record<WidgetType, React.ReactNode> = {
                    audio: <AudioLines className="w-3.5 h-3.5 text-purple-400" />,
                    chat: <MessageSquare className="w-3.5 h-3.5 text-teal-400" />,
                    visual: <Eye className="w-3.5 h-3.5 text-orange-400" />,
                    memory: <Brain className="w-3.5 h-3.5 text-blue-400" />,
                    stream: <Tv className="w-3.5 h-3.5 text-[#9146FF]" />,
                  };
                  const widgetLabel: Record<WidgetType, string> = {
                    audio: "Audio Transcript",
                    chat: "Chat Pulse",
                    visual: "Visual Snapshot",
                    memory: "Long-Term Memory",
                    stream: "Stream Embed",
                  };
                  const widgetBorder: Record<WidgetType, string> = {
                    audio: "border-purple-500/20",
                    chat: "border-teal-500/20",
                    visual: "border-orange-500/20",
                    memory: "border-blue-500/20",
                    stream: "border-[#9146FF]/20",
                  };
                  return (
                    <div key={widget} className={`bg-[#0F0F12] border ${widgetBorder[widget]} rounded-xl overflow-hidden flex flex-col`}>
                      <div className="flex items-center px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                          {widgetIcon[widget]} {widgetLabel[widget]}
                        </span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-3 min-h-0 forge-scroll">
                        {renderWidgetContent(widget)}
                      </div>
                    </div>
                  );
                })}
                {variants.length > 0 && (
                  <div className="flex flex-col items-center gap-1 py-4 pb-8">
                    <FidgetSpinner size={48} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom Tab Bar */}
          <div className="mobile-tab-bar" role="tablist" aria-label="Main navigation">
            <button
              role="tab"
              aria-selected={mobileTab === "context"}
              data-active={mobileTab === "context"}
              onClick={() => setMobileTab("context")}
              className="touch-target"
            >
              <Brain className="w-5 h-5" />
              <span>Context</span>
            </button>
            <button
              role="tab"
              aria-selected={mobileTab === "forge"}
              data-active={mobileTab === "forge"}
              onClick={() => setMobileTab("forge")}
              className="touch-target"
            >
              <Zap className="w-5 h-5" />
              <span>Forge</span>
            </button>
            <button
              role="tab"
              aria-selected={mobileTab === "tuning"}
              data-active={mobileTab === "tuning"}
              onClick={() => setMobileTab("tuning")}
              className="touch-target"
            >
              <Sparkles className="w-5 h-5" />
              <span>Tuning</span>
            </button>
          </div>
        </div>
      ) : (
      <>
      <div className="flex h-full w-full overflow-hidden bg-transparent relative z-10">
        <ResizablePanelGroup
          key={`left-${leftCollapsed}`}
          direction="horizontal"
          className="w-full h-full rounded-none forge-panel-group"
        >
            {/* Left Rail: Context Fusion */}
            <ResizablePanel
              ref={leftPanelRef}
              id="left-rail"
              order={1}
              minSize={leftCollapsed ? "2.5%" : "16%"}
              maxSize={leftCollapsed ? "8%" : "27.6%"}
              defaultSize={leftCollapsed ? `${leftCollapsedSize}%` : `${leftPanelSize}%`}
              onResize={(size) => {
                // Only persist to localStorage — do NOT update React state here.
                // Updating state would change defaultSize, which re-registers
                // the panel in react-resizable-panels v4 and fights the drag.
                const percentage = typeof size === "number" ? size : size.asPercentage;
                lastLeftResizeRef.current = percentage;
                if (leftCollapsed) {
                  localStorage.setItem("forge-panel-left-collapsed-size", percentage.toString());
                } else {
                  localStorage.setItem("forge-panel-left-expanded-size", percentage.toString());
                }
              }}
              className="bg-[#121217] z-20 shadow-[4px_0_24px_rgba(0,0,0,0.5)] relative overflow-visible"
            >
              {leftCollapsed ? (
                /* Collapsed Icon Bar with Widget Flyouts */
                <div
                  ref={(node) => { iconBarRef.current = node; collapsedWidthRef.current = node; }}
                  className="h-full w-full flex flex-col items-center justify-between bg-[#121217]/95 relative"
                  style={{ paddingTop: `${12 * iconScale}px`, paddingBottom: `${12 * iconScale}px` }}
                  role="toolbar"
                  aria-label="Context Fusion controls"
                  aria-orientation="vertical"
                >
                  <div className="flex flex-col items-center w-full" style={{ gap: `${12 * iconScale}px` }}>
                    {/* Expand Trigger */}
                    <Tooltip>
                      <TooltipTrigger
                        render={(props) => (
                          <button
                            {...props}
                            type="button"
                            style={{ width: `${34 * iconScale}px`, height: `${34 * iconScale}px` }}
                            className={buttonVariants({ variant: "ghost", size: "icon", className: "rounded-lg bg-white/5 hover:bg-orange-500/20 text-orange-400 focus-visible:ring-2 focus-visible:ring-orange-500/60 focus-visible:outline-none" })}
                            onClick={(e) => {
                              props.onClick?.(e);
                              togglePanel();
                            }}
                            aria-label="Expand Context Rail (Ctrl+B)"
                          >
                            <ChevronRight style={{ width: `${24 * iconScale}px`, height: `${24 * iconScale}px` }} />
                          </button>
                        )}
                      />
                      <TooltipContent side="right">Expand Context Rail · Ctrl+B</TooltipContent>
                    </Tooltip>

                    <div className="w-full border-b border-white/5" />

                    {/* Reorderable Widget Icons — drag to rearrange */}
                    {iconOrder.map((widget, i) => {
                      const colorClass: Record<WidgetType, string> = {
                        audio: "text-purple-400",
                        chat: "text-teal-400",
                        visual: "text-orange-400",
                        memory: "text-blue-400",
                        stream: "text-[#9146FF]",
                      };
                      const ringClass: Record<WidgetType, string> = {
                        audio: "focus-visible:ring-purple-500/60",
                        chat: "focus-visible:ring-teal-500/60",
                        visual: "focus-visible:ring-orange-500/60",
                        memory: "focus-visible:ring-blue-500/60",
                        stream: "focus-visible:ring-[#9146FF]/60",
                      };
                      const activeBg: Record<WidgetType, string> = {
                        audio: "bg-purple-500/30 ring-1 ring-purple-500/50",
                        chat: "bg-teal-500/30 ring-1 ring-teal-500/50",
                        visual: "bg-orange-500/30 ring-1 ring-orange-500/50",
                        memory: "bg-blue-500/30 ring-1 ring-blue-500/50",
                        stream: "bg-[#9146FF]/30 ring-1 ring-[#9146FF]/50",
                      };
                      const inactiveBg: Record<WidgetType, string> = {
                        audio: "bg-purple-500/10 hover:bg-purple-500/20",
                        chat: "bg-teal-500/10 hover:bg-teal-500/20",
                        visual: "bg-orange-500/10 hover:bg-orange-500/20",
                        memory: "bg-blue-500/10 hover:bg-blue-500/20",
                        stream: "bg-[#9146FF]/10 hover:bg-[#9146FF]/20",
                      };
                      const iconLabel: Record<WidgetType, string> = {
                        audio: "Audio Transcript Sync",
                        chat: "Chat Stream Pulse",
                        visual: "Visual Snapshot Analysis",
                        memory: "Long-Term Memory",
                        stream: "Stream Embed",
                      };
                      const tooltipTheme: Record<WidgetType, string> = {
                        audio: "bg-[#1a1a1f] border-purple-500/30 text-purple-300",
                        chat: "bg-[#1a1a1f] border-teal-500/30 text-teal-300",
                        visual: "bg-[#1a1a1f] border-orange-500/30 text-orange-300",
                        memory: "bg-[#1a1a1f] border-blue-500/30 text-blue-300",
                        stream: "bg-[#1a1a1f] border-[#9146FF]/30 text-[#9146FF]",
                      };
                      const iconEl: Record<WidgetType, React.ReactNode> = {
                        audio: <AudioLines style={{ width: `${24 * iconScale}px`, height: `${24 * iconScale}px` }} className="animate-pulse" />,
                        chat: <MessageSquare style={{ width: `${24 * iconScale}px`, height: `${24 * iconScale}px` }} />,
                        visual: <Eye style={{ width: `${24 * iconScale}px`, height: `${24 * iconScale}px` }} />,
                        memory: <Brain style={{ width: `${24 * iconScale}px`, height: `${24 * iconScale}px` }} />,
                        stream: <Tv style={{ width: `${24 * iconScale}px`, height: `${24 * iconScale}px` }} />,
                      };

                      let badge: React.ReactNode = null;
                      if (widget === "chat" && chatUnreadCount > 0) {
                        const unread = chatUnreadCount;
                        const display = unread > 99 ? "99+" : String(unread);
                        const badgeColor = unread >= 50 ? "bg-red-500" : unread >= 30 ? "bg-orange-500" : unread >= 10 ? "bg-yellow-500" : "bg-teal-500";
                        const badgeSize = unread > 99 ? "min-w-[22px] h-[22px]" : unread >= 10 ? "min-w-[20px] h-[20px]" : "min-w-[18px] h-[18px]";
                        const badgeFont = unread > 99 ? 9 : unread >= 10 ? 9 : 10;
                        badge = (
                          <span className={`absolute -top-1.5 -right-1.5 ${badgeColor} text-white font-bold rounded-full ${badgeSize} flex items-center justify-center px-1 shadow-lg ring-1 ring-black/30`} style={{ fontSize: `${badgeFont * iconScale}px` }}>
                            {display}
                          </span>
                        );
                      } else if (widget === "visual" && visualSnapshotUrl) {
                        badge = <span className="absolute -top-1 -right-1 bg-orange-500 text-white rounded-full min-w-[8px] h-[8px]" />;
                      } else if (widget === "memory" && pinnedMemories.length > 0) {
                        const count = pinnedMemories.length;
                        const display = count > 99 ? "99+" : String(count);
                        const badgeSize = count > 99 ? "min-w-[22px] h-[22px]" : count >= 10 ? "min-w-[20px] h-[20px]" : "min-w-[18px] h-[18px]";
                        const badgeFont = count > 99 ? 9 : count >= 10 ? 9 : 10;
                        badge = (
                          <span className={`absolute -top-1.5 -right-1.5 bg-blue-500 text-white font-bold rounded-full ${badgeSize} flex items-center justify-center px-1 shadow-lg ring-1 ring-black/30`} style={{ fontSize: `${badgeFont * iconScale}px` }}>
                            {display}
                          </span>
                        );
                      }

                      const isDraggingThis = draggingIcon === widget;
                      const showDropBefore = draggingIcon !== null && dragOverIndex === i && draggingIcon !== widget;

                      return (
                        <React.Fragment key={widget}>
                          {showDropBefore && (
                            <div className="icon-drop-indicator" style={{ height: `${3 * iconScale}px` }} />
                          )}
                          <Tooltip>
                            <TooltipTrigger
                              render={(props) => (
                                <button
                                  {...props}
                                  ref={(el) => { iconRefs.current[widget] = el; if (typeof props.ref === 'function') props.ref(el); }}
                                  type="button"
                                  onMouseDown={(e) => {
                                    props.onMouseDown?.(e);
                                    onIconMouseDown(e, widget);
                                  }}
                                  onClick={(e) => {
                                    props.onClick?.(e);
                                    onIconClick(widget);
                                  }}
                                  style={{ width: `${40 * iconScale}px`, height: `${40 * iconScale}px` }}
                                  className={`relative rounded-lg flex items-center justify-center ${colorClass[widget]} cursor-default active:cursor-default transition-all focus-visible:ring-2 ${ringClass[widget]} focus-visible:outline-none ${openWidgets.has(widget) ? activeBg[widget] : inactiveBg[widget]} ${isDraggingThis ? "icon-dragging" : ""} ${widget === "visual" && visualAutoFlash ? "visual-auto-flash" : ""} ${widget === "visual" && visualManualFlash ? "visual-manual-flash" : ""} ${widget === "stream" && tabCaptureMode && windowSelected && !openWidgets.has("stream") ? "stream-capture-warning" : ""}`}
                                  aria-label={iconLabel[widget]}
                                  aria-pressed={openWidgets.has(widget)}
                                >
                                  {iconEl[widget]}
                                  {badge}
                                  {widget === "chat" && chatActivity > 0 && (
                                    <span className="absolute inset-0 rounded-lg pointer-events-none overflow-hidden">
                                      {chatActivity >= 1 && (
                                        <span
                                          className="absolute inset-0 rounded-lg"
                                          style={{
                                            boxShadow: `inset 0 0 ${4 + chatActivity * 3}px rgba(20,184,166,${0.15 + chatActivity * 0.1})`,
                                          }}
                                        />
                                      )}
                                      {chatActivity >= 2 && (
                                        <span className="absolute inset-0 rounded-lg border border-teal-400/30 chat-pulse-ring" />
                                      )}
                                      {chatActivity >= 3 && (
                                        <span className="absolute inset-0 rounded-lg border border-teal-400/40 chat-pulse-ring" style={{ animationDelay: "0.5s" }} />
                                      )}
                                      {chatActivity >= 4 && (
                                        <>
                                          <span className="absolute inset-0 rounded-lg border border-teal-300/50 chat-pulse-ring" style={{ animationDelay: "1s" }} />
                                          <span className="absolute -top-0.5 -left-0.5 w-1.5 h-1.5 rounded-full bg-teal-400 chat-spark" />
                                          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-teal-400 chat-spark" style={{ animationDelay: "0.3s" }} />
                                          <span className="absolute -bottom-0.5 -left-0.5 w-1.5 h-1.5 rounded-full bg-teal-400 chat-spark" style={{ animationDelay: "0.6s" }} />
                                          <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-teal-400 chat-spark" style={{ animationDelay: "0.9s" }} />
                                        </>
                                      )}
                                    </span>
                                  )}
                                </button>
                              )}
                            />
                            <TooltipContent side="right" className={`${tooltipTheme[widget]} text-[11px] font-semibold rounded-lg px-3 py-1.5 shadow-xl`}>
                              {iconLabel[widget]}
                            </TooltipContent>
                          </Tooltip>
                        </React.Fragment>
                      );
                    })}
                    {draggingIcon !== null && dragOverIndex === iconOrder.length && (
                      <div className="icon-drop-indicator" style={{ height: `${3 * iconScale}px` }} />
                    )}
                  </div>

                  {/* Fidget Spinner — hidden when mega spinner is showing in center empty state */}
                  {variants.length > 0 && (
                  <ThemedTooltip content="Fidget Spinner — drag to flick, click to boost, hold center to charge & lock">
                    <div className="flex flex-col items-center gap-1 pb-6">
                      <FidgetSpinner size={Math.max(36, 47 * iconScale)} />
                    </div>
                  </ThemedTooltip>
                  )}
                </div>
              ) : (
                /* Expanded Context Rail — 4 widget panels stacked vertically */
                <div ref={leftRailDomRef} className="h-full w-full relative flex flex-col">
                  {/* Collapse button — portaled to body to escape panel overflow clipping */}
                  <CollapseButtonPortal targetRef={leftRailDomRef} onClick={togglePanel} />

                  {/* Stacked widget panels — scrollable */}
                  <div className="flex-1 overflow-y-auto p-3 pb-8 space-y-3 min-h-0 forge-scroll-main select-text w-full">
                    {iconOrder.map((widget, idx) => {
                      const isStreamFirst = widget === "stream" && idx === 0;
                      const isStreamLast = widget === "stream" && idx === iconOrder.length - 1;
                      const widgetIcon: Record<WidgetType, React.ReactNode> = {
                        audio: <AudioLines className="w-3.5 h-3.5 text-purple-400" />,
                        chat: <MessageSquare className="w-3.5 h-3.5 text-teal-400" />,
                        visual: <Eye className="w-3.5 h-3.5 text-orange-400" />,
                        memory: <Brain className="w-3.5 h-3.5 text-blue-400" />,
                        stream: <Tv className="w-3.5 h-3.5 text-[#9146FF]" />,
                      };
                      const widgetLabel: Record<WidgetType, string> = {
                        audio: "Audio Transcript",
                        chat: "Chat Pulse",
                        visual: "Visual Snapshot",
                        memory: "Long-Term Memory",
                        stream: "Stream Embed",
                      };
                      const widgetBorder: Record<WidgetType, string> = {
                        audio: "border-purple-500/20",
                        chat: "border-teal-500/20",
                        visual: "border-orange-500/20",
                        memory: "border-blue-500/20",
                        stream: "border-[#9146FF]/20",
                      };
                      return (
                        <React.Fragment key={widget}>
                        <div data-tutorial={`${widget}-widget`} className={`bg-[#0F0F12] border ${widgetBorder[widget]} rounded-xl overflow-hidden flex flex-col ${isStreamFirst ? 'sticky top-0 z-20 shadow-2xl' : isStreamLast ? 'sticky bottom-0 z-20 shadow-2xl' : ''}`}>
                          <div className="flex items-center px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                            <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                              {widgetIcon[widget]} {widgetLabel[widget]}
                            </span>
                            {widget === "chat" && (
                              <ThemedTooltip content={chatAnchored ? "Anchored to bottom (click to release)" : "Free scroll (click to anchor)"}>
                                <button
                                  type="button"
                                  onClick={() => setChatAnchored(!chatAnchored)}
                                  className={`ml-auto h-6 w-6 flex items-center justify-center rounded-md transition-all focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none ${chatAnchored ? "text-teal-400 bg-teal-500/15 hover:bg-teal-500/25" : "text-gray-600 hover:text-gray-400 hover:bg-white/5"}`}
                                  aria-label={chatAnchored ? "Unanchor chat scroll" : "Anchor chat scroll"}
                                >
                                  <Anchor className="w-3.5 h-3.5" />
                                </button>
                              </ThemedTooltip>
                            )}
                            {widget === "audio" && (
                              <ThemedTooltip content={audioAnchored ? "Anchored to bottom (click to release)" : "Free scroll (click to anchor)"}>
                                <button
                                  type="button"
                                  onClick={() => setAudioAnchored(!audioAnchored)}
                                  className={`ml-auto h-6 w-6 flex items-center justify-center rounded-md transition-all focus-visible:ring-2 focus-visible:ring-purple-500/40 focus-visible:outline-none ${audioAnchored ? "text-purple-400 bg-purple-500/15 hover:bg-purple-500/25" : "text-gray-600 hover:text-gray-400 hover:bg-white/5"}`}
                                  aria-label={audioAnchored ? "Unanchor audio scroll" : "Anchor audio scroll"}
                                >
                                  <Anchor className="w-3.5 h-3.5" />
                                </button>
                              </ThemedTooltip>
                            )}
                            {widget === "stream" && streamMetadata?.channelName && (
                              <ThemedTooltip content={sidebarChatOpen ? "Hide chat input" : "Show chat input"}>
                                <button
                                  type="button"
                                  onClick={() => setSidebarChatOpen(!sidebarChatOpen)}
                                  className={`ml-auto h-6 px-2 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${sidebarChatOpen ? "text-rose-400 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30" : "text-emerald-400 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30"}`}
                                >
                                  <MessageCircle className="w-3 h-3" />
                                  {sidebarChatOpen ? "Hide" : "Chat"}
                                </button>
                              </ThemedTooltip>
                            )}
                            {widget === "visual" && (
                              <div className="ml-auto flex items-center gap-1.5">
                                <Tooltip>
                                  <TooltipTrigger render={
                                    <button
                                      type="button"
                                      onClick={cycleSmartLevel}
                                      className={cn(
                                        "h-6 px-2 flex items-center gap-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all focus-visible:ring-2 focus-visible:outline-none",
                                        smartLevel === 0 && "text-gray-600 hover:text-gray-400 hover:bg-white/5",
                                        smartLevel === 1 && "text-cyan-400 bg-cyan-500/15 hover:bg-cyan-500/25 focus-visible:ring-cyan-500/40",
                                        smartLevel === 2 && "text-blue-400 bg-blue-500/15 hover:bg-blue-500/25 focus-visible:ring-blue-500/40",
                                        smartLevel === 3 && "text-violet-400 bg-violet-500/15 hover:bg-violet-500/25 focus-visible:ring-violet-500/40"
                                      )}
                                    >
                                      <Sparkles className="w-3 h-3" />
                                      {smartLevel > 0 && SMART_LEVELS[smartLevel].name.toUpperCase()}
                                    </button>
                                  } />
                                  <TooltipContent
                                    side="bottom"
                                    align="center"
                                    sideOffset={6}
                                    className="max-w-xs p-0 bg-[#1a1a22] border border-white/10 text-left rounded-lg shadow-2xl"
                                  >
                                    <div className="p-3 space-y-2">
                                      <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                                        <Sparkles className={cn("w-3 h-3", smartLevel === 1 && "text-cyan-400", smartLevel === 2 && "text-blue-400", smartLevel === 3 && "text-violet-400", smartLevel === 0 && "text-gray-500")} />
                                        <span className={cn("text-[11px] font-bold uppercase font-mono tracking-wider", smartLevel === 1 && "text-cyan-300", smartLevel === 2 && "text-blue-300", smartLevel === 3 && "text-violet-300", smartLevel === 0 && "text-gray-400")}>
                                          Smart Capture — {SMART_LEVELS[smartLevel].name}
                                        </span>
                                      </div>
                                      <p className="text-[11px] leading-relaxed text-gray-300">{SMART_LEVELS[smartLevel].desc}</p>
                                      <div className="flex items-center justify-between text-[10px] text-gray-500">
                                        <span>Click to cycle: Off → Light → Balanced → Aggressive</span>
                                      </div>
                                      {smartLevel > 0 && (
                                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 pt-1 border-t border-white/5">
                                          <span className="font-mono">
                                            Range: {SMART_LEVELS[smartLevel].minInt}s–{SMART_LEVELS[smartLevel].maxInt}s
                                          </span>
                                          <span className="text-gray-600">·</span>
                                          <span className="font-mono">
                                            ×{SMART_LEVELS[smartLevel].fastMult} fast / ×{SMART_LEVELS[smartLevel].slowMult} slow
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger render={
                                    <button
                                      type="button"
                                      onClick={() => setVisualAutoCapture(!visualAutoCapture)}
                                      disabled={smartCapture}
                                      className={cn(
                                        "h-6 px-2 flex items-center gap-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all focus-visible:ring-2 focus-visible:ring-orange-500/40 focus-visible:outline-none",
                                        smartCapture
                                          ? "text-gray-700 bg-white/5 cursor-not-allowed opacity-50"
                                          : visualAutoCapture
                                            ? "text-orange-400 bg-orange-500/15 hover:bg-orange-500/25"
                                            : "text-gray-600 hover:text-gray-400 hover:bg-white/5"
                                      )}
                                      aria-label={visualAutoCapture ? "Disable auto-capture" : "Enable auto-capture"}
                                    >
                                      {visualAutoCapture ? <Zap className="w-3 h-3" /> : <CirclePause className="w-3 h-3" />}
                                      {visualAutoCapture ? "AUTO" : "OFF"}
                                    </button>
                                  } />
                                  <TooltipContent
                                    side="bottom"
                                    align="center"
                                    sideOffset={6}
                                    className="max-w-xs p-0 bg-[#1a1a22] border border-white/10 text-left rounded-lg shadow-2xl"
                                  >
                                    <div className="p-3 space-y-2">
                                      <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                                        {smartCapture ? (
                                          <Lock className="w-3 h-3 text-gray-500" />
                                        ) : visualAutoCapture ? (
                                          <Zap className="w-3 h-3 text-orange-400" />
                                        ) : (
                                          <CirclePause className="w-3 h-3 text-gray-500" />
                                        )}
                                        <span className={cn(
                                          "text-[11px] font-bold uppercase font-mono tracking-wider",
                                          smartCapture ? "text-gray-400" : visualAutoCapture ? "text-orange-300" : "text-gray-400"
                                        )}>
                                          {smartCapture ? "Auto-Capture — Locked" : visualAutoCapture ? "Auto-Capture — Active" : "Auto-Capture — Off"}
                                        </span>
                                      </div>
                                      {smartCapture ? (
                                        <p className="text-[11px] leading-relaxed text-gray-400">
                                          Smart mode is managing capture timing. Disable Smart mode to manually control auto-capture.
                                        </p>
                                      ) : visualAutoCapture ? (
                                        <p className="text-[11px] leading-relaxed text-gray-300">
                                          Snapshots are captured automatically every <span className="font-mono text-orange-300">{visualCaptureInterval}s</span>. The Forge uses these to understand what's happening on screen.
                                        </p>
                                      ) : (
                                        <p className="text-[11px] leading-relaxed text-gray-300">
                                          Click to start capturing visual snapshots automatically at a fixed interval. You can adjust the interval (2–120s) in the field next to this button.
                                        </p>
                                      )}
                                      {!smartCapture && (
                                        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 pt-1 border-t border-white/5">
                                          <span>Click to {visualAutoCapture ? "disable" : "enable"}</span>
                                          <span className="text-gray-600">·</span>
                                          <span className="font-mono">Interval: {visualAutoCapture ? `${visualCaptureInterval}s` : "—"}</span>
                                        </div>
                                      )}
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                                <div className="flex items-center gap-1">
                                  <ThemedTooltip content={smartCapture ? "Interval managed by Smart mode" : "Auto-capture interval (2-120 seconds)"}>
                                    <input
                                      type="number"
                                      min={2}
                                      max={120}
                                      value={visualCaptureInterval}
                                      disabled={!visualAutoCapture || smartCapture}
                                      onChange={(e) => {
                                        const v = parseInt(e.target.value);
                                        if (!isNaN(v)) setVisualCaptureInterval(Math.max(2, Math.min(120, v)));
                                      }}
                                      className={`w-12 h-6 bg-black/40 border border-white/10 rounded-md text-[10px] font-bold text-center outline-none transition-colors ${visualAutoCapture && !smartCapture ? "text-gray-400 focus:border-orange-500/50" : "text-gray-600 cursor-not-allowed opacity-50"}`}
                                    />
                                  </ThemedTooltip>
                                  <span className="text-[9px] text-gray-500 font-bold">s</span>
                                </div>
                              </div>
                            )}
                            {widget === "memory" && (
                              <div className="ml-auto flex items-center gap-1">
                                <ThemedTooltip content="Export memories as JSON">
                                  <button
                                    type="button"
                                    onClick={handleExportMemories}
                                    disabled={pinnedMemories.length === 0}
                                    className="h-6 w-6 flex items-center justify-center rounded-md text-[10px] font-bold uppercase tracking-wider transition-all focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:outline-none text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                                    aria-label="Export memories"
                                  >
                                    <Download className="w-3 h-3" />
                                  </button>
                                </ThemedTooltip>
                                <ThemedTooltip content="Import memories from JSON">
                                  <label
                                    className="h-6 w-6 flex items-center justify-center rounded-md text-[10px] font-bold uppercase tracking-wider transition-all focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:outline-none text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 cursor-pointer"
                                  >
                                    <Upload className="w-3 h-3" />
                                    <input type="file" accept=".json" className="hidden" onChange={handleImportMemories} />
                                  </label>
                                </ThemedTooltip>
                                <ThemedTooltip content={memoryClearConfirm ? "Click again to confirm — erases all memories" : "Clear all memories"}>
                                  <button
                                    type="button"
                                    onClick={handleClearMemories}
                                    disabled={pinnedMemories.length === 0}
                                    className={`h-6 px-2 flex items-center gap-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:outline-none ${pinnedMemories.length === 0 ? "text-gray-700 cursor-not-allowed" : memoryClearConfirm ? "text-red-300 bg-red-500/20 hover:bg-red-500/30 animate-pulse" : "text-gray-500 hover:text-red-400 hover:bg-red-500/10"}`}
                                    aria-label="Clear all memories"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    {memoryClearConfirm ? "Confirm?" : "Clear"}
                                  </button>
                                </ThemedTooltip>
                              </div>
                            )}
                          </div>
                          {widget === "audio" ? (
                            <div ref={expandedAudioRef} className="p-3 min-h-0 overflow-y-auto forge-scroll-audio" style={{ maxHeight: '195px' }}>
                              {renderWidgetContent(widget)}
                            </div>
                          ) : widget === "chat" ? (
                            <div ref={expandedChatRef} className="p-3 min-h-0 overflow-hidden flex flex-col" style={{ height: `330px` }}>
                              {renderWidgetContent(widget)}
                            </div>
                          ) : widget === "memory" ? (
                            <div className="px-2 py-1 min-h-0 overflow-y-auto forge-scroll" style={{ height: '150px' }}>
                              {renderWidgetContent(widget)}
                            </div>
                          ) : widget === "stream" ? (
                            <div className="min-h-0 w-full" style={{ aspectRatio: '16 / 9' }}>
                              {renderWidgetContent(widget, true)}
                            </div>
                          ) : (
                            <div className="p-3 min-h-0">
                              {renderWidgetContent(widget)}
                            </div>
                          )}
                        </div>
                        {widget === "stream" && sidebarChatOpen && streamMetadata?.channelName && (
                          <div className="bg-[#0F0F12] border border-teal-500/20 rounded-xl overflow-hidden flex flex-col mt-3 shrink-0">
                            <div className="flex items-center px-3 py-2 border-b border-white/5 bg-white/[0.02] shrink-0">
                              <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
                                <MessageCircle className="w-3.5 h-3.5 text-teal-400" /> Chat Input
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#121217]/90">
                              <input
                                type="text"
                                value={sidebarChatMsg}
                                onChange={(e) => setSidebarChatMsg(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSidebarChatSend(); } }}
                                placeholder="Send a message to chat..."
                                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-teal-500/40 focus:bg-white/[0.07] transition-all"
                                disabled={sidebarChatSending}
                              />
                              <ThemedTooltip content="Send message">
                                <button
                                  type="button"
                                  onClick={handleSidebarChatSend}
                                  disabled={sidebarChatSending || !sidebarChatMsg.trim()}
                                  className="h-7 w-7 flex items-center justify-center rounded-lg text-teal-400 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 hover:border-teal-500/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                </button>
                              </ThemedTooltip>
                            </div>
                          </div>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              )}
            </ResizablePanel>

            <ResizableHandle
              className="w-2.5 forge-panel-handle hover:bg-orange-500/50 hover:w-3 transition-all z-40"
              withHandle
              onDoubleClick={() => {
                // Reset left panel to its default width for the current mode
                const defaultLeft = leftCollapsed ? 3 : 18;
                if (leftCollapsed) {
                  setLeftCollapsedSize(defaultLeft);
                  localStorage.setItem("forge-panel-left-collapsed-size", defaultLeft.toString());
                } else {
                  setLeftPanelSize(defaultLeft);
                  localStorage.setItem("forge-panel-left-expanded-size", defaultLeft.toString());
                }
                if (leftPanelRef.current) {
                  try { leftPanelRef.current.resize(`${defaultLeft}%`); } catch {}
                }
                playSfx('slider_commit');
              }}
              onDragging={(isDragging) => {
                panelDragActiveRef.current = isDragging;
                if (!isDragging) {
                  lastLeftResizeRef.current = null;
                  // Sync React state from localStorage after drag ends so the
                  // state stays consistent for the next mount (e.g. after
                  // collapse/expand toggles which remount the group via key).
                  if (leftCollapsed) {
                    const saved = localStorage.getItem("forge-panel-left-collapsed-size");
                    if (saved) setLeftCollapsedSize(parseFloat(saved));
                  } else {
                    const saved = localStorage.getItem("forge-panel-left-expanded-size");
                    if (saved) setLeftPanelSize(parseFloat(saved));
                  }
                }
              }}
            />

            {/* Center Area: The Forge */}
            <ResizablePanel
              id="center-area"
              order={2}
              minSize="5%"
              defaultSize={`${Math.max(5, 100 - (leftCollapsed ? leftCollapsedSize : leftPanelSize) - rightSize)}%`}
              className="bg-transparent z-10 relative"
            >
              {/* Gold hexagon background with golden sparkles */}
              <div className="forge-hex-bg" aria-hidden="true">
                <div className="forge-hex-sparkles" aria-hidden="true" />
              </div>
              <div className="flex flex-col h-full overflow-x-hidden relative z-10">
                {/* Top-Center Frame: Compact Header — Logo left, Stream Info center, Login right */}
                <div data-tutorial="command-palette" className="shrink-0 h-[42px] border-b border-white/5 bg-[#121217]/90 backdrop-blur-md px-3 flex items-center justify-between gap-3 z-40 relative overflow-visible">
                  {/* Far-Left: MADchatter Logo */}
                  <div className="flex items-center shrink-0" style={{ overflow: 'visible' }}>
                    <div className="forge-header-aura" />
                    <img
                      src={logoUrl}
                      alt="MADchatter"
                      className="relative z-10 h-[81px] w-auto forge-logo-glow cursor-pointer select-none"
                      style={{
                        opacity: 0.8,
                        marginTop: '42px',
                      }}
                      onClick={() => {
                        const now = Date.now();
                        logoClickTimesRef.current = logoClickTimesRef.current.filter(
                          (t) => now - t < 3000,
                        );
                        logoClickTimesRef.current.push(now);
                        if (logoClickTimesRef.current.length >= 7) {
                          logoClickTimesRef.current = [];
                          window.dispatchEvent(new CustomEvent('easter-egg-secret-lab'));
                        }
                      }}
                    />
                  </div>

                  {/* Center: LIVE Status + Channel + Title + Viewers */}
                  <div className="flex-1 flex items-center justify-center gap-2.5 min-w-0">
                    {/* LIVE / OFFLINE badge */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {streamMetadata?.channelName ? (
                        <>
                          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
                          <span className="font-black text-red-400 uppercase font-mono tracking-widest text-xs">
                            LIVE
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="w-2.5 h-2.5 rounded-full bg-gray-600" />
                          <span className="font-black text-gray-500 uppercase font-mono tracking-widest text-xs">
                            OFFLINE
                          </span>
                        </>
                      )}
                    </div>

                    <span className="text-gray-600 shrink-0 font-mono">|</span>

                    {/* Channel name */}
                    <div className="flex items-center gap-1 shrink-0 font-bold text-orange-400 text-sm">
                      {editingChannel ? (
                        <input
                          ref={channelInputRef}
                          type="text"
                          value={channelInput}
                          onChange={(e) => setChannelInput(e.target.value)}
                          onBlur={commitChannel}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitChannel();
                            if (e.key === "Escape") setEditingChannel(false);
                          }}
                          className="bg-black/60 border border-orange-500/50 rounded px-1 py-0 text-orange-300 font-bold text-sm outline-none focus:border-orange-400 w-28"
                          placeholder="sodapoppin"
                        />
                      ) : (
                        <ThemedTooltip content="Click to change channel">
                          <button
                            type="button"
                            onClick={startEditingChannel}
                            data-tutorial="channel"
                            className="hover:text-orange-300 transition-colors cursor-pointer text-sm"
                          >
                            @{streamMetadata?.channelName || "sodapoppin"}
                          </button>
                        </ThemedTooltip>
                      )}
                    </div>

                    <span className="text-gray-600 shrink-0">•</span>

                    {/* Title marquee */}
                    <div className="title-marquee-wrap flex items-center gap-1 text-gray-300 max-w-[300px] overflow-hidden">
                      <div className="overflow-hidden flex-1">
                        <span className="inline-block whitespace-nowrap title-marquee text-sm font-medium">
                          {(streamMetadata?.channelName ? (streamMetadata?.title || "Late night gaming variety!") : offlineTitle)}&nbsp;||&nbsp;{(streamMetadata?.channelName ? (streamMetadata?.title || "Late night gaming variety!") : offlineTitle)}&nbsp;||&nbsp;
                        </span>
                      </div>
                    </div>

                    <span className="text-gray-600 shrink-0">•</span>

                    {/* Viewer count */}
                    <div className="flex items-center gap-1.5 text-gray-300 shrink-0">
                      <Users className="w-4 h-4 text-orange-500" />
                      <span className="font-bold text-sm">{(streamMetadata?.channelName ? (streamMetadata?.viewerCount || 0) : 0).toLocaleString()}</span>
                      <span className="text-gray-500 text-xs font-medium">viewers</span>
                    </div>
                  </div>

                  {/* Multi-Bot launcher + panel */}
                  <div className="relative shrink-0">
                    <MultiBotButton active={multiBotPanelOpen} onClick={() => setMultiBotPanelOpen((v) => !v)} />
                    <AnimatePresence>
                      {multiBotPanelOpen && (
                        <motion.div
                          key="multibot-panel"
                          className="fixed top-16 right-4 z-50"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18, ease: "easeOut" }}
                        >
                          <MultiBotPanel onClose={() => setMultiBotPanelOpen(false)} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Mode indicator: appears only when multi-bot is actually engaged */}
                  <MultiBotModeBadge />

                  {/* Far-Right: Platform Login */}
                  <div className="flex items-center gap-2 shrink-0 relative">
                    {/* CosmoTech Theme Toggle */}
                    <span data-tutorial="cosmotech" className="inline-flex">
                    <Tooltip>
                      <TooltipTrigger
                        render={(props) => (
                          <button
                            {...props}
                            type="button"
                            onClick={() => {
                              const s = useAppStore.getState();
                              // If Urz light theme is active, turn it off and cycle normally
                              if (s.lightThemeActive) {
                                s.setLightThemeActive(false);
                              }
                              const themes: ("default" | "cosmotech" | "corrupture")[] = ["default", "cosmotech", "corrupture"];
                              const currentIdx = themes.indexOf(s.theme);
                              const nextTheme = themes[(currentIdx + 1) % themes.length];
                              s.setTheme(nextTheme);
                              const themeName = nextTheme === "default" ? "Default" : nextTheme === "cosmotech" ? "CosmoTech™" : "Corrupture™";
                              toast.success(`${themeName} theme enabled`);
                            }}
                            className={cn(
                              "h-7 w-7 flex items-center justify-center rounded-md border transition-all",
                              theme !== "default"
                                ? theme === "corrupture"
                                  ? "bg-amber-500/15 border-amber-400/40 text-amber-300 shadow-[0_0_12px_rgba(201,161,74,0.2)]"
                                  : "bg-cyan-500/15 border-cyan-400/40 text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.2)]"
                                : "bg-black/30 border-white/5 text-gray-600 hover:text-gray-400 hover:border-white/10"
                            )}
                          >
                            <Orbit className={cn("w-3.5 h-3.5", theme !== "default" && "animate-spin-slow")} />
                          </button>
                        )}
                      />
                      <TooltipContent side="bottom">Cycle Theme (Default / CosmoTech™ / Corrupture™)</TooltipContent>
                    </Tooltip>
                    </span>

                    {/* Platform selector tabs */}
                    <div data-tutorial="platform-tabs" className="flex gap-0.5 bg-black/40 rounded border border-white/5 p-0.5">
                      <ThemedTooltip content="Twitch">
                        <button
                          onClick={() => setPlatform('twitch')}
                          className={cn(
                            "px-1.5 py-0.5 text-[8px] font-bold uppercase rounded transition-colors",
                            platform === 'twitch'
                              ? "bg-[#9146FF]/30 text-[#9146FF] border border-[#9146FF]/30"
                              : "text-gray-600 hover:text-gray-400"
                          )}
                        >
                          Twitch
                        </button>
                      </ThemedTooltip>
                      <ThemedTooltip content="Kick">
                        <button
                          onClick={() => setPlatform('kick')}
                          className={cn(
                            "px-1.5 py-0.5 text-[8px] font-bold uppercase rounded transition-colors",
                            platform === 'kick'
                              ? "bg-[#53fc18]/20 text-[#53fc18] border border-[#53fc18]/30"
                              : "text-gray-600 hover:text-gray-400"
                          )}
                        >
                          Kick
                        </button>
                      </ThemedTooltip>
                      <ThemedTooltip content="Joystick">
                        <button
                          onClick={() => setPlatform('joystick')}
                          className={cn(
                            "px-1.5 py-0.5 text-[8px] font-bold uppercase rounded transition-colors",
                            platform === 'joystick'
                              ? "bg-[#FF6B35]/20 text-[#FF6B35] border border-[#FF6B35]/30"
                              : "text-gray-600 hover:text-gray-400"
                          )}
                        >
                          Joystick
                        </button>
                      </ThemedTooltip>
                    </div>

                    {/* Platform logo icon / avatar */}
                    {activeAuthLoading ? (
                      <div className="h-[28px] w-[28px] bg-white/5 animate-pulse rounded" />
                    ) : !activeUser ? (
                      platform === 'kick' ? (
                        <div
                          className="h-[28px] w-[28px] flex items-center justify-center rounded font-black text-[#53fc18] text-sm"
                          style={{ filter: "drop-shadow(0 0 4px rgba(83,252,24,0.5))" }}
                        >
                          K
                        </div>
                      ) : platform === 'joystick' ? (
                        <div
                          className="h-[28px] w-[28px] flex items-center justify-center rounded font-black text-[#FF6B35] text-sm"
                          style={{ filter: "drop-shadow(0 0 4px rgba(255,107,53,0.5))" }}
                        >
                          J
                        </div>
                      ) : (
                        <img
                          src={twitchLogoUrl}
                          alt="Twitch"
                          className="h-[28px] w-[28px]"
                          style={{ filter: "drop-shadow(0 0 4px rgba(145,70,255,0.5))" }}
                        />
                      )
                    ) : platform === 'kick' ? (
                      <div
                        className="h-[28px] w-[28px] rounded-full flex items-center justify-center border border-[#53fc18]/50 font-black text-[#53fc18] text-sm"
                      >
                        {(activeUser.display_name || activeUser.login || activeUser.username || 'K')[0].toUpperCase()}
                      </div>
                    ) : platform === 'joystick' ? (
                      <div
                        className="h-[28px] w-[28px] rounded-full flex items-center justify-center border border-[#FF6B35]/50 font-black text-[#FF6B35] text-sm"
                      >
                        {(activeUser.display_name || activeUser.login || activeUser.username || 'J')[0].toUpperCase()}
                      </div>
                    ) : (
                      <img
                        src={activeUser.profile_image_url || twitchLogoUrl}
                        alt="Twitch"
                        className="h-[28px] w-[28px] rounded-full object-cover border border-[#9146FF]/50"
                      />
                    )}

                    {/* Login button or user info */}
                    {activeAuthLoading ? (
                      <div className="h-7 w-20 bg-white/5 animate-pulse rounded-md border border-white/10" />
                    ) : activeUser ? (
                      <div className={cn(
                        "flex items-center h-7 rounded-md overflow-hidden border shadow-[0_0_10px_rgba(0,0,0,0.1)]",
                        platform === 'kick'
                          ? "bg-[#18181B] border-[#53fc18]/50 shadow-[0_0_10px_rgba(83,252,24,0.1)]"
                          : platform === 'joystick'
                            ? "bg-[#18181B] border-[#FF6B35]/50 shadow-[0_0_10px_rgba(255,107,53,0.1)]"
                            : "bg-[#18181B] border-[#9146FF]/50 shadow-[0_0_10px_rgba(145,70,255,0.1)]"
                      )}>
                        <div className={cn(
                          "flex items-center pl-2 pr-2 h-full border-r",
                          platform === 'kick'
                            ? "bg-[#53fc18]/10 border-[#53fc18]/20"
                            : platform === 'joystick'
                              ? "bg-[#FF6B35]/10 border-[#FF6B35]/20"
                              : "bg-[#9146FF]/10 border-[#9146FF]/20"
                        )}>
                          <UserIcon className={cn("w-3 h-3 mr-1", platform === 'kick' ? "text-[#53fc18]" : platform === 'joystick' ? "text-[#FF6B35]" : "text-[#9146FF]")} />
                          <span className="text-[11px] font-bold tracking-wide text-white truncate max-w-[80px]">
                            @{activeUser.display_name || activeUser.login || activeUser.username}
                          </span>
                        </div>
                        <ThemedTooltip content="Disconnect">
                          <button
                            onClick={activeLogout}
                            className="h-full px-2 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors flex items-center justify-center"
                          >
                            <LogOut className="w-3.5 h-3.5" />
                          </button>
                        </ThemedTooltip>
                      </div>
                    ) : (
                      <button
                        onClick={activeLogin}
                        disabled={activeLoginInProgress}
                        className={cn(
                          "h-7 px-2.5 flex items-center gap-1.5 disabled:opacity-70 disabled:cursor-not-allowed text-white text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors",
                          platform === 'kick'
                            ? "bg-[#53fc18] hover:bg-[#44d014] text-black shadow-[0_0_10px_rgba(83,252,24,0.3)]"
                            : platform === 'joystick'
                              ? "bg-[#FF6B35] hover:bg-[#e55a25] shadow-[0_0_10px_rgba(255,107,53,0.3)]"
                              : "bg-[#9146FF] hover:bg-[#772ce8] shadow-[0_0_10px_rgba(145,70,255,0.3)]"
                        )}
                      >
                        {activeLoginInProgress ? (
                          <>
                            <div className="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            <span>Connecting...</span>
                          </>
                        ) : (
                          <>
                            <LogIn className="w-3 h-3" />
                            <span>Login</span>
                          </>
                        )}
                      </button>
                    )}

                    {/* Login error tooltip */}
                    {activeLoginError && (
                      <div className="absolute top-full right-0 mt-2 w-64 bg-red-950/90 border border-red-500/50 rounded-md p-2 shadow-lg z-50 flex items-start gap-2 backdrop-blur-sm">
                        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <div className="flex-1 text-[11px] text-red-200 leading-snug">
                          {activeLoginError}
                        </div>
                        <button
                          onClick={activeClearLoginError}
                          className="shrink-0 opacity-70 hover:opacity-100 hover:bg-white/10 p-0.5 rounded transition-colors"
                        >
                          <X className="w-3 h-3 text-red-200" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {/* Action Timeline — animated dot timeline of recent events */}
                <ActionTimeline />
                {/* The Forge fills the rest */}
                <div className="flex-1 overflow-hidden">
                  <TheForge />
                </div>
              </div>
              {/* Deffy signature — bottom-right of center panel, pinned to right sidebar edge */}
              <DeffySigLogo />
            </ResizablePanel>

            <ResizableHandle
              className="w-2.5 forge-panel-handle hover:bg-orange-500/50 hover:w-3 transition-all z-40"
              withHandle
              onDoubleClick={() => {
                // Reset right panel to its default width
                const defaultRight = getRightSizeDefault();
                setRightSize(defaultRight);
                localStorage.setItem(RIGHT_SIZE_KEY, defaultRight.toString());
                if (rightPanelRef.current) {
                  try { rightPanelRef.current.resize(`${defaultRight}%`); } catch {}
                }
                playSfx('slider_commit');
              }}
              onDragging={(isDragging) => {
                if (!isDragging) {
                  const saved = localStorage.getItem(RIGHT_SIZE_KEY);
                  if (saved) {
                    const parsed = parseFloat(saved);
                    if (!isNaN(parsed) && parsed > 0 && parsed < 100) setRightSize(parsed);
                  }
                }
              }}
            />

            {/* Right Rail: Tuning Deck + Controls */}
            <ResizablePanel
              ref={rightPanelRef}
              id="right-rail"
              order={3}
              minSize="12%"
              maxSize="45%"
              defaultSize={`${rightSize}%`}
              onResize={(size) => {
                // Only persist to localStorage — do NOT update React state here.
                // Updating state would change defaultSize, which re-registers
                // the panel in react-resizable-panels v4 and fights the drag.
                const percentage = typeof size === "number" ? size : size.asPercentage;
                localStorage.setItem(RIGHT_SIZE_KEY, percentage.toString());
              }}
              className="bg-[#121217] border-l border-white/5 z-20 shadow-[-4px_0_24px_rgba(0,0,0,0.5)]"
            >
              <div className="flex flex-col h-full">
                {/* TuningDeck fills the panel */}
                <div className="flex-1 overflow-hidden">
                  <TuningDeck rightSize={rightSize} />
                </div>
              </div>
            </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Draggable Mini-Widgets — each rendered via portal so they float over everything */}
      {leftCollapsed && Array.from(new Set([...openWidgets, ...closingWidgets])).map((widget: WidgetType) => {
        const pos = widgetPositions[widget] || { top: 100, left: 100 };
        const isDragging = draggingWidget === widget;
        const isClosing = closingWidgets.has(widget);
        const headerIcon = {
          audio: <AudioLines className="w-3.5 h-3.5 text-purple-400" />,
          chat: <MessageSquare className="w-3.5 h-3.5 text-teal-400" />,
          visual: <Eye className="w-3.5 h-3.5 text-orange-400" />,
          memory: <Brain className="w-3.5 h-3.5 text-blue-400" />,
          stream: <Tv className="w-3.5 h-3.5 text-[#9146FF]" />,
        }[widget];
        const headerLabel = {
          audio: "Audio Transcript",
          chat: "Chat Pulse",
          visual: "Visual Snapshot",
          memory: "Long-Term Memory",
          stream: "Stream Embed",
        }[widget];

        const def = widgetDefaultSizes[widget];
        const streamChatBoost = widget === "stream" && streamChatActive ? (platform === 'kick' || platform === 'joystick' ? 44 : 138) : 0;
        const widgetHeight = widget === "chat" || widget === "audio" ? "" : widget === "stream" ? "" : "max-h-[70vh]";
        const widgetStyle = widget === "chat" || widget === "audio" ? { height: `${widget === "chat" ? chatPanelHeight : audioPanelHeight}px`, width: `${def.w}px` } : widget === "stream" ? { width: `${streamOverlaySize.w}px`, height: `${streamOverlaySize.h + 40 + streamChatBoost}px` } : widget === "visual" ? { width: `${def.w}px` } : widget === "memory" ? { width: `${def.w}px` } : undefined;
        const widgetWidth = widget === "stream" ? "" : "";

        return createPortal(
          <div
            key={widget}
            data-widget-panel={widget}
            style={{
              top: pos.top,
              left: pos.left,
              zIndex: isDragging ? 10000 : 9999,
              ...(widgetStyle || {}),
            }}
            className={`fixed ${widgetWidth} ${widgetHeight} bg-[#0F0F12] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden ${isClosing ? "flyout-fade-out" : "flyout-animate"}`}
            role="dialog"
            aria-label={`${headerLabel} widget`}
          >
            {/* Draggable Header */}
            <div
              onMouseDown={(e) => startDrag(e, widget)}
              className="flex items-center justify-between px-3 py-2.5 border-b border-white/5 shrink-0 bg-white/[0.02] cursor-grab active:cursor-grabbing select-none hover:bg-white/[0.04] transition-colors"
            >
              <span className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2 pointer-events-none">
                {headerIcon} {headerLabel}
              </span>
              <div className="flex items-center gap-1">
                {widget === "chat" && (
                  <ThemedTooltip content={chatAnchored ? "Anchored to bottom (click to release)" : "Free scroll (click to anchor)"}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setChatAnchored(!chatAnchored); }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`h-5 w-5 flex items-center justify-center rounded transition-all ${chatAnchored ? "text-teal-400 bg-teal-500/15 hover:bg-teal-500/25" : "text-gray-600 hover:text-gray-400 hover:bg-white/5"}`}
                      aria-label={chatAnchored ? "Unanchor chat scroll" : "Anchor chat scroll"}
                    >
                      <Anchor className="w-3.5 h-3.5" />
                    </button>
                  </ThemedTooltip>
                )}
                {widget === "audio" && (
                  <ThemedTooltip content={audioAnchored ? "Anchored to bottom (click to release)" : "Free scroll (click to anchor)"}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setAudioAnchored(!audioAnchored); }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`h-5 w-5 flex items-center justify-center rounded transition-all ${audioAnchored ? "text-purple-400 bg-purple-500/15 hover:bg-purple-500/25" : "text-gray-600 hover:text-gray-400 hover:bg-white/5"}`}
                      aria-label={audioAnchored ? "Unanchor audio scroll" : "Anchor audio scroll"}
                    >
                      <Anchor className="w-3.5 h-3.5" />
                    </button>
                  </ThemedTooltip>
                )}
                {widget === "visual" && (
                  <>
                    <ThemedTooltip content={`Smart: ${SMART_LEVELS[smartLevel].name} — click to cycle`}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); cycleSmartLevel(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={cn(
                          "h-5 px-1.5 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all",
                          smartLevel === 0 && "text-gray-600 hover:text-gray-400 hover:bg-white/5",
                          smartLevel === 1 && "text-cyan-400 bg-cyan-500/15 hover:bg-cyan-500/25",
                          smartLevel === 2 && "text-blue-400 bg-blue-500/15 hover:bg-blue-500/25",
                          smartLevel === 3 && "text-violet-400 bg-violet-500/15 hover:bg-violet-500/25"
                        )}
                      >
                        <Sparkles className="w-2.5 h-2.5" />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content={smartCapture ? "Managed by Smart mode" : visualAutoCapture ? "Auto-capture ON (click to disable)" : "Auto-capture OFF (click to enable)"}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setVisualAutoCapture(!visualAutoCapture); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        disabled={smartCapture}
                        className={cn(
                          "h-5 px-1.5 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all",
                          smartCapture
                            ? "text-gray-700 bg-white/5 cursor-not-allowed opacity-50"
                            : visualAutoCapture
                              ? "text-orange-400 bg-orange-500/15 hover:bg-orange-500/25"
                              : "text-gray-600 hover:text-gray-400 hover:bg-white/5"
                        )}
                      >
                        {visualAutoCapture ? <Zap className="w-2.5 h-2.5" /> : <CirclePause className="w-2.5 h-2.5" />}
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content={smartCapture ? "Interval managed by Smart mode" : "Auto-capture interval (2-120s)"}>
                      <input
                        type="number"
                        min={2}
                        max={120}
                        value={visualCaptureInterval}
                        disabled={!visualAutoCapture || smartCapture}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          if (!isNaN(v)) setVisualCaptureInterval(Math.max(2, Math.min(120, v)));
                        }}
                        className={`w-10 h-5 bg-black/40 border border-white/10 rounded text-[9px] font-bold text-center outline-none transition-colors ${visualAutoCapture && !smartCapture ? "text-gray-400 focus:border-orange-500/50" : "text-gray-600 cursor-not-allowed opacity-50"}`}
                      />
                    </ThemedTooltip>
                  </>
                )}
                {widget === "memory" && (
                  <div className="flex items-center gap-0.5">
                    <ThemedTooltip content="Export memories as JSON">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleExportMemories(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        disabled={pinnedMemories.length === 0}
                        className="h-5 w-5 flex items-center justify-center rounded text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Download className="w-2.5 h-2.5" />
                      </button>
                    </ThemedTooltip>
                    <ThemedTooltip content="Import memories from JSON">
                      <label
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="h-5 w-5 flex items-center justify-center rounded text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 transition-all cursor-pointer"
                      >
                        <Upload className="w-2.5 h-2.5" />
                        <input type="file" accept=".json" className="hidden" onChange={handleImportMemories} />
                      </label>
                    </ThemedTooltip>
                    <ThemedTooltip content={memoryClearConfirm ? "Click again to confirm — erases all memories" : "Clear all memories"}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleClearMemories(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        disabled={pinnedMemories.length === 0}
                        className={`h-5 px-1.5 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${pinnedMemories.length === 0 ? "text-gray-700 cursor-not-allowed" : memoryClearConfirm ? "text-red-300 bg-red-500/20 hover:bg-red-500/30 animate-pulse" : "text-gray-500 hover:text-red-400 hover:bg-red-500/10"}`}
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                        {memoryClearConfirm ? "Confirm?" : "Clear"}
                      </button>
                    </ThemedTooltip>
                  </div>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleWidget(widget); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="text-gray-500 hover:text-white text-lg leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 transition-all focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none"
                  aria-label="Close widget"
                >
                  ×
                </button>
              </div>
            </div>

            {/* Widget Content */}
            {widget === "audio" ? (
              <>
                <div ref={flyoutAudioRef} className="flex-1 overflow-y-auto p-3 min-h-0 forge-scroll-audio">
                  {renderWidgetContent(widget)}
                </div>
                <div
                  onMouseDown={startAudioResize}
                  className="shrink-0 h-3 cursor-ns-resize bg-white/[0.04] hover:bg-purple-500/50 transition-colors flex items-center justify-center group border-t border-purple-500/10 hover:border-purple-500/40 rounded-b-xl"
                >
                  <div className="h-1.5 w-10 rounded-full bg-white/15 group-hover:bg-purple-400/60 transition-colors" />
                </div>
              </>
            ) : widget === "chat" ? (
              <>
                <div ref={flyoutChatRef} className="flex-1 overflow-hidden overflow-x-hidden p-3 min-h-0 flex flex-col">
                  {renderWidgetContent(widget)}
                </div>
                <div
                  onMouseDown={startChatResize}
                  className="shrink-0 h-3 cursor-ns-resize bg-white/[0.04] hover:bg-teal-500/50 transition-colors flex items-center justify-center group border-t border-teal-500/10 hover:border-teal-500/40 rounded-b-xl"
                >
                  <div className="h-1.5 w-10 rounded-full bg-white/15 group-hover:bg-teal-400/60 transition-colors" />
                </div>
              </>
            ) : widget === "memory" ? (
              <div className="overflow-y-auto p-3 min-h-0 forge-scroll" style={{ height: '180px' }}>
                {renderWidgetContent(widget)}
              </div>
            ) : widget === "stream" ? (
              <div className="flex-1 min-h-0">
                {renderWidgetContent(widget)}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3 min-h-0 forge-scroll">
                {renderWidgetContent(widget)}
              </div>
            )}
          </div>,
          document.body
        );
      })}
      </>
      )}
    </TooltipProvider>
  );
}
