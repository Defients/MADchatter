import React, { useState, useEffect, useRef, useMemo } from "react";
import { useAppStore, selectMultiBotActive } from "../store";
import { useEffectiveMode, useIsMobile } from "../hooks/useMediaQuery";
import { Button } from "./ui/button";
import { VariantCard } from "./VariantCard";
import { toast } from "sonner";
import { generateChat, refineSuggestion, rankVariants } from "../lib/ai";
import { getTwitchSession } from "../lib/twitch";
import { getKickSession } from "../lib/kick";
import { getJoystickSession } from "../lib/joystick";
import { sendManualMessage } from "../lib/manualSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { playSfx } from "../lib/sfx";
import { getActiveProvider, hasAnyApiKey, getProviderWithKey } from "../lib/keys";
import { cn } from "../lib/utils";
import { formatChatLog } from "../lib/chatUtils";
import { retrieveRelevantMemories, formatMemoryContext, formatDirectorNotesContext } from "../lib/memoryRetrieval";
import { getAvailableEmoteNames } from "../lib/emotes";
import { resolveCurrentR34lAdaptation } from "../lib/r34lAdaptation";
import {
  Flame,
  Tv,
  Coins,
  CheckCircle2,
  Circle,
  LogIn,
  Radio,
  Key,
  Copy,
  X,
  Trash2,
  GripVertical,
} from "lucide-react";
import { FidgetSpinner } from "./FidgetSpinner";
import { useHoldToConfirm } from "../hooks/useHoldToConfirm";
import { motion, useDragControls } from "motion/react";
import { ThemedTooltip } from "./ui/tooltip";

const calculateCost = (prompt: number, completion: number) => {
  const inputCost = (prompt / 1_000_000) * 0.075;
  const outputCost = (completion / 1_000_000) * 0.30;
  return (inputCost + outputCost).toFixed(5);
};

export function TheForge() {
  const {
    variants,
    isForging,
    setIsForging,
    streamMetadata,
    audioTranscript,
    chatLog,
    visualSnapshotUrl,
    visualContextTags,
    longTermMemory,
    pinnedMemories,
    goldenMemoryId,
    setVariants,
    updateVariant,
    config,
    lastTokenUsage,
    setLastTokenUsage,
    incrementForgeCount,
    autoMemoryConfig,
    autoMemories,
    userProfiles,
    insideJokes,
    personalityState,
  } = useAppStore();

  const platform = useAppStore((s) => s.platform);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const streamCaptureActive = useAppStore((s) => s.streamCaptureActive);
  const authTick = useAppStore((s) => s.authTick);
  // effectiveMode: the mode that actually renders (CORE when STUDIO is
  // unavailable on the current viewport). Drives core-vs-studio behavior.
  const interfaceMode = useEffectiveMode();
  const isMobile = useIsMobile();
  // Multi-bot: active authenticated bots for per-bot send squares on variant cards.
  const multiBotActive = useAppStore(selectMultiBotActive);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const bots = useAppStore((s) => s.bots);
  const activeBots = useMemo(
    () => (multiBotEnabled ? bots.filter((b) => b.active && b.session) : []),
    [multiBotEnabled, bots],
  );
  // Multi-bot: the manual-send identity (manualSendBotId) lives in the store so
  // the header picker (ForgeLayout → SendAsPicker) and this send path share it.

  const setupStatus = useMemo(() => {
    const loggedIn = platform === "kick" ? !!getKickSession() : platform === "joystick" ? !!getJoystickSession() : !!getTwitchSession();
    const loginUsername = platform === "kick" ? getKickSession()?.username : platform === "joystick" ? getJoystickSession()?.username : getTwitchSession()?.username;
    const channelSet = !!(streamMetadata?.channelName && streamMetadata.channelName.trim().length > 0);
    const hasApiKey = hasAnyApiKey();
    const capturing = streamCaptureActive;
    // In Core Mode, stream capture is optional (utility dock, not required).
    // Login is also not required for TheForge to show its UI — the CoreLaunchpadHero
    // handles login guidance, and the CoreReadinessStrip shows login status.
    // TheForge should show its actual Forge UI once channel + API key are set.
    const complete = interfaceMode === "core"
      ? channelSet && hasApiKey
      : loggedIn && channelSet && hasApiKey && capturing;
    return { loggedIn, loginUsername, channelSet, hasApiKey, capturing, complete };
  }, [platform, streamMetadata?.channelName, streamCaptureActive, authTick, interfaceMode]);

  const handleForge = async (forceCount?: number) => {
    if (isForging) return;
    setIsForging(true);
    playSfx('forge_start');
    const isMobileCore = isMobile && interfaceMode === "core";
    const toastId = isMobileCore ? undefined : toast.loading("Forging co-pilot variant batch...");

    try {
      const provider = getActiveProvider();

      // Director notes are streamer-authored directives — they reach manual
      // Forge regardless of AutoMemory (user-authored, not auto-extracted).
      // Multi-bot uses the sending identity's own per-bot notes (parity with
      // the per-bot AutoForge loop); single-bot uses the legacy notes.
      const forgeState = useAppStore.getState();
      const forgeDirectorBot = forgeState.multiBotEnabled && forgeState.manualSendBotId
        ? forgeState.bots.find((b) => b.id === forgeState.manualSendBotId && b.active && b.session)
        : null;
      const directorNotes = forgeDirectorBot ? forgeDirectorBot.runtime.directorNotes : forgeState.directorNotes;

      // Build memory context if auto-memory is enabled
      let memoryContext = "";
      if (autoMemoryConfig?.enabled) {
        const retrieved = retrieveRelevantMemories(
          autoMemories,
          userProfiles,
          insideJokes,
          personalityState,
          {
            currentChatLog: chatLog,
            audioTranscript,
            visualContext: visualContextTags.join(" "),
            streamMetadata,
            activeUsers: [],
            tokenBudget: autoMemoryConfig.contextInjectionTokenBudget,
          },
        );
        memoryContext = formatMemoryContext(retrieved, {
          memoriesFormed: personalityState?.sessionMemoriesFormed ?? 0,
          jokesCreated: personalityState?.sessionJokesCreated ?? 0,
        }, directorNotes);
      } else {
        // AutoMemory off: director notes STILL apply — manual Forge must see
        // the streamer's directives even without the memory engine.
        memoryContext = formatDirectorNotesContext(directorNotes);
      }

      // First Message Mode (manual Forge): if the bot the user will send as is
      // still awaiting its first message in the current cohort, inject the
      // "arrival" directive into this generation. No lock is acquired here —
      // the user may discard the variants; completion happens on the actual
      // successful send (sendManualMessage → addBotSentMessage).
      const fmmState = useAppStore.getState();
      const manualSendBotId = fmmState.manualSendBotId;
      const firstMessageMode = !!(manualSendBotId && fmmState.isBotFirstMessagePending(manualSendBotId));

      const data = await generateChat({
        streamMetadata,
        visualContext: visualContextTags.join(" "),
        screenshot: visualSnapshotUrl || undefined,
        recentChatLog: formatChatLog(chatLog),
        audioTranscript,
        longTermContext: longTermMemory || [
          ...pinnedMemories.filter(m => m.id !== goldenMemoryId).map(m => m.label),
          ...pinnedMemories.filter(m => m.id === goldenMemoryId).map(m => `[GOLDEN MEMORY — PRIORITIZE THIS]: ${m.label}`),
        ].join("\n"),
        config,
        activeProvider: provider,
        // R34L: manual Forge previously never received the flag (only the
        // TuningDeck forge did) — wire it plus the learned-style block.
        r34lEnabled: useAppStore.getState().r34lEnabled,
        r34lContext: resolveCurrentR34lAdaptation().promptBlock,
        botUsername: platform === "kick" ? getKickSession()?.username : platform === "joystick" ? getJoystickSession()?.username : getTwitchSession()?.username,
        memoryContext,
        availableEmotes: useAppStore.getState().emoteAwarenessEnabled
          ? getAvailableEmoteNames(streamMetadata?.channelName || "", 50)
          : undefined,
        botIdentityMode: useAppStore.getState().botIdentityMode,
        botIdentityStory: useAppStore.getState().botIdentityStory,
        firstMessageMode,
        // First-ever forge (Core setup Step 4): exactly 2 cards — a quick
        // taste, not a full batch. Later forges use the default count.
        count: forceCount ?? (useAppStore.getState().hasForgedOnce ? undefined : 2),
      });

      if (data.tokenUsage) {
        setLastTokenUsage({
          prompt_tokens: data.tokenUsage.prompt_tokens,
          completion_tokens: data.tokenUsage.completion_tokens,
          total_tokens: data.tokenUsage.total_tokens,
          effort_given: data.resolvedEffort || config?.effortLevel || "medium",
          feature: "forge",
        });
      } else {
        // Fallback estimated if no usage returned
        const payloadSize = JSON.stringify(data.suggestions || {}).length;
        setLastTokenUsage({
          prompt_tokens: Math.round(payloadSize / 4.1),
          completion_tokens: Math.round(payloadSize / 4.1),
          total_tokens: Math.round(payloadSize * 2 / 4.1),
          effort_given: data.resolvedEffort || config?.effortLevel || "medium",
          feature: "forge",
        });
      }

      const rankedVariants = rankVariants(data.suggestions || [], {
        config,
        recentSentMessages: useAppStore.getState().sentMessages.map(m => m.message).slice(-20),
      });
      if (rankedVariants.length === 0) {
        throw new Error("Forge produced no usable variants. Try again or lower the effort level.");
      }
      setVariants(rankedVariants);
      // E3: Record variants in history
      for (const variant of rankedVariants) {
        useAppStore.getState().addVariantHistoryEntry({
          message: variant.message,
          source: "forge",
          rating: null,
        });
      }
      incrementForgeCount();
      useAppStore.getState().setHasForgedOnce(true);
      if (toastId) {
        toast.success("Co-pilot variants forged successfully!", { id: toastId });
      }
      playSfx('forge_complete');
      window.dispatchEvent(new CustomEvent('bg-forge-pulse', { detail: { count: 14 } }));
    } catch (e: any) {
      if (toastId) {
        toast.error(e.message || "Error forging variants", { id: toastId });
      } else {
        toast.error(e.message || "Error forging variants");
      }
      playSfx('error');
    } finally {
      setIsForging(false);
    }
  };

  const handleSend = async (message: string, botId?: string, source: "manual" | "autoforge" = "manual") => {
    const state = useAppStore.getState();
    const isDryRun = state.autoForgeDryRun && source === "manual";
    const toastId = toast.loading(isDryRun ? "Previewing message (Dry Run)..." : "Sending message to stream chat...", {
      description: `Message: "${message.substring(0, 30)}..."`
    });
    try {
      await sendManualMessage({ message, channel: streamMetadata.channelName, botId, source, dryRun: isDryRun });
      if (isDryRun) {
        toast.success("Dry Run — message previewed in chat log", { id: toastId });
        playSfx('secret_word');
      } else {
        if (state.messageSoundEnabled) playMessageSound();
        speakMessage(message);
        toast.success("Sent to chat!", { id: toastId });
        playSfx('send_message');
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to send message", { id: toastId });
      playSfx('error');
    }
  };

  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // Keep a ref to handleForge so the forge-trigger listener always calls the latest.
  const handleForgeRef = useRef(handleForge);
  handleForgeRef.current = handleForge;

  useEffect(() => {
    const onAutoSend = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.message) {
        handleSendRef.current(customEvent.detail.message, undefined, "autoforge");
      }
    };
    window.addEventListener("autoforge-send-message", onAutoSend);
    return () => window.removeEventListener("autoforge-send-message", onAutoSend);
  }, []);

  // Core Mode: TuningDeck (which normally listens for forge-trigger) is not mounted.
  // TheForge handles the event directly in Core mode to avoid double-forge in Studio.
  useEffect(() => {
    const onForgeTrigger = (e: Event) => {
      if (interfaceMode === "core") {
        const count = (e as CustomEvent).detail?.count;
        handleForgeRef.current(typeof count === "number" ? count : undefined);
      }
    };
    window.addEventListener("forge-trigger", onForgeTrigger);
    return () => window.removeEventListener("forge-trigger", onForgeTrigger);
  }, [interfaceMode]);

  const handleRefine = async (id: number, type: string, customInstruction?: string) => {
    const variant = variants.find((v) => v.variant_id === id);
    if (!variant) return;

    const toastId = toast.loading(`Refining variant #${id}...`);
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
          effort_given: config?.effortLevel === "smart" ? "smart" : (config?.effortLevel || "medium"),
          feature: "refine",
        });
      }
      updateVariant(id, {
        message: data.message,
        why_it_fits: data.why_it_fits,
      });
      toast.success("Variant refined successfully!", { id: toastId });
      playSfx('refine_complete');
    } catch (e: any) {
      toast.error(e.message || "Error refining variant", { id: toastId });
      playSfx('error');
    }
  };

  const handleCloseVariant = (id: number) => {
    setVariants(variants.filter((v) => v.variant_id !== id));
    playSfx('variant_close');
  };

  // ── Hold-to-Clear: 1.25s hold animates from red → orange → yellow, then clears all variants.
  // Shared deterministic controller (src/lib/holdToClear.ts) — the old
  // duplicated timer/RAF logic could leave a stale final RAF frame stuck at
  // "Clearing..." after completion; the generation guard in the controller
  // makes that impossible.
  const { progress: holdProgress, start: startHold, cancel: cancelHold } = useHoldToConfirm({
    durationMs: 1250,
    onConfirm: () => {
      setVariants([]);
      playSfx('clear_context');
      toast.success("All forged variants cleared.");
    },
  });

  // Interpolate hold color: red (#ef4444) → orange (#f97316) → yellow (#eab308)
  const holdColor = useMemo(() => {
    const p = holdProgress;
    if (p < 0.5) {
      const t = p / 0.5;
      const r = 0xef + Math.round((0xf9 - 0xef) * t);
      const g = 0x44 + Math.round((0x73 - 0x44) * t);
      const b = 0x44 + Math.round((0x16 - 0x44) * t);
      return `rgb(${r}, ${g}, ${b})`;
    }
    const t = (p - 0.5) / 0.5;
    const r = 0xf9 + Math.round((0xea - 0xf9) * t);
    const g = 0x73 + Math.round((0xb3 - 0x73) * t);
    const b = 0x16 + Math.round((0x08 - 0x16) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }, [holdProgress]);

  // ── Draggable forge group: header is the drag handle, variants follow
  const forgeGroupRef = useRef<HTMLDivElement>(null);
  const forgeContainerRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const [forgeOffset, setForgeOffset] = useState(() => {
    try {
      const saved = localStorage.getItem("forge-group-offset");
      if (saved) return JSON.parse(saved);
    } catch {}
    return { x: 0, y: 0 };
  });
  useEffect(() => {
    localStorage.setItem("forge-group-offset", JSON.stringify(forgeOffset));
  }, [forgeOffset]);

  // Re-clamp the forge offset when the workspace container resizes
  // (e.g. left/right sidebar collapse/expand)
  useEffect(() => {
    const container = forgeContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const el = forgeGroupRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const padding = 8;
      setForgeOffset((prev) => {
        // If the group is already fully inside the container, no adjustment needed
        if (
          rect.left >= containerRect.left + padding &&
          rect.right <= containerRect.right - padding &&
          rect.top >= containerRect.top + padding &&
          rect.bottom <= containerRect.bottom - padding
        ) return prev;
        // Shift back into bounds — move the minimum amount needed
        let nx = prev.x, ny = prev.y;
        if (rect.right > containerRect.right - padding) nx += containerRect.right - padding - rect.right;
        if (rect.left < containerRect.left + padding) nx += containerRect.left + padding - rect.left;
        if (rect.bottom > containerRect.bottom - padding) ny += containerRect.bottom - padding - rect.bottom;
        if (rect.top < containerRect.top + padding) ny += containerRect.top + padding - rect.top;
        return { x: nx, y: ny };
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [variants.length]);

  return (
    <div data-tutorial="forge" className="flex flex-col h-full bg-transparent relative w-full items-center justify-between">
      {/* Subtle cosmic grid background */}
      <div className="absolute inset-0 bg-[url('https://transparenttextures.com/patterns/cubes.png')] opacity-[0.015] pointer-events-none" />

      {/* Main Content Area */}
      <div ref={forgeContainerRef} className="flex-1 w-full max-w-6xl p-4 overflow-y-auto overflow-x-hidden z-10 flex flex-col justify-center">
        {variants.length > 0 ? (
          <motion.div
            ref={forgeGroupRef}
            drag
            dragListener={false}
            dragControls={dragControls}
            dragMomentum={false}
            style={{ x: forgeOffset.x, y: forgeOffset.y }}
            onDragEnd={(_, info) => {
              const el = forgeGroupRef.current;
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const container = forgeContainerRef.current;
              if (!container) return;
              const containerRect = container.getBoundingClientRect();
              const padding = 8;
              // Clamp the drag delta so the group stays inside the workspace area
              const clampedX = Math.max(
                containerRect.left - rect.left + padding,
                Math.min(info.offset.x, containerRect.right - rect.right - padding)
              );
              const clampedY = Math.max(
                containerRect.top - rect.top + padding,
                Math.min(info.offset.y, containerRect.bottom - rect.bottom - padding)
              );
              setForgeOffset({ x: forgeOffset.x + clampedX, y: forgeOffset.y + clampedY });
            }}
            className="space-y-3 w-full"
          >
            {lastTokenUsage && (
              <div
                onPointerDown={(e) => dragControls.start(e)}
                className="bg-[#121217]/95 border border-white/10 rounded-xl p-3 flex flex-col md:flex-row items-start md:items-center justify-between text-xs font-mono text-gray-400 gap-2 backdrop-blur-md shadow-[0_4px_24px_rgba(0,0,0,0.5),0_0_1px_rgba(255,255,255,0.05)_inset] cursor-grab active:cursor-grabbing select-none hover:border-white/20 hover:shadow-[0_4px_32px_rgba(0,0,0,0.6),0_0_1px_rgba(255,255,255,0.08)_inset] transition-all"
              >
                <div className="flex items-center gap-2">
                  <GripVertical className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <Coins className="w-4 h-4 text-yellow-400 animate-pulse" />
                  <span className="font-bold text-gray-200 uppercase tracking-wider">Forge Resource Transaction</span>
                  <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded border ${
                    lastTokenUsage.effort_given === 'high' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                    lastTokenUsage.effort_given === 'low' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                    lastTokenUsage.effort_given === 'smart' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' :
                    'bg-blue-500/10 text-blue-400 border-blue-500/20'
                  }`}>
                    {lastTokenUsage.effort_given} Effort Mode
                  </span>
                </div>
                {/* Hold-to-Clear button — dead center of the header */}
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
                  className="relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-bold text-[10px] uppercase tracking-wider transition-all overflow-hidden select-none touch-none"
                  style={{
                    color: holdProgress > 0 ? '#fff' : '#f87171',
                    backgroundColor: holdProgress > 0 ? holdColor : 'rgba(239, 68, 68, 0.08)',
                    borderColor: holdProgress > 0 ? holdColor : 'rgba(239, 68, 68, 0.3)',
                    boxShadow: holdProgress > 0 ? `0 0 ${4 + holdProgress * 16}px ${holdColor}` : 'none',
                  }}
                  aria-label="Hold to clear all forged variants"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{holdProgress > 0 ? 'Clearing...' : 'Hold to Clear'}</span>
                  {holdProgress > 0 && (
                    <span
                      className="absolute bottom-0 left-0 h-0.5 transition-none"
                      style={{ width: `${holdProgress * 100}%`, backgroundColor: holdColor }}
                    />
                  )}
                </button>
                <div className="flex flex-wrap items-center gap-y-1.5 gap-x-4 text-[11px] w-full md:w-auto justify-between md:justify-end">
                  <div>
                    <span className="text-gray-500 mr-1">PROMPT:</span>
                    <span className="text-gray-200 font-bold">{lastTokenUsage.prompt_tokens}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 mr-1">COMPLETION:</span>
                    <span className="text-gray-200 font-bold">{lastTokenUsage.completion_tokens}</span>
                  </div>
                  <div className="bg-orange-500/10 px-1.5 py-0.5 rounded border border-orange-500/20">
                    <span className="text-gray-400 mr-1 font-semibold">TOTAL:</span>
                    <span className="text-orange-400 font-bold">{lastTokenUsage.total_tokens}</span>
                  </div>
                  <div className="bg-green-500/5 px-2 py-0.5 rounded border border-green-500/20">
                    <span className="text-gray-400 mr-1 font-semibold">EST. COST:</span>
                    <span className="text-green-400 font-bold">${calculateCost(lastTokenUsage.prompt_tokens, lastTokenUsage.completion_tokens)}</span>
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 auto-rows-max w-full">
              {variants.map((v) => (
                <VariantCard
                  key={v.variant_id}
                  variant={v}
                  onSend={handleSend}
                  onRefine={handleRefine}
                  onClose={handleCloseVariant}
                  multiBotActive={multiBotActive}
                  activeBots={activeBots}
                />
              ))}
            </div>
          </motion.div>
        ) : !setupStatus.complete ? (
          /* Setup Guide — shown until login + channel + API key are configured */
          <div className="forge-onboarding flex flex-col items-center justify-center text-center max-w-xl mx-auto py-8">
            <div className="forge-eyebrow mb-4">CAPTURE. TUNE. CONNECT.</div>
            <div className="mb-6">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="forge-welcome-title text-3xl font-black tracking-tight flex items-center justify-center gap-0"
              >
                {"Welcome to".split("").map((ch, i) => (
                  <motion.span
                    key={`w-${i}`}
                    initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    transition={{ delay: 0.05 * i, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    className="text-gray-200"
                  >
                    {ch === " " ? "\u00A0" : ch}
                  </motion.span>
                ))}
                <span className="ml-3" />
                <motion.span
                  initial={{ opacity: 0, scale: 0.8, filter: "blur(8px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  transition={{ delay: 0.35, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="relative inline-block"
                >
                  <span className="relative z-10 bg-gradient-to-r from-red-500 via-orange-500 to-yellow-500 bg-clip-text text-transparent" style={{ filter: "drop-shadow(0 0 12px rgba(249,115,22,0.5))" }}>
                    MAD
                  </span>
                  <motion.span
                    animate={{ opacity: [0.3, 0.6, 0.3] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute inset-0 z-0 bg-gradient-to-r from-red-500 via-orange-500 to-yellow-500 bg-clip-text text-transparent blur-sm"
                  >
                    MAD
                  </motion.span>
                </motion.span>
                <motion.span
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5, duration: 0.4 }}
                  className="text-gray-200"
                >
                  chatter
                </motion.span>
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="text-xs text-gray-500 mt-2"
              >
                Your AI co-pilot for stream chat. Complete the steps below to get started.
              </motion.div>
            </div>

            {/* Setup Checklist */}
            <div className="forge-setup-steps space-y-2 w-full mb-5">
              {/* Step 1: Log In */}
              <div className={`bg-[#121217]/50 border p-3 rounded-xl flex items-center gap-3 text-left backdrop-blur transition-colors ${setupStatus.loggedIn ? "border-green-500/20" : "border-white/5 hover:border-white/10"}`}>
                {setupStatus.loggedIn ? (
                  <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
                ) : (
                  <Circle className="w-5 h-5 text-gray-600 shrink-0" />
                )}
                <div className="flex flex-col flex-1">
                  <span className="text-xs font-bold text-gray-200 flex items-center gap-1.5">
                    <LogIn className="w-3 h-3" />
                    LOG IN WITH <span style={{ color: "#9146FF" }}>TWITCH</span> <span style={{ color: "#53fc18" }}>KICK</span> OR <span style={{ color: "#FF6B35" }}>JOYSTICK</span>
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {setupStatus.loggedIn
                      ? `Connected as @${setupStatus.loginUsername || "authenticated user"}`
                      : `Click the login button in the top-right corner to authenticate with your chosen platform.`}
                  </span>
                </div>
              </div>

              {/* Step 2: Set Channel */}
              <div className={`bg-[#121217]/50 border p-3 rounded-xl flex items-center gap-3 text-left backdrop-blur transition-colors ${setupStatus.channelSet ? "border-green-500/20" : "border-white/5 hover:border-white/10"}`}>
                {setupStatus.channelSet ? (
                  <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
                ) : (
                  <Circle className="w-5 h-5 text-gray-600 shrink-0" />
                )}
                <div className="flex flex-col flex-1">
                  <span className="text-xs font-bold text-gray-200 flex items-center gap-1.5">
                    <Radio className="w-3 h-3" />
                    SET YOUR CHANNEL NAME
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {setupStatus.channelSet
                      ? `Channel set to @${streamMetadata.channelName}`
                      : "Click the channel name in the top bar and enter the stream channel."}
                  </span>
                </div>
              </div>

              {/* Step 3: API Key */}
              <div className={`bg-[#121217]/50 border p-3 rounded-xl flex items-center gap-3 text-left backdrop-blur transition-colors ${setupStatus.hasApiKey ? "border-green-500/20" : "border-white/5 hover:border-white/10"}`}>
                {setupStatus.hasApiKey ? (
                  <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
                ) : (
                  <Circle className="w-5 h-5 text-gray-600 shrink-0" />
                )}
                <div className="flex flex-col flex-1">
                  <span className="text-xs font-bold text-gray-200 flex items-center gap-1.5">
                    <Key className="w-3 h-3" />
                    ADD AN API KEY
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {setupStatus.hasApiKey
                      ? `Provider "${getProviderWithKey() || getActiveProvider()}" is ready`
                      : "Open Settings in the right panel (Tuning Deck) and add an API key for your chosen AI provider."}
                  </span>
                  {!setupStatus.hasApiKey && (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-gray-400">Recommended: </span>
                        <a
                          href="https://openrouter.ai/keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-bold text-orange-400 hover:text-orange-300 underline decoration-orange-500/40 hover:decoration-orange-400 transition-colors"
                        >
                          OpenRouter ↗
                        </a>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-gray-500">
                          Use <code className="text-[10px] font-mono bg-white/5 px-1.5 py-0.5 rounded text-gray-300 border border-white/10">google/gemini-3.8-flash</code>
                        </span>
                        <ThemedTooltip content="Copy model name">
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText("google/gemini-3.8-flash");
                              toast.success("Model name copied!");
                            }}
                            className="text-gray-500 hover:text-orange-400 transition-colors"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        </ThemedTooltip>
                      </div>
                      <span className="text-[10px] text-gray-600 block">
                        Or use any other provider/key you prefer — OpenAI, Anthropic, Gemini, etc.
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 4: Capture with Stream Embed */}
              <div className={`bg-[#121217]/50 border p-3 rounded-xl flex items-center gap-3 text-left backdrop-blur transition-colors ${setupStatus.capturing ? "border-green-500/20" : "border-white/5 hover:border-white/10"}`}>
                {setupStatus.capturing ? (
                  <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
                ) : (
                  <Circle className="w-5 h-5 text-gray-600 shrink-0" />
                )}
                <div className="flex flex-col flex-1">
                  <span className="text-xs font-bold text-gray-200 flex items-center gap-1.5">
                    <Tv className="w-3 h-3" />
                    CAPTURE WITH STREAM EMBED
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {setupStatus.capturing
                      ? "Stream embed is open and capturing"
                      : "Open the Stream Embed widget in the left panel and start capturing a browser window."}
                  </span>
                </div>
              </div>
            </div>

            {/* How it works */}
            <div className="w-full bg-[#121217]/30 border border-white/5 rounded-xl p-3 backdrop-blur text-left">
              <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                How It Works
              </div>
              <div className="space-y-1.5">
                <div className="flex items-start gap-2 text-[11px] text-gray-500">
                  <span className="text-purple-400 font-mono font-bold shrink-0">1.</span>
                  <span><span className="text-gray-300 font-semibold">Capture</span> — Share a browser window or turn on audio transcription in the left panel.</span>
                </div>
                <div className="flex items-start gap-2 text-[11px] text-gray-500">
                  <span className="text-teal-400 font-mono font-bold shrink-0">2.</span>
                  <span><span className="text-gray-300 font-semibold">Tune</span> — Set humor, chaos levels, profiles, and custom instructions in the Deck.</span>
                </div>
                <div className="flex items-start gap-2 text-[11px] text-gray-500">
                  <span className="text-orange-400 font-mono font-bold shrink-0">3.</span>
                  <span><span className="text-gray-300 font-semibold">Forge</span> — Generate AI chat variants, preview, refine, and send to chat with one click.</span>
                </div>
              </div>
            </div>

            {/* Shortcut reminder — while setup checks are still being made */}
            <div className="w-full flex items-center justify-center gap-2.5 mt-1">
              <span className="text-[10px] text-gray-600 uppercase tracking-wider">While you wait:</span>
              <span className="flex items-center gap-1.5">
                <kbd className="px-2 py-1 rounded-md bg-[#121217]/80 border border-white/10 text-[10px] font-mono text-gray-400">Ctrl+K</kbd>
                <span className="text-[11px] text-gray-500">command palette</span>
              </span>
              <span className="text-gray-700">·</span>
              <span className="flex items-center gap-1.5">
                <kbd className="px-2 py-1 rounded-md bg-[#121217]/80 border border-white/10 text-[10px] font-mono text-gray-400">?</kbd>
                <span className="text-[11px] text-gray-500">all shortcuts</span>
              </span>
            </div>
          </div>
        ) : interfaceMode === "core" ? (
          /* Core Mode: the CoreLaunchpadHero handles the "Ready to Forge" state.
             TheForge shows nothing here until the first batch is forged. */
          null
        ) : (
          /* Studio Mode: Ready to Forge — shown when setup is complete but no variants yet */
          <div className="flex flex-col items-center justify-center text-center max-w-lg mx-auto py-10">
            <div className="-mt-20 overflow-visible">
              <FidgetSpinner size={300} showSpinCount={true} />
            </div>

            <div className="text-lg font-black text-gray-100 tracking-tight mb-1 mt-12">
              Ready to Forge
            </div>
            <div className="text-xs text-gray-500 mb-4">
              {platform === "kick" ? "Kick" : platform === "joystick" ? "Joystick" : "Twitch"} · @{streamMetadata?.channelName} · {getActiveProvider()}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 mb-4">
              <kbd className="px-2 py-1 rounded-md bg-[#121217]/80 border border-white/10 text-[10px] font-mono text-gray-400">
                F
              </kbd>
              <span className="text-[11px] text-gray-500">to forge</span>
              <span className="text-gray-700">·</span>
              <kbd className="px-2 py-1 rounded-md bg-[#121217]/80 border border-white/10 text-[10px] font-mono text-gray-400">
                Ctrl+K
              </kbd>
              <span className="text-[11px] text-gray-500">command palette</span>
            </div>

            {!hasForgedOnce && (
              <button
                onClick={() => handleForge()}
                disabled={isForging}
                className={cn(
                  "group relative px-6 py-2.5 rounded-xl bg-gradient-to-r from-orange-500/20 to-red-500/20 border border-orange-500/30 hover:border-orange-400/50 text-orange-300 hover:text-orange-200 font-bold text-sm transition-all shadow-lg hover:shadow-orange-500/10 disabled:cursor-not-allowed overflow-hidden",
                  isForging && "forge-btn-glow",
                )}
              >
                {isForging && (
                  <span className="absolute inset-0 overflow-hidden pointer-events-none">
                    <span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent forge-btn-shimmer" />
                  </span>
                )}
                <Flame className={cn("w-4 h-4 inline-block mr-2", isForging ? "animate-spin" : "group-hover:animate-pulse")} />
                {isForging ? "Forging..." : "Forge First Batch"}
              </button>
            )}
          </div>
        )}
      </div>


    </div>
  );
}
