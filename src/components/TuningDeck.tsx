import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";
import { cn } from "../lib/utils";
import { generateChat } from "../lib/ai";
import { getActiveProvider } from "../lib/keys";
import { getPlatformSendFn } from "../lib/platformSend";
import { playSfx } from "../lib/sfx";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { SettingsPanel } from "./SettingsPanel";
import { useTwitchAuth } from "../hooks/useTwitchAuth";
import { useKickAuth } from "../hooks/useKickAuth";
import { useJoystickAuth } from "../hooks/useJoystickAuth";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { toast } from "sonner";
import kappaUrl from "../../assets/Kappa.png";
import kreygasmUrl from "../../assets/Kreygasm.png";
import elegiggleUrl from "../../assets/EleGiggle.png";
import {
  Flame,
  Sparkles,
  Sliders,
  HelpCircle,
  Plus,
  Trash2,
  Lightbulb,
  Zap,
  Bot,
  ChevronDown,
  Settings,
  Volume2,
  Globe,
  Brain,
  Gauge,
  Mail,
  Activity,
  Bell,
  MessageCircle,
  Leaf,
  Scale,
  BookOpen,
  Target,
  Layers,
  GitBranch,
  EyeOff,
  RefreshCw,
} from "lucide-react";
import { playMessageSound, enumerateAudioOutputs, setAudioOutputSink, setSoundUrl, setSoundVolume as setSoundVolumeFn } from "../lib/sound";
import { formatChatLog } from "../lib/chatUtils";
import { retrieveRelevantMemories, formatMemoryContext } from "../lib/memoryRetrieval";
import { speakMessage, stopSpeaking, testVoice, getWebSpeechVoices, onVoicesChanged, groupVoicesByLanguage, isWebSpeechAvailable, ELEVENLABS_VOICES, fetchElevenLabsVoices, type VoiceGroup, type ElevenLabsUserVoice } from "../lib/tts";
import { Mic2, AudioLines, Square, Mic, Radio } from "lucide-react";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { VOICE_COMMAND_REFERENCE } from "../lib/voiceCommands";
import { AutoForgeSequencesOverlay } from "./AutoForgeSequencesOverlay";
import { RuleBuilderOverlay } from "./RuleBuilder";

export function TuningDeck({ rightSize = 22 }: { rightSize?: number }) {
  const {
    config,
    updateConfig,
    isForging,
    setIsForging,
    setVariants,
    streamMetadata,
    audioTranscript,
    chatLog,
    visualSnapshotUrl,
    visualContextTags,
    longTermMemory,
    pinnedMemories,
    goldenMemoryId,
    autoForgeEnabled,
    setAutoForgeEnabled,
    r34lEnabled,
    setR34lEnabled,
    messageSoundEnabled,
    setMessageSoundEnabled,
    audioOutputDeviceId,
    setAudioOutputDeviceId,
    customSoundUrl,
    setCustomSoundUrl,
    soundVolume,
    setSoundVolume,
    ttsEnabled,
    setTtsEnabled,
    ttsProvider,
    setTtsProvider,
    ttsVoice,
    setTtsVoice,
    ttsRate,
    setTtsRate,
    ttsVolume,
    setTtsVolume,
    elevenlabsApiKey,
    setElevenlabsApiKey,
    ttsAudioOutputDeviceId,
    setTtsAudioOutputDeviceId,
    autoMemoryConfig,
    autoMemories,
    userProfiles,
    insideJokes,
    personalityState,
    setMemoryPanelOpen,
    updateAutoMemoryConfig,
    rateLimitConfig,
    updateRateLimitConfig,
    sfxEnabled,
    setSfxEnabled,
    sfxVolume,
    setSfxVolume,
    desktopNotificationsEnabled,
    setDesktopNotificationsEnabled,
    smartRepliesEnabled,
    setSmartRepliesEnabled,
    personaPresets,
    activePersonaId,
    applyPersonaPreset,
    saveCustomPersonaPreset,
    deleteCustomPersonaPreset,
    keywordTriggerRules,
    addKeywordTriggerRule,
    updateKeywordTriggerRule,
    removeKeywordTriggerRule,
    clearKeywordTriggerRules,
    incrementTriggerMatch,
    forgeTemplates,
    addForgeTemplate,
    removeForgeTemplate,
    applyForgeTemplate,
    moodLock,
    setMoodLock,
    variantHistory,
    rateVariantHistory,
    clearVariantHistory,
    reactionSequences,
    addReactionSequence,
    removeReactionSequence,
    autoForgeSequences,
    autoForgeRules,
    perActionRateLimits,
    setPerActionRateLimits,
    botIdentityMode,
    setBotIdentityMode,
    botIdentityStory,
    setBotIdentityStory,
  } = useAppStore();
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  // Creative Tools inline input state
  const [showTemplateInput, setShowTemplateInput] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [showMoodPicker, setShowMoodPicker] = useState(false);
  const [showSequenceInput, setShowSequenceInput] = useState(false);
  const [sequenceName, setSequenceName] = useState("");
  const [sequenceReactions, setSequenceReactions] = useState("");
  // C5: Per-action rate limit editing state
  const [showRateLimitEditor, setShowRateLimitEditor] = useState(false);
  // C3: Full-page overlay
  const [showSequencesOverlay, setShowSequencesOverlay] = useState(false);
  // C1: Rule Engine overlay
  const [showRuleBuilderOverlay, setShowRuleBuilderOverlay] = useState(false);
  const [soundPanelOpen, setSoundPanelOpen] = useState(false);
  const [sfxPanelOpen, setSfxPanelOpen] = useState(false);
  // ElevenLabs user voices
  const [elevenlabsUserVoices, setElevenlabsUserVoices] = useState<ElevenLabsUserVoice[]>([]);
  const [elevenlabsVoicesLoading, setElevenlabsVoicesLoading] = useState(false);
  const [elevenlabsVoicesError, setElevenlabsVoicesError] = useState<string | null>(null);
  const [notificationsPanelOpen, setNotificationsPanelOpen] = useState(false);
  const [rateLimitOpen, setRateLimitOpen] = useState(false);
  const [triggersPanelOpen, setTriggersPanelOpen] = useState(false);
  const [newTriggerLabel, setNewTriggerLabel] = useState("");
  const [newTriggerPattern, setNewTriggerPattern] = useState("");
  const [newTriggerRegex, setNewTriggerRegex] = useState(false);
  const [newTriggerCase, setNewTriggerCase] = useState(false);
  const [newTriggerNotify, setNewTriggerNotify] = useState(true);
  const [newTriggerToast, setNewTriggerToast] = useState(true);
  const [newTriggerSound, setNewTriggerSound] = useState(false);
  const [newTriggerForce, setNewTriggerForce] = useState(false);
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [localMaxPerHour, setLocalMaxPerHour] = useState(rateLimitConfig.maxActionsPerHour);
  const [localMaxPerTenMin, setLocalMaxPerTenMin] = useState(rateLimitConfig.maxActionsPerTenMinutes);
  const [localCooldownSec, setLocalCooldownSec] = useState(Math.round(rateLimitConfig.minCooldownMs / 1000));

  // Keep local slider state in sync when store config changes externally
  useEffect(() => { setLocalMaxPerHour(rateLimitConfig.maxActionsPerHour); }, [rateLimitConfig.maxActionsPerHour]);
  useEffect(() => { setLocalMaxPerTenMin(rateLimitConfig.maxActionsPerTenMinutes); }, [rateLimitConfig.maxActionsPerTenMinutes]);
  useEffect(() => { setLocalCooldownSec(Math.round(rateLimitConfig.minCooldownMs / 1000)); }, [rateLimitConfig.minCooldownMs]);
  const [ttsPanelOpen, setTtsPanelOpen] = useState(false);
  const [webVoiceGroups, setWebVoiceGroups] = useState<VoiceGroup[]>([]);
  const [ttsTesting, setTtsTesting] = useState(false);

  const { pttActive, pttLoading, pttNeedsDownload, startPtt, stopPtt, togglePtt, confirmPttDownload, cancelPttDownload } = usePushToTalk();
  const [vcActive, setVcActive] = useState(false);
  const [vcListening, setVcListening] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const vc = window.__voiceCommands;
      if (vc) {
        setVcActive(vc.voiceCommandsActive);
        setVcListening(vc.voiceCommandsListening);
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isWebSpeechAvailable()) return;
    const loadVoices = () => {
      const voices = getWebSpeechVoices();
      if (voices.length > 0) {
        setWebVoiceGroups(groupVoicesByLanguage(voices));
        if (!useAppStore.getState().ttsVoice && voices.length > 0) {
          const natural = voices.find(v => /natural|neural|premium|enhanced/i.test(v.name));
          useAppStore.getState().setTtsVoice(natural?.name || voices[0].name);
        }
      }
    };
    loadVoices();
    const cleanup = onVoicesChanged(loadVoices);
    return cleanup;
  }, []);

  const platform = useAppStore((s) => s.platform);
  const twitchAuth = useTwitchAuth();
  const kickAuth = useKickAuth();
  const joystickAuth = useJoystickAuth();
  const activeAuth = platform === 'kick' ? kickAuth : platform === 'joystick' ? joystickAuth : twitchAuth;
  const activeUser = activeAuth.user;
  const activeLoginWithDevToken = activeAuth.loginWithDevToken;

  useEffect(() => {
    enumerateAudioOutputs().then(setAudioOutputs);
  }, []);

  // Fetch user's ElevenLabs voices when API key is present
  const loadElevenLabsVoices = useCallback(async () => {
    const key = useAppStore.getState().elevenlabsApiKey;
    if (!key) {
      setElevenlabsUserVoices([]);
      setElevenlabsVoicesError(null);
      return;
    }
    setElevenlabsVoicesLoading(true);
    setElevenlabsVoicesError(null);
    try {
      const voices = await fetchElevenLabsVoices(key);
      setElevenlabsUserVoices(voices);
    } catch (e: any) {
      setElevenlabsVoicesError(e?.message || "Failed to fetch voices");
      setElevenlabsUserVoices([]);
    } finally {
      setElevenlabsVoicesLoading(false);
    }
  }, []);

  // Auto-fetch when API key changes or when switching to elevenlabs provider
  useEffect(() => {
    if (ttsProvider === "elevenlabs" && elevenlabsApiKey) {
      loadElevenLabsVoices();
    } else {
      setElevenlabsUserVoices([]);
      setElevenlabsVoicesError(null);
    }
  }, [ttsProvider, elevenlabsApiKey, loadElevenLabsVoices]);

  // Local slider state for smooth dragging — synced to store on commit
  const [localHumor, setLocalHumor] = useState(config.humorLevel);
  const [localChaos, setLocalChaos] = useState(config.chaosLevel);

  // Keep local state in sync when config changes externally
  useEffect(() => {
    setLocalHumor(config.humorLevel);
  }, [config.humorLevel]);
  useEffect(() => {
    setLocalChaos(config.chaosLevel);
  }, [config.chaosLevel]);

  const [provider, setProvider] = useState(
    localStorage.getItem("active_api_provider") || "gemini"
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  useEffect(() => {
    const syncProvider = () => {
      const saved = localStorage.getItem("active_api_provider");
      if (saved && saved !== provider) {
        setProvider(saved);
      }
    };
    window.addEventListener("storage", syncProvider);
    const interval = setInterval(syncProvider, 1000);
    return () => {
      window.removeEventListener("storage", syncProvider);
      clearInterval(interval);
    };
  }, [provider]);

  const [newChipText, setNewChipText] = useState("");
  const [showAddChip, setShowAddChip] = useState(false);

  // Custom quick-add directive chips
  const [customChips, setCustomChips] = useState<string[]>(() => {
    const saved = localStorage.getItem("custom_forge_chips");
    if (saved) {
      const parsed = JSON.parse(saved);
      const hasOld = parsed.some((c: string) => c === "Add sarcasm" || c.includes("Shorten") || c.includes("JP slang"));
      const hasOldEmote = parsed.some((c: string) => c.includes("React to gameplay") && !c.startsWith("\uD83C\uDFC6")) || parsed.some((c: string) => c.includes("Backseat advice") && !c.startsWith("\uD83D\uDCA1"));
      const hasAgree = parsed.some((c: string) => c.includes("Agree with chat"));
      const hasPlayOff = parsed.some((c: string) => c.includes("Play off chat"));
      const FRESH_CHIPS = ["🔥 Hype it up","🏆 React to gameplay","😂 Be sarcastic","🎵 Reference the music","💀 Roast gently","🙏 Show appreciation","💡 Backseat advice","📈 Smart analysis","🎭 Play off chat","📜 Callback the lore","📣 Engage the streamer","🍿 Narrate the chaos","⏱️ Time references","🎮 Game tips","😤 Hype the clutch","🧊 Chill vibes","🎪 Embrace the chaos"];
      if (hasOld || hasOldEmote || (hasAgree && !hasPlayOff)) {
        localStorage.setItem("custom_forge_chips", JSON.stringify(FRESH_CHIPS));
        return FRESH_CHIPS;
      }
      const hasNewChips = parsed.some((c: string) => c.includes("Embrace the chaos"));
      if (!hasNewChips && parsed.length <= 14) {
        const updated = [...parsed.filter((c: string) => !c.includes("Chill vibes")), "🧊 Chill vibes", "🎪 Embrace the chaos"];
        localStorage.setItem("custom_forge_chips", JSON.stringify(updated));
        return updated;
      }
      return parsed;
    }
    return saved ? JSON.parse(saved) : ["🔥 Hype it up", "🏆 React to gameplay", "😂 Be sarcastic", "🎵 Reference the music", "💀 Roast gently", "🙏 Show appreciation", "💡 Backseat advice", "📈 Smart analysis", "🎭 Play off chat", "📜 Callback the lore", "📣 Engage the streamer", "🍿 Narrate the chaos", "⏱️ Time references", "🎮 Game tips", "😤 Hype the clutch", "🧊 Chill vibes", "🎪 Embrace the chaos"];
  });

  useEffect(() => {
    localStorage.setItem("custom_forge_chips", JSON.stringify(customChips));
  }, [customChips]);

  // Ref to always access latest forge data without re-subscribing listener
  const forgeDataRef = useRef({ config, streamMetadata, audioTranscript, chatLog, visualSnapshotUrl, visualContextTags, longTermMemory, pinnedMemories, goldenMemoryId, isForging, autoMemoryConfig, autoMemories, userProfiles, insideJokes, personalityState });
  forgeDataRef.current = { config, streamMetadata, audioTranscript, chatLog, visualSnapshotUrl, visualContextTags, longTermMemory, pinnedMemories, goldenMemoryId, isForging, autoMemoryConfig, autoMemories, userProfiles, insideJokes, personalityState };

  useEffect(() => {
    const onForge = (e: Event) => {
      const customEvent = e as CustomEvent;
      const autoSend = customEvent.detail?.autoSend;
      handleForgeRef.current(undefined, autoSend);
    };
    window.addEventListener("forge-trigger", onForge);
    return () => window.removeEventListener("forge-trigger", onForge);
  }, []);

  const handleProviderChange = (v: string) => {
    setProvider(v);
    localStorage.setItem("active_api_provider", v);
    let displayName = "Gemini 3.8 Flash";
    if (v === "gemini-env") displayName = "Gemini 3.8 Flash (Strict Environment API)";
    else if (v === "gemini-pro") displayName = "Gemini 3.7 Flash";
    else if (v === "openai") displayName = "GPT-5.6 Luna";
    else if (v === "anthropic") displayName = "Claude Haiku 4.5";
    else if (v === "openrouter") displayName = "OpenRouter / Custom API";
    else if (v === "ollama") displayName = "Ollama / Local";
    toast.success(`Active AI Model set to ${displayName}`);
  };

  const handleForge = async (count?: number, autoSend?: boolean) => {
    const { config: cfg, streamMetadata: sm, audioTranscript: at, chatLog: cl, visualSnapshotUrl: vsu, visualContextTags: vct, longTermMemory: ltm, pinnedMemories: pm, goldenMemoryId: gmid, isForging: forging, autoMemoryConfig: cl_autoMemoryConfig, autoMemories: cl_autoMemories, userProfiles: cl_userProfiles, insideJokes: cl_insideJokes, personalityState: cl_personalityState } = forgeDataRef.current;
    if (forging) return;
    setIsForging(true);
    toast.loading(count ? `Forging ${count} co-pilot variant${count > 1 ? "s" : ""}...` : "Forging new co-pilot variants...", { id: "forging-variants" });

    try {
      const activeProvider = getActiveProvider();

      // Build memory context if auto-memory is enabled
      let memoryContext = "";
      if (cl_autoMemoryConfig?.enabled) {
        const retrieved = retrieveRelevantMemories(
          cl_autoMemories,
          cl_userProfiles,
          cl_insideJokes,
          cl_personalityState,
          {
            currentChatLog: cl,
            audioTranscript: at,
            visualContext: vct.join(" "),
            streamMetadata: sm,
            activeUsers: [],
            tokenBudget: cl_autoMemoryConfig.contextInjectionTokenBudget,
          },
        );
        memoryContext = formatMemoryContext(retrieved, {
          memoriesFormed: cl_personalityState?.sessionMemoriesFormed ?? 0,
          jokesCreated: cl_personalityState?.sessionJokesCreated ?? 0,
        });
      }

      const data = await generateChat({
        streamMetadata: sm,
        visualContext: vct.join(" "),
        screenshot: vsu || undefined,
        recentChatLog: formatChatLog(cl),
        audioTranscript: at,
        longTermContext: ltm || [
          ...pm.filter(m => m.id !== gmid).map(m => m.label),
          ...pm.filter(m => m.id === gmid).map(m => `[GOLDEN MEMORY — PRIORITIZE THIS]: ${m.label}`),
        ].join("\n"),
        config: cfg,
        activeProvider,
        count,
        r34lEnabled,
        botUsername: activeUser?.login,
        memoryContext,
      });

      const suggestions = (data.suggestions || []).filter((s: any) => s && typeof s.message === "string" && s.message.trim().length > 0);
      if (suggestions.length === 0) {
        throw new Error("Forge produced no usable variants. Try again or lower the effort level.");
      }
      setVariants(suggestions);
      useAppStore.getState().incrementForgeCount();
      toast.success("Co-pilot variants forged successfully!", { id: "forging-variants" });
      window.dispatchEvent(new CustomEvent('bg-forge-pulse', { detail: { count: 14 } }));

      if (autoSend && suggestions.length > 0) {
        setTimeout(() => {
          const bestVariant = suggestions[0].message;
          toast.loading("AutoForge is selecting and sending...", { id: "autoforge-send" });
          useAppStore.getState().addSentMessage({
            message: bestVariant,
            channel: sm.channelName,
            timestamp: Date.now(),
            source: "autoforge",
          });
          useAppStore.getState().incrementMessagesSent();
          useAppStore.getState().addAutoForgeEvent({
            timestamp: Date.now(),
            type: "action_sent",
            severity: "high",
            summary: `AutoForge sent: "${bestVariant.substring(0, 60)}${bestVariant.length > 60 ? "..." : ""}"`,
            details: { source: "autoforge", message: bestVariant, channel: sm.channelName },
          });
          window.dispatchEvent(new CustomEvent("autoforge-send-message", { detail: { message: bestVariant } }));
        }, 1500); // 1.5 seconds delay so the user can see it generated
      }
    } catch (e: any) {
      toast.error(e.message || "Error forging variants", { id: "forging-variants" });
    } finally {
      setIsForging(false);
    }
  };

  const handleForgeRef = useRef(handleForge);
  handleForgeRef.current = handleForge;

  const handleAddChip = () => {
    if (!newChipText.trim()) return;
    if (customChips.includes(newChipText.trim())) {
      toast.error("Chip already exists!");
      return;
    }
    setCustomChips([...customChips, newChipText.trim()]);
    setNewChipText("");
    setShowAddChip(false);
    toast.success("Custom directive chip added!");
  };

  const handleDeleteChip = (chip: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCustomChips(customChips.filter((c) => c !== chip));
    toast.success("Directive chip deleted");
  };

  const handleChipClick = (chip: string) => {
    const currentText = config.additionalInstructions || "";
    const cleanChip = chip.replace(/^[^\w\s]+/, "").trim();
    const newText = currentText ? `${currentText}\n• ${cleanChip}` : `• ${cleanChip}`;
    updateConfig({ additionalInstructions: newText });
    toast.success(`Appended "${chip}" to directives!`);
  };

  // Helper text generators for live feed/guidelines
  const getHumorHelperText = () => {
    if (localHumor >= 96) return "🤣 Max meme output — non-stop copypasta, weaponized sarcasm, and bit-commitment. Can feel forced or repetitive; the bot prioritizes funny over useful.";
    if (localHumor >= 71) return "🔥 Heavy humor — frequent memes, sarcasm, and Twitch-style bits. Will go for the joke even when it's a stretch.";
    if (localHumor >= 46) return "⚡ Balanced wit — cracks jokes when the moment is right but stays readable. Banter without taking over.";
    if (localHumor >= 21) return "📝 Mostly direct with the occasional light quip. Won't lean into memes or sarcasm unless the moment really calls for it.";
    return "😐 Straightforward and serious. Almost no jokes — the bot just answers and reacts plainly. Good for informative or technical streams.";
  };

  const getChaosHelperText = () => {
    if (localChaos >= 96) return "🌀 Total chaos — reality-bending commentary, unhinged tangents, and peak gremlin behavior. Hard to predict what it'll say next; may not always make sense.";
    if (localChaos >= 71) return "👹 Gremlin energy — unpredictable takes, tangents, and shitposting. Will derail conversations and lean into chaos for the bit.";
    if (localChaos >= 46) return "⚖️ Balanced unpredictability — mixes grounded reactions with the occasional left-field take. Keeps chat guessing without losing the thread.";
    if (localChaos >= 21) return "🎯 Mostly focused with occasional tangents. Will follow a tangent if chat goes there, but comes back on its own.";
    return "🔒 Stays on script. Reacts to what's happening and rarely deviates. Predictable and safe — won't surprise you.";
  };

  return (
    <div className="flex flex-col h-full bg-[#121217] w-full p-3 gap-3 overflow-hidden">
      
      {/* Title Header */}
      <div className="flex items-center justify-between border-b border-white/5 pb-2 gap-1">
        <div className="flex items-center gap-2 min-w-0 shrink">
          <h2 className="text-[11px] font-black tracking-widest text-gray-400 uppercase font-mono flex items-center gap-2 truncate">
            <Sliders className="w-4 h-4 text-orange-400 shrink-0" />
          </h2>
        </div>
        <div className="flex items-center justify-end gap-1.5 shrink-0">
          <Tooltip>
            <TooltipTrigger render={
              <button
                type="button"
                onClick={() => {
                  setR34lEnabled(!r34lEnabled);
                  toast.success(`R34L mode is now ${!r34lEnabled ? 'enabled — all Forges will type more human' : 'disabled'}`);
                }}
                className={cn(
                  "relative px-2.5 py-1 rounded-md text-[10px] font-bold uppercase font-mono tracking-wider transition-all duration-300 overflow-hidden",
                  r34lEnabled
                    ? "text-emerald-300 bg-emerald-500/15 border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.35)]"
                    : "text-gray-500 bg-white/5 border border-white/10 hover:text-gray-400 hover:bg-white/10"
                )}
              >
                {r34lEnabled && (
                  <span className="absolute inset-0 rounded-md pointer-events-none animate-pulse bg-gradient-to-r from-transparent via-emerald-400/10 to-transparent" />
                )}
                <span className="relative flex items-center gap-1">
                  <span className={cn("w-1.5 h-1.5 rounded-full transition-all duration-300", r34lEnabled ? "bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)] animate-pulse" : "bg-gray-600")} />
                  R34L
                </span>
              </button>
            } />
            <TooltipContent
              side="bottom"
              align="center"
              sideOffset={8}
              className="max-w-sm p-0 bg-[#1a1a22] border border-emerald-500/20 text-left rounded-lg shadow-2xl"
            >
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                  <span className={cn("w-2 h-2 rounded-full", r34lEnabled ? "bg-emerald-400 animate-pulse" : "bg-gray-600")} />
                  <span className="text-[11px] font-bold uppercase font-mono tracking-wider text-emerald-300">R34L Human Typing Mode</span>
                </div>
                <p className="text-[11px] leading-relaxed text-gray-300">
                  When enabled, all Forge outputs are transformed to type like a real person — lowercase, loose spelling, punctuation as emotion, softeners, and controlled messiness. R34L also <span className="text-emerald-300">adapts to the channel's chat</span>: it mirrors the casing, slang, punctuation, and emote rhythm of the current chatters (texture only — it keeps its own content and language, and never escalates profanity). Falls back to a default human texture when chat is quiet. Meaning is preserved; only the typing texture changes.
                </p>
                <div className="rounded-md bg-black/30 border border-white/5 p-2 space-y-1.5">
                  <div>
                    <span className="text-[9px] font-bold uppercase font-mono text-gray-500 tracking-wider">Before</span>
                    <p className="text-[11px] text-gray-400 font-mono leading-relaxed">"I disagree because your argument relies on an unsupported assumption."</p>
                  </div>
                  <div>
                    <span className="text-[9px] font-bold uppercase font-mono text-emerald-400 tracking-wider">After</span>
                    <p className="text-[11px] text-emerald-200 font-mono leading-relaxed">"i don't fully buy that bc the whole thing is kinda leaning on an assumption you never actually proved... like the confidence is there, sure, but the substrate is not"</p>
                  </div>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
          {/* HUD button — styled with icon */}
          <button 
            type="button"
            onClick={() => useAppStore.getState().setIsAutoForgeHUDOpen(true)}
            className="rounded-lg p-1.5 border bg-white/5 border-white/5 text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/30 transition-all flex items-center gap-1"
          >
            <Activity className="w-3.5 h-3.5" />
            <span className="text-[9px] font-bold uppercase font-mono tracking-wider">HUD</span>
          </button>

          {/* AutoForge toggle — orange icon button with gentle pulse when active */}
          <Tooltip>
            <TooltipTrigger render={
              <button
                type="button"
                data-tutorial="autoforge"
                onClick={() => {
                  const newVal = !autoForgeEnabled;
                  setAutoForgeEnabled(newVal);
                  toast.success(`AutoForge is now ${newVal ? 'enabled' : 'disabled'}`);
                  playSfx(newVal ? 'autoforge_on' : 'autoforge_off');
                  useAppStore.getState().addAutoForgeEvent({
                    timestamp: Date.now(),
                    type: "enable_disable",
                    severity: "medium",
                    summary: `AutoForge ${newVal ? "enabled" : "disabled"}`,
                    details: { enabled: newVal },
                  });
                }}
                className={cn(
                  "relative rounded-lg p-1.5 border transition-all flex items-center justify-center",
                  autoForgeEnabled
                    ? "bg-orange-500/15 border-orange-500/40 text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.3)]"
                    : "bg-white/5 border-white/5 text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 hover:border-orange-500/30"
                )}
              >
                <Bot className="w-3.5 h-3.5" />
                {autoForgeEnabled && (
                  <span className="absolute inset-0 rounded-lg border border-orange-500/40 animate-pulse" style={{ animationDuration: '2s' }} />
                )}
              </button>
            } />
            <TooltipContent
              side="bottom"
              align="center"
              sideOffset={8}
              className="max-w-xs p-0 bg-[#1a1a22] border border-orange-500/20 text-left rounded-lg shadow-2xl"
            >
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                  <span className={cn("w-2 h-2 rounded-full", autoForgeEnabled ? "bg-orange-400 animate-pulse" : "bg-gray-600")} />
                  <span className="text-[11px] font-bold uppercase font-mono tracking-wider text-orange-300">AutoForge™ Autonomous Mode</span>
                </div>
                <p className="text-[11px] leading-relaxed text-gray-300">
                  When enabled, AutoForge autonomously decides when to speak, what to say, and sends messages to chat on its own — analyzing chat velocity, mentions, activity spikes, and audio/visual context.
                </p>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <Bot className="w-3 h-3 text-orange-400" />
                  <span>Press <kbd className="bg-white/10 px-1 rounded font-mono">A</kbd> to toggle · <kbd className="bg-white/10 px-1 rounded font-mono">H</kbd> for HUD</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Memory Panel toggle with beautified tooltip */}
          <Tooltip>
            <TooltipTrigger render={
              <button
                type="button"
                onClick={() => setMemoryPanelOpen(true)}
                className={cn(
                  "rounded-lg p-1.5 border transition-all",
                  autoMemoryConfig.enabled
                    ? "bg-purple-500/10 border-purple-500/30 text-purple-400 hover:bg-purple-500/20"
                    : "bg-white/5 border-white/5 text-gray-400 hover:text-purple-400 hover:bg-purple-500/10 hover:border-purple-500/30"
                )}
              >
                <Brain className="w-3.5 h-3.5" />
              </button>
            } />
            <TooltipContent
              side="bottom"
              align="center"
              sideOffset={8}
              className="max-w-xs p-0 bg-[#1a1a22] border border-purple-500/20 text-left rounded-lg shadow-2xl"
            >
              <div className="p-3 space-y-2">
                <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                  <span className={cn("w-2 h-2 rounded-full", autoMemoryConfig.enabled ? "bg-purple-400 animate-pulse" : "bg-gray-600")} />
                  <span className="text-[11px] font-bold uppercase font-mono tracking-wider text-purple-300">Auto-Memory & Inside Jokes</span>
                </div>
                <p className="text-[11px] leading-relaxed text-gray-300">
                  AI-powered long-term memory: extracts facts, builds user profiles, tracks inside jokes, and evolves personality across sessions. Click to open the memory management panel.
                </p>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <Brain className="w-3 h-3 text-purple-400" />
                  <span>Toggle: {autoMemoryConfig.enabled ? "Enabled" : "Disabled"}</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Memory enable/disable toggle */}
          <button
            type="button"
            onClick={() => {
              const newVal = !autoMemoryConfig.enabled;
              updateAutoMemoryConfig({ enabled: newVal });
              toast.success(`Auto-Memory is now ${newVal ? 'enabled' : 'disabled'}`);
            }}
            className={cn("w-10 h-5 rounded-full relative transition-colors", autoMemoryConfig.enabled ? "bg-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.5)]" : "bg-white/10")}
          >
            <div className={cn("w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform", autoMemoryConfig.enabled ? "translate-x-5" : "translate-x-1")} />
          </button>

          {/* Rate Limit Config — icon-only toggle with beautified tooltip */}
          <div className="relative">
            <Tooltip>
              <TooltipTrigger render={
                <button
                  type="button"
                  onClick={() => setRateLimitOpen((v) => !v)}
                  className={cn(
                    "rounded-lg p-1.5 border transition-all flex items-center justify-center",
                    rateLimitOpen
                      ? "bg-amber-500/15 border-amber-500/40 text-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.3)]"
                      : "bg-white/5 border-white/5 text-gray-400 hover:text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/30"
                  )}
                >
                  <Gauge className="w-4 h-4" />
                </button>
              } />
              <TooltipContent
                side="bottom"
                align="center"
                sideOffset={8}
                className="max-w-xs p-0 bg-[#1a1a22] border border-amber-500/20 text-left rounded-lg shadow-2xl"
              >
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                    <Gauge className="w-3 h-3 text-amber-400" />
                    <span className="text-[11px] font-bold uppercase font-mono tracking-wider text-amber-300">Rate Limiting</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-300">
                    Caps how many actions AutoForge can take per hour and per 10-minute window, with a minimum cooldown between actions. Prevents spammy behavior and protects against runaway costs.
                  </p>
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                    <span className="font-mono">{rateLimitConfig.maxActionsPerHour}/hr · {rateLimitConfig.maxActionsPerTenMinutes}/10min · {Math.round(rateLimitConfig.minCooldownMs / 1000)}s cooldown</span>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
            {rateLimitOpen && (
              <div className="absolute top-full mt-1 right-0 z-50 w-72 bg-[#12121a] border border-amber-500/30 rounded-lg p-3 space-y-3 shadow-2xl">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 font-mono">
                  <Gauge className="w-3 h-3" />
                  AutoForge Rate Limits
                </div>
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
                      <span>Max actions / hour</span>
                      <span className="font-mono font-bold text-white">{localMaxPerHour}</span>
                    </div>
                    <Slider
                      value={[localMaxPerHour]}
                      min={1} max={60} step={1}
                      onValueChange={(v) => {
                        const val = Array.isArray(v) ? v[0] : v;
                        setLocalMaxPerHour(val);
                      }}
                      onValueCommitted={(v) => {
                        const val = Array.isArray(v) ? v[0] : v;
                        updateRateLimitConfig({ maxActionsPerHour: val });
                        playSfx('slider_commit');
                      }}
                      indicatorClassName="bg-gradient-to-r from-red-500 to-orange-500"
                      className="w-full py-1.5 cursor-pointer"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
                      <span>Max actions / 10 min</span>
                      <span className="font-mono font-bold text-white">{localMaxPerTenMin}</span>
                    </div>
                    <Slider
                      value={[localMaxPerTenMin]}
                      min={1} max={20} step={1}
                      onValueChange={(v) => {
                        const val = Array.isArray(v) ? v[0] : v;
                        setLocalMaxPerTenMin(val);
                      }}
                      onValueCommitted={(v) => {
                        const val = Array.isArray(v) ? v[0] : v;
                        updateRateLimitConfig({ maxActionsPerTenMinutes: val });
                        playSfx('slider_commit');
                      }}
                      indicatorClassName="bg-gradient-to-r from-amber-500 to-yellow-400"
                      className="w-full py-1.5 cursor-pointer"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-gray-400 mb-1">
                      <span>Min cooldown (seconds)</span>
                      <span className="font-mono font-bold text-white">{localCooldownSec}s</span>
                    </div>
                    <Slider
                      value={[localCooldownSec]}
                      min={0} max={120} step={5}
                      onValueChange={(v) => {
                        const val = Array.isArray(v) ? v[0] : v;
                        setLocalCooldownSec(val);
                      }}
                      onValueCommitted={(v) => {
                        const val = Array.isArray(v) ? v[0] : v;
                        updateRateLimitConfig({ minCooldownMs: val * 1000 });
                        playSfx('slider_commit');
                      }}
                      indicatorClassName="bg-gradient-to-r from-blue-500 to-cyan-400"
                      className="w-full py-1.5 cursor-pointer"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Settings cog — far right */}
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  data-tutorial="settings"
                  className="ml-2 text-gray-400 hover:text-orange-400 rounded-lg h-8 w-8 bg-white/5 border border-white/5 hover:border-orange-500/40 hover:shadow-[0_0_12px_rgba(249,115,22,0.4)] hover:bg-orange-500/10 transition-all duration-300 group"
                />
              }
            >
              <Settings className="w-4 h-4 group-hover:animate-spin-slow group-hover:drop-shadow-[0_0_6px_rgba(249,115,22,0.8)] transition-all duration-300" />
            </DialogTrigger>
            <DialogContent className="sm:max-w-[750px] bg-[#0a0a0f] border-white/10 text-white shadow-2xl">
              <DialogHeader>
                <DialogTitle className="text-white font-black uppercase tracking-wider text-sm font-mono border-b border-white/5 pb-2">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span>System Configuration</span>
                      <a
                        href="mailto:kovrycha@gmail.com"
                        className="group relative mr-auto ml-3 inline-flex items-center justify-center w-6 h-6 rounded-md text-gray-500 hover:text-orange-400 hover:bg-orange-500/10 transition-all duration-300"
                        title="Contact: kovrycha@gmail.com"
                      >
                        <Mail className="w-5.8 h-5.8" style={{ width: '1.67rem', height: '1.67rem' }} />
                        <span className="pointer-events-none absolute -bottom-9 right-0 z-[100] px-2.5 py-1.5 bg-[#12121a] border border-orange-500/30 rounded-lg text-[10px] font-mono text-gray-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 shadow-xl">
                          ✉ kovrycha@gmail.com
                        </span>
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                    {/* Sound Effects — collapsible panel */}
                    <div className="relative">
                      <button
                        onClick={() => setSfxPanelOpen((v) => !v)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#FF6B35]/10 border border-[#FF6B35]/30 hover:bg-[#FF6B35]/20 transition-colors"
                      >
                        <Volume2 className="w-3.5 h-3.5 text-[#FF6B35]" />
                        <span className="text-[9px] font-black uppercase tracking-wider text-white">SFX</span>
                        {sfxEnabled && (
                          <span className="text-[8px] font-bold text-green-400 uppercase">On</span>
                        )}
                        <ChevronDown className={cn("w-3 h-3 text-gray-400 transition-transform", sfxPanelOpen && "rotate-180")} />
                      </button>
                      {sfxPanelOpen && (
                        <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-[#12121a] border border-[#FF6B35]/30 rounded-lg p-3 space-y-3 shadow-2xl">
                          <label className="flex items-center gap-3 p-2 bg-[#FF6B35]/10 border border-[#FF6B35]/30 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={sfxEnabled}
                              onChange={(e) => {
                                setSfxEnabled(e.target.checked);
                                if (e.target.checked) playSfx("palette_select");
                              }}
                              className="hidden"
                            />
                            <div
                              className={cn(
                                "w-4 h-4 rounded flex items-center justify-center transition-colors",
                                sfxEnabled ? "bg-[#FF6B35]" : "bg-black/50 border border-[#FF6B35]/30",
                              )}
                            >
                              {sfxEnabled && (
                                <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] font-black uppercase leading-tight text-white">Enable SFX</span>
                              <span className="text-[9px] opacity-60 text-gray-300">Theme-aware UI sound effects</span>
                            </div>
                          </label>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                                <Volume2 className="w-3 h-3 text-[#FF6B35]" />
                                SFX Volume
                              </span>
                              <span className="text-[9px] text-gray-500 font-mono">{Math.round(sfxVolume * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={sfxVolume}
                              onChange={(e) => setSfxVolume(parseFloat(e.target.value))}
                              className="w-full h-1.5 bg-black/40 rounded-full appearance-none cursor-pointer accent-[#FF6B35]"
                            />
                          </div>
                          <button
                            onClick={() => playSfx("forge_complete")}
                            disabled={!sfxEnabled}
                            className="w-full h-8 flex items-center justify-center gap-2 bg-[#FF6B35]/10 hover:bg-[#FF6B35]/20 disabled:opacity-30 text-[#FF6B35] text-[10px] font-bold uppercase tracking-widest rounded border border-[#FF6B35]/30 transition-colors"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                            Test SFX
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Message Sound — collapsible panel */}
                    <div className="relative">
                      <button
                        onClick={() => setSoundPanelOpen((v) => !v)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#FF6B35]/10 border border-[#FF6B35]/30 hover:bg-[#FF6B35]/20 transition-colors"
                      >
                        <Volume2 className="w-3.5 h-3.5 text-[#FF6B35]" />
                        <span className="text-[9px] font-black uppercase tracking-wider text-white">Sound</span>
                        {messageSoundEnabled && (
                          <span className="text-[8px] font-bold text-green-400 uppercase">On</span>
                        )}
                        <ChevronDown className={cn("w-3 h-3 text-gray-400 transition-transform", soundPanelOpen && "rotate-180")} />
                      </button>
                      {soundPanelOpen && (
                        <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-[#12121a] border border-[#FF6B35]/30 rounded-lg p-3 space-y-3 shadow-2xl">
                          {/* Enable toggle */}
                          <label className="flex items-center gap-3 p-2 bg-[#FF6B35]/10 border border-[#FF6B35]/30 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={messageSoundEnabled}
                              onChange={(e) => {
                                setMessageSoundEnabled(e.target.checked);
                                if (e.target.checked) playMessageSound();
                              }}
                              className="hidden"
                            />
                            <div
                              className={cn(
                                "w-4 h-4 rounded flex items-center justify-center transition-colors",
                                messageSoundEnabled ? "bg-[#FF6B35]" : "bg-black/50 border border-[#FF6B35]/30",
                              )}
                            >
                              {messageSoundEnabled && (
                                <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] font-black uppercase leading-tight text-white">Enable Sound</span>
                              <span className="text-[9px] opacity-60 text-gray-300">Play on Joystick messages</span>
                            </div>
                          </label>

                          {/* Volume Slider */}
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                                <Volume2 className="w-3 h-3 text-[#FF6B35]" />
                                Volume
                              </span>
                              <span className="text-[9px] text-gray-500 font-mono">{Math.round(soundVolume * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.01}
                              value={soundVolume}
                              onChange={(e) => {
                                const vol = parseFloat(e.target.value);
                                setSoundVolume(vol);
                                setSoundVolumeFn(vol);
                              }}
                              className="w-full h-1.5 bg-black/40 rounded-full appearance-none cursor-pointer accent-[#FF6B35]"
                            />
                          </div>

                          {/* Custom Sound URL */}
                          <div className="space-y-1.5">
                            <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                              <Globe className="w-3 h-3 text-[#FF6B35]" />
                              Custom Sound URL
                            </span>
                            <input
                              type="text"
                              value={customSoundUrl || ""}
                              onChange={(e) => {
                                const url = e.target.value.trim() || null;
                                setCustomSoundUrl(url);
                                setSoundUrl(url);
                              }}
                              onBlur={() => {
                                if (messageSoundEnabled) playMessageSound();
                              }}
                              className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6B35]/50 text-white placeholder-gray-700 font-mono"
                              placeholder="https://madchatter.fun/defbot.mp3"
                            />
                            <p className="text-[9px] text-gray-500 leading-relaxed">
                              Leave blank for default. Direct link to .mp3/.wav/.ogg.
                            </p>
                          </div>

                          {/* Audio Output Device */}
                          <div className="space-y-1.5">
                            <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                              <Volume2 className="w-3 h-3 text-[#FF6B35]" />
                              Audio Output Device
                            </span>
                            <select
                              value={audioOutputDeviceId || ""}
                              onChange={async (e) => {
                                const id = e.target.value || null;
                                setAudioOutputDeviceId(id);
                                if (id) await setAudioOutputSink(id);
                                if (messageSoundEnabled) playMessageSound();
                              }}
                              className="w-full bg-[#1E1E2A] border border-[#FF6B35]/40 rounded p-2 text-xs font-bold focus:outline-none focus:border-[#FF6B35] text-white cursor-pointer"
                            >
                              <option value="" className="bg-[#1E1E2A] text-white">Default Device</option>
                              {audioOutputs.map((d) => (
                                <option key={d.deviceId} value={d.deviceId} className="bg-[#1E1E2A] text-white">
                                  {d.label || `Device ${d.deviceId.slice(0, 8)}`}
                                </option>
                              ))}
                            </select>
                            {audioOutputs.length === 0 && (
                              <p className="text-[9px] text-gray-500 leading-relaxed">
                                Grant microphone permission to see device names.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* TTS Panel Toggle + Dropdown */}
                    <div className="relative">
                      <button
                        onClick={() => setTtsPanelOpen((v) => !v)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 transition-colors"
                      >
                        <Mic2 className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-[9px] font-black uppercase tracking-wider text-white">Voice</span>
                        {ttsEnabled && (
                          <span className="text-[8px] font-bold text-green-400 uppercase">On</span>
                        )}
                        <ChevronDown className={cn("w-3 h-3 text-gray-400 transition-transform", ttsPanelOpen && "rotate-180")} />
                      </button>
                      {ttsPanelOpen && (
                        <div className="absolute left-0 top-full mt-1 z-50 w-80 bg-[#12121a] border border-purple-500/30 rounded-lg p-3 space-y-3 shadow-2xl">
                          {/* Enable TTS Toggle */}
                          <label className="flex items-center gap-3 p-2 bg-purple-500/10 border border-purple-500/30 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={ttsEnabled}
                              onChange={(e) => {
                                setTtsEnabled(e.target.checked);
                                if (!e.target.checked) stopSpeaking();
                              }}
                              className="hidden"
                            />
                            <div
                              className={cn(
                                "w-4 h-4 rounded flex items-center justify-center transition-colors",
                                ttsEnabled ? "bg-purple-500" : "bg-black/50 border border-purple-500/30",
                              )}
                            >
                              {ttsEnabled && (
                                <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] font-black uppercase leading-tight text-white">Enable Voice TTS</span>
                              <span className="text-[9px] opacity-60 text-gray-300">Read bot messages aloud</span>
                            </div>
                          </label>

                          {/* Provider Selector */}
                          <div className="space-y-1.5">
                            <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                              <AudioLines className="w-3 h-3 text-purple-400" />
                              TTS Engine
                            </span>
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => setTtsProvider("web")}
                                className={cn(
                                  "flex-1 py-1.5 rounded text-[10px] font-bold transition-all",
                                  ttsProvider === "web"
                                    ? "bg-purple-500/20 border border-purple-500/50 text-purple-200"
                                    : "bg-black/30 border border-white/10 text-gray-500 hover:text-gray-300",
                                )}
                              >
                                Web Speech
                                <span className="block text-[8px] opacity-60 font-mono">Free</span>
                              </button>
                              <button
                                onClick={() => setTtsProvider("elevenlabs")}
                                className={cn(
                                  "flex-1 py-1.5 rounded text-[10px] font-bold transition-all",
                                  ttsProvider === "elevenlabs"
                                    ? "bg-purple-500/20 border border-purple-500/50 text-purple-200"
                                    : "bg-black/30 border border-white/10 text-gray-500 hover:text-gray-300",
                                )}
                              >
                                ElevenLabs
                                <span className="block text-[8px] opacity-60 font-mono">Premium</span>
                              </button>
                            </div>
                          </div>

                          {/* Voice Picker — Web Speech */}
                          {ttsProvider === "web" && (
                            <div className="space-y-1.5">
                              <span className="text-[10px] font-bold text-gray-400">Voice</span>
                              <select
                                value={ttsVoice || ""}
                                onChange={(e) => setTtsVoice(e.target.value || null)}
                                className="w-full bg-[#1E1E2A] border border-purple-500/40 rounded p-2 text-xs font-bold focus:outline-none focus:border-purple-500 text-white cursor-pointer max-h-[160px]"
                              >
                                {webVoiceGroups.length === 0 && (
                                  <option value="" className="bg-[#1E1E2A] text-white">Loading voices...</option>
                                )}
                                {webVoiceGroups.map((group) => (
                                  <optgroup key={group.lang} label={group.label} className="bg-[#1E1E2A] text-purple-300 font-bold">
                                    {group.voices.map((v) => (
                                      <option key={v.name} value={v.name} className="bg-[#1E1E2A] text-white font-normal">
                                        {v.name}{/natural|neural|premium|enhanced/i.test(v.name) ? " ★" : ""}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                              {webVoiceGroups.length === 0 && (
                                <p className="text-[9px] text-gray-500 leading-relaxed">
                                  Voices load on first interaction. Try clicking elsewhere and reopening.
                                </p>
                              )}
                              {webVoiceGroups.length > 0 && (
                                <p className="text-[9px] text-gray-500 leading-relaxed">
                                  ★ = neural/premium voice (best quality). On Windows, use Edge/Chrome for Microsoft Natural voices.
                                </p>
                              )}
                            </div>
                          )}

                          {/* Voice Picker — ElevenLabs */}
                          {ttsProvider === "elevenlabs" && (
                            <>
                              <div className="space-y-1.5">
                                <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                                  <AudioLines className="w-3 h-3 text-purple-400" />
                                  ElevenLabs API Key
                                </span>
                                <input
                                  type="password"
                                  value={elevenlabsApiKey}
                                  onChange={(e) => setElevenlabsApiKey(e.target.value.trim())}
                                  placeholder="sk-..."
                                  className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-purple-500/50 text-white placeholder-gray-700 font-mono"
                                />
                                <p className="text-[9px] text-gray-500 leading-relaxed">
                                  Get a free key at{" "}
                                  <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">
                                    elevenlabs.io ↗
                                  </a>
                                  {" "}· Free tier: 10K chars/mo
                                </p>
                              </div>
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-bold text-gray-400">Voice</span>
                                  <button
                                    onClick={loadElevenLabsVoices}
                                    disabled={elevenlabsVoicesLoading}
                                    className="flex items-center gap-1 text-[9px] text-purple-400 hover:text-purple-300 disabled:opacity-50 font-bold uppercase tracking-wider transition-colors"
                                    title="Refresh voices from your ElevenLabs account"
                                  >
                                    <RefreshCw className={cn("w-3 h-3", elevenlabsVoicesLoading && "animate-spin")} />
                                    {elevenlabsVoicesLoading ? "Loading..." : "Refresh"}
                                  </button>
                                </div>
                                {elevenlabsVoicesError && (
                                  <p className="text-[9px] text-red-400">{elevenlabsVoicesError}</p>
                                )}
                                <select
                                  value={ttsVoice || ""}
                                  onChange={(e) => setTtsVoice(e.target.value || null)}
                                  className="w-full bg-[#1E1E2A] border border-purple-500/40 rounded p-2 text-xs font-bold focus:outline-none focus:border-purple-500 text-white cursor-pointer"
                                >
                                  <option value="" className="bg-[#1E1E2A] text-white">Select a voice...</option>
                                  {elevenlabsUserVoices.length > 0 && (
                                    <optgroup label="Your Voices" className="bg-[#1E1E2A] text-white">
                                      {elevenlabsUserVoices.map((v) => {
                                        const labelParts = [v.name];
                                        if (v.category) labelParts.push(v.category);
                                        if (v.labels?.gender) labelParts.push(v.labels.gender);
                                        if (v.labels?.age) labelParts.push(v.labels.age);
                                        if (v.labels?.accent) labelParts.push(v.labels.accent);
                                        return (
                                          <option key={v.voice_id} value={v.voice_id} className="bg-[#1E1E2A] text-white">
                                            {labelParts.join(" · ")}
                                          </option>
                                        );
                                      })}
                                    </optgroup>
                                  )}
                                  <optgroup label="Default Presets" className="bg-[#1E1E2A] text-white">
                                    {ELEVENLABS_VOICES.map((v) => (
                                      <option key={v.id} value={v.id} className="bg-[#1E1E2A] text-white">
                                        {v.name} — {v.desc}
                                      </option>
                                    ))}
                                  </optgroup>
                                </select>
                                {elevenlabsUserVoices.length === 0 && !elevenlabsVoicesLoading && !elevenlabsVoicesError && elevenlabsApiKey && (
                                  <p className="text-[9px] text-gray-600 italic">
                                    Click Refresh to load voices from your account.
                                  </p>
                                )}
                              </div>
                            </>
                          )}

                          {/* Rate Slider — Web Speech only */}
                          {ttsProvider === "web" && (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-gray-400">Speed</span>
                                <span className="text-[9px] text-gray-500 font-mono">{ttsRate.toFixed(1)}x</span>
                              </div>
                              <input
                                type="range"
                                min={0.5}
                                max={2}
                                step={0.1}
                                value={ttsRate}
                                onChange={(e) => setTtsRate(parseFloat(e.target.value))}
                                className="w-full h-1.5 bg-black/40 rounded-full appearance-none cursor-pointer accent-purple-500"
                              />
                            </div>
                          )}

                          {/* Volume Slider */}
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                                <Volume2 className="w-3 h-3 text-purple-400" />
                                Volume
                              </span>
                              <span className="text-[9px] text-gray-500 font-mono">{Math.round(ttsVolume * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.01}
                              value={ttsVolume}
                              onChange={(e) => setTtsVolume(parseFloat(e.target.value))}
                              className="w-full h-1.5 bg-black/40 rounded-full appearance-none cursor-pointer accent-purple-500"
                            />
                          </div>

                          {/* Audio Output Device — independent from sound panel */}
                          <div className="space-y-1.5">
                            <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                              <Volume2 className="w-3 h-3 text-purple-400" />
                              TTS Audio Output Device
                            </span>
                            <select
                              value={ttsAudioOutputDeviceId || ""}
                              onChange={(e) => {
                                setTtsAudioOutputDeviceId(e.target.value || null);
                              }}
                              className="w-full bg-[#1E1E2A] border border-purple-500/40 rounded p-2 text-xs font-bold focus:outline-none focus:border-purple-500 text-white cursor-pointer"
                            >
                              <option value="" className="bg-[#1E1E2A] text-white">Default Device</option>
                              {audioOutputs.map((d) => (
                                <option key={d.deviceId} value={d.deviceId} className="bg-[#1E1E2A] text-white">
                                  {d.label || `Device ${d.deviceId.slice(0, 8)}`}
                                </option>
                              ))}
                            </select>
                            {audioOutputs.length === 0 && (
                              <p className="text-[9px] text-gray-500 leading-relaxed">
                                Grant microphone permission to see device names. Independent from Sound panel.
                              </p>
                            )}
                            <p className="text-[9px] text-gray-600 leading-relaxed">
                              ElevenLabs: routes to selected device. Web Speech: uses browser default (not controllable).
                            </p>
                          </div>

                          {/* Test + Stop buttons */}
                          <div className="flex gap-2 pt-1">
                            <button
                              onClick={async () => {
                                setTtsTesting(true);
                                try {
                                  await testVoice();
                                } catch (e: any) {
                                  toast.error(`TTS test failed: ${e?.message || e}`);
                                }
                                setTtsTesting(false);
                              }}
                              disabled={!ttsEnabled || ttsTesting}
                              className="flex-1 py-1.5 rounded bg-purple-500/20 border border-purple-500/40 text-purple-200 text-[10px] font-bold uppercase hover:bg-purple-500/30 transition-colors disabled:opacity-40"
                            >
                              {ttsTesting ? "Playing..." : "Test Voice"}
                            </button>
                            <button
                              onClick={() => stopSpeaking()}
                              className="px-3 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-[10px] font-bold uppercase hover:bg-red-500/20 transition-colors"
                            >
                              <Square className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Desktop Notifications — collapsible panel */}
                    <div className="relative">
                      <button
                        onClick={() => setNotificationsPanelOpen((v) => !v)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 transition-colors"
                      >
                        <Bell className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-[9px] font-black uppercase tracking-wider text-white">Alerts</span>
                        {desktopNotificationsEnabled && (
                          <span className="text-[8px] font-bold text-green-400 uppercase">On</span>
                        )}
                        <ChevronDown className={cn("w-3 h-3 text-gray-400 transition-transform", notificationsPanelOpen && "rotate-180")} />
                      </button>
                      {notificationsPanelOpen && (
                        <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-[#12121a] border border-blue-500/30 rounded-lg p-3 space-y-3 shadow-2xl">
                          <label className="flex items-center gap-3 p-2 bg-blue-500/10 border border-blue-500/30 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={desktopNotificationsEnabled}
                              onChange={(e) => {
                                setDesktopNotificationsEnabled(e.target.checked);
                                if (e.target.checked) {
                                  import("../lib/notifications").then(({ requestNotificationPermission }) => {
                                    requestNotificationPermission();
                                  });
                                }
                              }}
                              className="hidden"
                            />
                            <div
                              className={cn(
                                "w-4 h-4 rounded flex items-center justify-center transition-colors",
                                desktopNotificationsEnabled ? "bg-blue-500" : "bg-black/50 border border-blue-500/30",
                              )}
                            >
                              {desktopNotificationsEnabled && (
                                <svg className="w-3 h-3 text-black" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] font-black uppercase leading-tight text-white">Enable Alerts</span>
                              <span className="text-[9px] opacity-60 text-gray-300">Browser notifications when unfocused</span>
                            </div>
                          </label>
                          <div className="space-y-1.5">
                            <p className="text-[9px] text-gray-500 leading-relaxed">
                              Get desktop notifications for:
                            </p>
                            <ul className="text-[9px] text-gray-400 space-y-0.5 ml-3">
                              <li>• Chat mentions of your bot</li>
                              <li>• AutoForge errors and failures</li>
                              <li>• Sudden activity spikes in chat</li>
                              <li>• AI provider fallback events</li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Smart Replies toggle */}
                    <Tooltip>
                      <TooltipTrigger render={(props) => (
                        <button
                          {...props}
                          onClick={() => {
                            const newVal = !smartRepliesEnabled;
                            setSmartRepliesEnabled(newVal);
                            toast.success(`Smart replies ${newVal ? 'enabled' : 'disabled'}`);
                          }}
                          className={cn(
                            "flex items-center gap-1.5 px-2 py-1 rounded transition-colors border",
                            smartRepliesEnabled
                              ? "bg-cyan-500/15 border-cyan-500/40 hover:bg-cyan-500/25"
                              : "bg-white/5 border-white/10 hover:bg-white/10"
                          )}
                        >
                          <MessageCircle className={cn("w-3.5 h-3.5", smartRepliesEnabled ? "text-cyan-400" : "text-gray-500")} />
                          <span className={cn("text-[9px] font-black uppercase tracking-wider", smartRepliesEnabled ? "text-cyan-300" : "text-gray-500")}>Replies</span>
                          {smartRepliesEnabled && (
                            <span className="text-[8px] font-bold text-green-400 uppercase">On</span>
                          )}
                        </button>
                      )} />
                      <TooltipContent side="top" className="bg-[#1a1a1f] border border-cyan-500/20 text-cyan-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-bold uppercase tracking-wider">Smart Replies</span>
                          <span className="text-[9px] text-gray-400 normal-case">Auto-generates clickable reply suggestions when your bot is mentioned (only when AutoForge is off)</span>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    {/* Keyword Triggers toggle */}
                    <Tooltip>
                      <TooltipTrigger render={(props) => (
                        <button
                          {...props}
                          onClick={() => setTriggersPanelOpen(!triggersPanelOpen)}
                          className={cn(
                            "flex items-center gap-1.5 px-2 py-1 rounded transition-colors border",
                            triggersPanelOpen
                              ? "bg-amber-500/15 border-amber-500/40 hover:bg-amber-500/25"
                              : "bg-white/5 border-white/10 hover:bg-white/10"
                          )}
                        >
                          <Target className={cn("w-3.5 h-3.5", triggersPanelOpen ? "text-amber-400" : "text-gray-500")} />
                          <span className={cn("text-[9px] font-black uppercase tracking-wider", triggersPanelOpen ? "text-amber-300" : "text-gray-500")}>Triggers</span>
                          {keywordTriggerRules.length > 0 && (
                            <span className="text-[8px] font-bold text-amber-400">{keywordTriggerRules.filter(r => r.enabled).length}</span>
                          )}
                        </button>
                      )} />
                      <TooltipContent side="top" className="bg-[#1a1a1f] border border-amber-500/20 text-amber-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-bold uppercase tracking-wider">Keyword Triggers</span>
                          <span className="text-[9px] text-gray-400 normal-case">Define keyword/regex patterns that fire notifications, toasts, sounds, or force AutoForge actions</span>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    </div>
                  </div>

                  {/* Keyword Triggers panel — inline within dialog */}
                  {triggersPanelOpen && (
                    <div className="bg-[#12121a] border border-amber-500/30 rounded-lg p-3 space-y-3 mt-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 font-mono">
                          <Target className="w-3 h-3" />
                          Keyword Triggers
                        </div>
                        {keywordTriggerRules.length > 0 && (
                          <button
                            onClick={() => { clearKeywordTriggerRules(); toast.info("All triggers cleared"); }}
                            className="text-[9px] text-gray-500 hover:text-red-400"
                          >
                            clear all
                          </button>
                        )}
                      </div>

                      {/* Existing rules */}
                      {keywordTriggerRules.length > 0 && (
                        <div className="space-y-1.5">
                          {keywordTriggerRules.map((rule) => (
                            <div key={rule.id} className="flex items-center gap-1.5 p-1.5 rounded bg-black/30 border border-white/5 group">
                              <button
                                onClick={() => updateKeywordTriggerRule(rule.id, { enabled: !rule.enabled })}
                                className={cn(
                                  "w-3 h-3 rounded-full shrink-0 transition-colors",
                                  rule.enabled ? "bg-amber-400" : "bg-gray-700"
                                )}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1">
                                  <span className={cn("text-[10px] font-bold truncate", rule.enabled ? "text-gray-200" : "text-gray-500")}>{rule.label}</span>
                                  {rule.matchCount > 0 && (
                                    <span className="text-[8px] text-amber-400 font-mono shrink-0">{rule.matchCount}x</span>
                                  )}
                                </div>
                                <span className="text-[9px] text-gray-500 font-mono truncate block">{rule.pattern}</span>
                              </div>
                              <button
                                onClick={() => removeKeywordTriggerRule(rule.id)}
                                className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add new trigger form */}
                      <div className="space-y-1.5 pt-1.5 border-t border-white/5">
                        <div className="text-[9px] text-gray-500 font-bold uppercase">Add New Trigger</div>
                        <input
                          type="text"
                          value={newTriggerLabel}
                          onChange={(e) => setNewTriggerLabel(e.target.value)}
                          placeholder="Label (e.g. Raid Alert)"
                          maxLength={30}
                          className="w-full text-[10px] px-2 py-1 rounded bg-black/40 border border-white/10 text-gray-200 placeholder:text-gray-600 outline-none focus:border-amber-500/40"
                        />
                        <input
                          type="text"
                          value={newTriggerPattern}
                          onChange={(e) => setNewTriggerPattern(e.target.value)}
                          placeholder="Pattern (e.g. raid or ^raid\\b)"
                          className="w-full text-[10px] px-2 py-1 rounded bg-black/40 border border-white/10 text-gray-200 placeholder:text-gray-600 outline-none focus:border-amber-500/40 font-mono"
                        />
                        <div className="flex items-center gap-2 text-[9px]">
                          <label className="flex items-center gap-0.5 cursor-pointer">
                            <input type="checkbox" checked={newTriggerRegex} onChange={(e) => setNewTriggerRegex(e.target.checked)} className="w-2.5 h-2.5 accent-amber-500" />
                            <span className="text-gray-400">Regex</span>
                          </label>
                          <label className="flex items-center gap-0.5 cursor-pointer">
                            <input type="checkbox" checked={newTriggerCase} onChange={(e) => setNewTriggerCase(e.target.checked)} className="w-2.5 h-2.5 accent-amber-500" />
                            <span className="text-gray-400">Case-sensitive</span>
                          </label>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap text-[9px]">
                          <label className="flex items-center gap-0.5 cursor-pointer">
                            <input type="checkbox" checked={newTriggerNotify} onChange={(e) => setNewTriggerNotify(e.target.checked)} className="w-2.5 h-2.5 accent-amber-500" />
                            <span className="text-gray-400">Notify</span>
                          </label>
                          <label className="flex items-center gap-0.5 cursor-pointer">
                            <input type="checkbox" checked={newTriggerToast} onChange={(e) => setNewTriggerToast(e.target.checked)} className="w-2.5 h-2.5 accent-amber-500" />
                            <span className="text-gray-400">Toast</span>
                          </label>
                          <label className="flex items-center gap-0.5 cursor-pointer">
                            <input type="checkbox" checked={newTriggerSound} onChange={(e) => setNewTriggerSound(e.target.checked)} className="w-2.5 h-2.5 accent-amber-500" />
                            <span className="text-gray-400">Sound</span>
                          </label>
                          <label className="flex items-center gap-0.5 cursor-pointer">
                            <input type="checkbox" checked={newTriggerForce} onChange={(e) => setNewTriggerForce(e.target.checked)} className="w-2.5 h-2.5 accent-amber-500" />
                            <span className="text-gray-400">Force AutoForge</span>
                          </label>
                        </div>
                        <button
                          onClick={() => {
                            if (!newTriggerLabel.trim() || !newTriggerPattern.trim()) return;
                            addKeywordTriggerRule({
                              label: newTriggerLabel.trim(),
                              pattern: newTriggerPattern.trim(),
                              isRegex: newTriggerRegex,
                              caseSensitive: newTriggerCase,
                              actions: { notify: newTriggerNotify, toast: newTriggerToast, sound: newTriggerSound, forceAutoForge: newTriggerForce },
                              enabled: true,
                            });
                            setNewTriggerLabel("");
                            setNewTriggerPattern("");
                            setNewTriggerRegex(false);
                            setNewTriggerCase(false);
                            setNewTriggerNotify(true);
                            setNewTriggerToast(true);
                            setNewTriggerSound(false);
                            setNewTriggerForce(false);
                            toast.success("Trigger added!");
                          }}
                          className="w-full text-[10px] py-1.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 font-bold uppercase tracking-wider transition-colors"
                        >
                          + Add Trigger
                        </button>
                      </div>
                    </div>
                  )}
                </DialogTitle>
              </DialogHeader>
              <SettingsPanel
                variant="keys"
                config={config}
                setConfig={(c: any) => updateConfig(c)}
                user={activeUser}
                loginWithDevToken={activeLoginWithDevToken}
                addToast={(msg, type) => {
                  if (type === "success") toast.success(msg);
                  else toast.error(msg);
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Scrollable middle section */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0 forge-scroll pb-3">

      {/* 0. Bot Identity — AI denial / custom persona story */}
      <div className="space-y-1.5 shrink-0">
        <div className="flex justify-between items-center text-xs font-bold text-gray-300 px-0.5">
          <span className="flex items-center gap-1">
            <EyeOff className="w-3.5 h-3.5 text-red-400" />
            Bot Identity
          </span>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => setBotIdentityMode("admit")}
            className={cn(
              "flex-1 py-1.5 rounded-lg border text-[10px] font-bold transition-all",
              botIdentityMode === "admit"
                ? "bg-green-500/20 border-green-500/50 text-green-200"
                : "bg-[#0a0a0f] border-white/5 text-gray-400 hover:border-green-500/30 hover:text-green-300"
            )}
          >
            Admit AI
          </button>
          <button
            onClick={() => setBotIdentityMode("custom")}
            className={cn(
              "flex-1 py-1.5 rounded-lg border text-[10px] font-bold transition-all",
              botIdentityMode === "custom"
                ? "bg-red-500/20 border-red-500/50 text-red-200"
                : "bg-[#0a0a0f] border-white/5 text-gray-400 hover:border-red-500/30 hover:text-red-300"
            )}
          >
            Deny AI
          </button>
        </div>
        {botIdentityMode === "custom" && (
          <div className="space-y-1">
            <textarea
              value={botIdentityStory}
              onChange={(e) => setBotIdentityStory(e.target.value)}
              placeholder="Write a persona backstory the bot will use when accused of being AI. e.g. 'I'm a 24-year-old gamer from Ohio who dropped out of college to stream full-time. I love pizza and hate Mondays.'"
              rows={4}
              className="w-full text-[11px] bg-black/30 border border-red-500/20 rounded-lg px-2 py-1.5 text-gray-200 placeholder:text-gray-600 outline-none focus:border-red-500/40 resize-none leading-relaxed"
            />
            <p className="text-[9px] text-gray-600 italic">
              When someone asks if the bot is AI, it will stay in character using this story. Keep it brief and believable.
            </p>
          </div>
        )}
        {botIdentityMode === "admit" && (
          <p className="text-[9px] text-gray-600 italic">
            Bot will honestly admit it's an AI when asked. Playful but never denies it.
          </p>
        )}
      </div>

      {/* 1. Persona Presets */}
      <div className="space-y-1.5 shrink-0">
        <div className="flex justify-between items-center text-xs font-bold text-gray-300 px-0.5">
          <span className="flex items-center gap-1">
            <Target className="w-3.5 h-3.5 text-indigo-400" />
            Persona Presets
          </span>
          <button
            onClick={() => setShowSavePreset(!showSavePreset)}
            className="text-[9px] text-indigo-400 hover:text-indigo-300 font-bold uppercase tracking-wider transition-colors"
          >
            {showSavePreset ? "Cancel" : "+ Save Current"}
          </button>
        </div>
        {showSavePreset && (
          <div className="flex items-center gap-1.5 pb-1">
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="Preset name..."
              maxLength={24}
              className="flex-1 text-[10px] px-2 py-1 rounded bg-black/30 border border-white/10 text-gray-200 placeholder:text-gray-600 outline-none focus:border-indigo-500/40"
              onKeyDown={(e) => {
                if (e.key === "Enter" && presetName.trim()) {
                  saveCustomPersonaPreset(presetName.trim(), "Target");
                  setPresetName("");
                  setShowSavePreset(false);
                  toast.success(`Preset "${presetName.trim()}" saved!`);
                }
              }}
            />
            <button
              onClick={() => {
                if (presetName.trim()) {
                  saveCustomPersonaPreset(presetName.trim(), "Target");
                  toast.success(`Preset "${presetName.trim()}" saved!`);
                  setPresetName("");
                  setShowSavePreset(false);
                }
              }}
              className="text-[9px] px-2 py-1 rounded bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/30 font-bold uppercase"
            >
              Save
            </button>
          </div>
        )}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 forge-scroll">
          {personaPresets.map((preset) => {
            const isActive = activePersonaId === preset.id;
            const iconMap: Record<string, any> = { Leaf, Flame, Brain, Scale, Zap, BookOpen, Target };
            const Icon = iconMap[preset.icon] || Target;
            return (
              <button
                key={preset.id}
                onClick={() => {
                  if (isActive) {
                    applyPersonaPreset(preset.id);
                    toast.info(`Preset "${preset.name}" re-applied`);
                  } else {
                    applyPersonaPreset(preset.id);
                    toast.success(`Switched to "${preset.name}" preset`);
                    playSfx('slider_commit');
                  }
                }}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 rounded-lg border whitespace-nowrap transition-all shrink-0 group",
                  isActive
                    ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-200 shadow-[0_0_12px_rgba(99,102,241,0.3)]"
                    : "bg-white/[0.03] border-white/10 text-gray-400 hover:bg-white/[0.06] hover:border-indigo-500/30"
                )}
              >
                <Icon className="w-3 h-3" />
                <span className="text-[10px] font-bold">{preset.name}</span>
                {preset.custom && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toast(`Delete "${preset.name}"?`, {
                        duration: 6000,
                        action: {
                          label: "Delete",
                          onClick: () => {
                            deleteCustomPersonaPreset(preset.id);
                            toast.success(`"${preset.name}" deleted`);
                          },
                        },
                        cancel: {
                          label: "Cancel",
                          onClick: () => {},
                        },
                      });
                    }}
                    className="ml-0.5 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition-opacity"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. Core Profile selector */}
      <div data-tutorial="persona" className="space-y-1.5 shrink-0">
        <div className="flex justify-between items-center text-xs font-bold text-gray-300 px-0.5">
          <span className="flex items-center gap-1">
            <Bot className="w-3.5 h-3.5 text-gray-400" />
            Persona Mask
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { value: "Gremlin", label: "Gremlin", desc: "Troll", color: "hover:border-red-500/40 hover:bg-red-500/10", activeColor: "bg-red-500/20 border-red-500/50 text-red-200 shadow-[0_0_12px_rgba(239,68,68,0.3)]", fontClass: "italic font-black lowercase tracking-tight", image: "https://madchatter.fun/assets/gremlin.gif", imageStatic: "https://madchatter.fun/assets/gremlin.png" },
            { value: "Hype", label: "Hype Beast", desc: "Energy", color: "hover:border-orange-500/40 hover:bg-orange-500/10", activeColor: "bg-orange-500/20 border-orange-500/50 text-orange-200 shadow-[0_0_12px_rgba(249,115,22,0.3)]", fontClass: "font-black uppercase tracking-wider", image: "https://madchatter.fun/assets/hype_beast.gif", imageStatic: "https://madchatter.fun/assets/hype_beast.png" },
            { value: "Analyst", label: "Analyst", desc: "Smart", color: "hover:border-blue-500/40 hover:bg-blue-500/10", activeColor: "bg-blue-500/20 border-blue-500/50 text-blue-200 shadow-[0_0_12px_rgba(59,130,246,0.3)]", fontClass: "font-medium tracking-wide", image: "https://madchatter.fun/assets/analyst.gif", imageStatic: "https://madchatter.fun/assets/analyst.png" },
            { value: "Short", label: "One-Worder", desc: "Clean", color: "hover:border-teal-500/40 hover:bg-teal-500/10", activeColor: "bg-teal-500/20 border-teal-500/50 text-teal-200 shadow-[0_0_12px_rgba(20,184,166,0.3)]", fontClass: "font-light tracking-normal", image: "https://madchatter.fun/assets/one-worder.gif", imageStatic: "https://madchatter.fun/assets/one-worder.png" },
            { value: "Questioner", label: "Questioner", desc: "Curious", color: "hover:border-purple-500/40 hover:bg-purple-500/10", activeColor: "bg-purple-500/20 border-purple-500/50 text-purple-200 shadow-[0_0_12px_rgba(168,85,247,0.3)]", fontClass: "italic font-semibold tracking-wide", image: "https://madchatter.fun/assets/questioner.gif", imageStatic: "https://madchatter.fun/assets/questioner.png" },
            { value: "Support", label: "Support", desc: "Warm", color: "hover:border-green-500/40 hover:bg-green-500/10", activeColor: "bg-green-500/20 border-green-500/50 text-green-200 shadow-[0_0_12px_rgba(34,197,94,0.3)]", fontClass: "font-bold tracking-normal", image: "https://madchatter.fun/assets/support.gif", imageStatic: "https://madchatter.fun/assets/support.png" },
          ].map((p) => {
            const active = config.primaryProfile === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  if (active) {
                    updateConfig({ primaryProfile: "none" });
                    toast.success("Profile mask removed! Running unmasked.");
                  } else {
                    updateConfig({ primaryProfile: p.value });
                    toast.success(`Profile set to ${p.label}!`);
                  }
                }}
                className={`group flex items-center justify-center ${rightSize < 20 ? 'gap-1.5' : 'gap-2.5'} py-2 px-2 rounded-lg border text-[10px] font-bold transition-all ${active ? p.activeColor : `bg-[#0a0a0f] border-white/5 text-gray-400 ${p.color}`}`}
              >
                {(() => {
                  const imgSize = rightSize < 20 ? 28 : rightSize < 22 ? 32 : 36;
                  if (p.imageStatic && p.image) return (
                    <div className="relative shrink-0" style={{ width: `${imgSize}px`, height: `${imgSize}px` }}>
                      <img src={p.imageStatic} alt="" className={`absolute inset-0 w-full h-full rounded object-cover transition-opacity duration-200 ${active ? "opacity-0" : "opacity-100 group-hover:opacity-0"}`} />
                      <img src={p.image} alt="" className={`absolute inset-0 w-full h-full rounded object-cover transition-opacity duration-200 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} />
                    </div>
                  );
                  if (p.image) return (
                    <img src={p.image} alt="" className="rounded object-cover shrink-0" style={{ width: `${imgSize}px`, height: `${imgSize}px` }} />
                  );
                  return null;
                })()}
                <div className="flex flex-col items-start">
                  <span className={`text-[11px] ${p.fontClass}`}>{p.label}</span>
                  <span className="text-[9px] font-mono opacity-60">{p.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Grouped Sliders with current values + live helper text */}
      <Card data-tutorial="sliders" className="bg-[#0F0F12] border-white/5 shadow-none rounded-xl overflow-visible -mt-3 shrink-0">
        <CardContent className="p-3 space-y-4 overflow-visible">
          
          {/* Humor Slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
              <span className="flex items-center gap-1">Humor Level</span>
              <span className={cn(
                "font-mono text-[10px] px-2 py-0.5 rounded border transition-all duration-300",
                localHumor === 100 
                  ? "text-yellow-400 bg-red-500/20 border-red-500/50 shadow-[0_0_10px_rgba(239,68,68,0.6)] animate-pulse font-black"
                  : "text-orange-400 bg-orange-500/10 border-orange-500/20"
              )}>
                {localHumor === 100 ? "🔥 100% MAX" : `${localHumor}%`}
              </span>
            </div>
            <Slider
              value={[localHumor]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                setLocalHumor(val);
              }}
              onValueCommitted={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                updateConfig({ humorLevel: val });
                playSfx('slider_commit');
              }}
              indicatorClassName={localHumor === 100 
                ? "maxed-humor-slider bg-gradient-to-r from-red-600 via-yellow-400 to-white" 
                : "bg-gradient-to-r from-yellow-400 via-orange-500 to-red-500"}
              className="py-1.5 cursor-pointer"
            />
            <span className={cn(
              "text-[9px] font-mono block leading-normal transition-colors duration-300",
              localHumor === 100 ? "text-yellow-400 font-bold drop-shadow-[0_0_4px_rgba(239,68,68,0.4)]" : "text-gray-500"
            )}>
              {getHumorHelperText()}
            </span>
          </div>

          {/* Chaos Slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
              <span className="flex items-center gap-1">Chaos Energy</span>
              <span className={cn(
                "font-mono text-[10px] px-2 py-0.5 rounded border transition-all duration-300",
                localChaos === 100 
                  ? "text-fuchsia-300 bg-purple-500/20 border-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.6)] animate-pulse font-black"
                  : "text-purple-400 bg-purple-500/10 border-purple-500/20"
              )}>
                {localChaos === 100 ? "🌀 100% MAX" : `${localChaos}%`}
              </span>
            </div>
            <Slider
              value={[localChaos]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                setLocalChaos(val);
              }}
              onValueCommitted={(v) => {
                const val = Array.isArray(v) ? v[0] : v;
                updateConfig({ chaosLevel: val });
                playSfx('slider_commit');
              }}
              indicatorClassName={localChaos === 100 
                ? "maxed-chaos-slider bg-gradient-to-r from-purple-600 via-fuchsia-400 to-white" 
                : "bg-gradient-to-r from-indigo-400 via-purple-500 to-fuchsia-500"}
              className="py-1.5 cursor-pointer"
            />
            <span className={cn(
              "text-[9px] font-mono block leading-normal transition-colors duration-300",
              localChaos === 100 ? "text-fuchsia-400 font-bold drop-shadow-[0_0_4px_rgba(168,85,247,0.4)]" : "text-gray-500"
            )}>
              {getChaosHelperText()}
            </span>
          </div>

          {/* Emote Density + Toxicity Filter — side by side */}
          <div className="grid grid-cols-2 gap-2 pt-1 overflow-visible">
          {/* Emote Density */}
          <div className="space-y-1.5 overflow-visible">
            <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
              <span>Emote Density</span>
              <Badge key={config.emoteDensity} className="bg-transparent border-0 text-gray-300 text-[9px] font-bold uppercase font-mono p-0 relative overflow-visible rounded-none z-[9999] emote-slide-in mr-1">
                {(config.emoteDensity as any) === "minimal" ? (
                  <img src={kappaUrl} alt="Kappa" className="w-auto inline-block object-contain kappa-grow" style={{ height: '28px', borderRadius: 0 }} />
                ) : (config.emoteDensity as any) === "moderate" ? (
                  <img src={kreygasmUrl} alt="Kreygasm" className="w-auto inline-block object-contain kreygasm-jump" style={{ height: '34px', borderRadius: 0 }} />
                ) : (config.emoteDensity as any) === "heavy" ? (
                  <img src={elegiggleUrl} alt="EleGiggle" className="w-auto inline-block object-contain elegiggle-wobble" style={{ height: '28px', borderRadius: 0 }} />
                ) : (
                  <span className="rainbow-text font-mono text-[10px] font-black">uWu</span>
                )}
              </Badge>
            </div>
            <Select
              value={config.emoteDensity}
              onValueChange={(v: any) => updateConfig({ emoteDensity: v })}
            >
              <SelectTrigger className="w-full bg-[#0a0a0f] border-white/5 text-xs text-gray-300 h-8">
                <SelectValue placeholder="Ready to tr0ll(!)" />
              </SelectTrigger>
              <SelectContent className="bg-[#0a0a0f] border-white/10 text-white">
                <SelectItem value="none" className="text-gray-400 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">🚫 None — Strict text only</SelectItem>
                <SelectItem value="minimal" className="text-amber-400/90 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">😏 Minimal — 1 emote max</SelectItem>
                <SelectItem value="moderate" className="text-violet-400/90 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">🔥 Moderate — Standard Twitch style</SelectItem>
                <SelectItem value="heavy" className="text-fuchsia-400/90 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">💀 Heavy — Spammy chat hype</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Toxicity Filter */}
          <div className="space-y-1.5 overflow-visible">
            <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
              <span>Toxicity Filter</span>
              <span className="text-[20px] leading-none">
                {(config.toxicityFilter as any) === "family" ? "🧸" : (config.toxicityFilter as any) === "unfiltered" ? "🔥" : "✅"}
              </span>
            </div>
            <Select
              value={config.toxicityFilter || "standard"}
              onValueChange={(v: any) => updateConfig({ toxicityFilter: v })}
            >
              <SelectTrigger className="w-full bg-[#0a0a0f] border-white/5 text-xs text-gray-300 h-8">
                <SelectValue placeholder="Standard" />
              </SelectTrigger>
              <SelectContent className="bg-[#0a0a0f] border-white/10 text-white">
                <SelectItem value="family" className="text-green-400/90 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">🧸 Family — No profanity, safe for all</SelectItem>
                <SelectItem value="standard" className="text-amber-400/90 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">✅ Standard — Typical Twitch energy</SelectItem>
                <SelectItem value="unfiltered" className="text-red-400/90 focus:!bg-white focus:!text-black data-[highlighted]:!bg-white data-[highlighted]:!text-black">🔥 Unfiltered — Raw, no holds barred</SelectItem>
              </SelectContent>
            </Select>
          </div>
          </div>

          {/* Message Length — stepped slider */}
          <div className="space-y-2 pt-1">
            <div className="flex justify-between text-xs font-bold text-gray-300 items-center px-0.5">
              <span>Message Length</span>
              <span className="text-[9px] font-mono uppercase bg-white/5 px-1.5 py-0.5 rounded text-gray-400">
                {config.lengthPreference && config.lengthPreference !== "none" ? config.lengthPreference : "Unconstrained"}
              </span>
            </div>
            <div className="flex gap-1.5 mt-1">
              {[
                { value: "adaptive", label: "Adaptive", tooltip: "Match stream energy — longer messages during hype moments, shorter when chill" },
                { value: "short", label: "Short" },
                { value: "medium", label: "Medium" },
                { value: "long", label: "Long" },
              ].map((opt) => {
                const active = config.lengthPreference === opt.value;
                const btn = (
                  <button
                    type="button"
                    onClick={() => {
                      if (active) {
                        updateConfig({ lengthPreference: "none" });
                        toast.success("Length limit removed! Messages are now unconstrained.");
                      } else {
                        updateConfig({ lengthPreference: opt.value });
                        toast.success(`Length preference set to ${opt.label}!`);
                      }
                    }}
                    className={`flex-1 w-full py-1.5 rounded-lg border text-[10px] font-bold transition-all ${active ? "bg-orange-500/15 border-orange-500/40 text-orange-400" : "bg-[#0a0a0f] border-white/5 text-gray-500 hover:border-white/15 hover:text-gray-300"}`}
                  >
                    {opt.label}
                  </button>
                );
                if (opt.tooltip) {
                  return (
                    <div key={opt.value} className="flex-1 flex">
                      <Tooltip>
                        <TooltipTrigger render={(props) => <div {...props} className="flex-1 flex">{btn}</div>} />
                        <TooltipContent side="bottom" className="bg-[#1a1a1f] border border-orange-500/20 text-orange-300 text-[10px] font-medium rounded-lg px-3 py-2 shadow-xl max-w-[200px] text-center">
                          {opt.tooltip}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  );
                }
                return <div key={opt.value} className="flex-1 flex">{btn}</div>;
              })}
            </div>
          </div>

          {/* Effort Level Selector */}
          <div className="space-y-2 pt-2 border-t border-white/5">
            <div className="flex justify-between text-xs font-bold text-gray-300 items-center">
              <span className="flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-yellow-400" />
                Computation Effort
              </span>
              <span className="text-[9px] font-mono text-gray-500 uppercase">
                {config.effortLevel || "medium"}
              </span>
            </div>
            <div className="flex gap-1.5 mt-1">
              {[
                { value: "low", label: "Low (Eco)", tooltip: "Fast, cheaper, concise suggestions. Max 512 completion tokens." },
                { value: "medium", label: "Medium", tooltip: "Balanced depth & performance. Max 1536 completion tokens." },
                { value: "high", label: "High (Deep)", tooltip: "Creative, detailed contextual reasoning. Max 3072 completion tokens." },
              ].map((opt) => {
                const active = (config.effortLevel || "medium") === opt.value;
                const btn = (
                  <button
                    type="button"
                    onClick={() => {
                      updateConfig({ effortLevel: opt.value as any });
                      toast.success(`Computational effort set to ${opt.label}!`);
                    }}
                    className={`flex-1 w-full py-1.5 rounded-lg border text-[10px] font-bold transition-all ${active ? "bg-yellow-500/15 border-yellow-500/40 text-yellow-400" : "bg-[#0a0a0f] border-white/5 text-gray-500 hover:border-white/15 hover:text-gray-300"}`}
                  >
                    {opt.label}
                  </button>
                );
                return (
                  <div key={opt.value} className="flex-1 flex">
                    <Tooltip>
                      <TooltipTrigger render={(props) => <div {...props} className="flex-1 flex">{btn}</div>} />
                      <TooltipContent side="bottom" className="bg-[#1a1a1f] border border-yellow-500/20 text-yellow-300 text-[10px] font-medium rounded-lg px-3 py-2 shadow-xl max-w-[200px] text-center">
                        {opt.tooltip}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          </div>

        </CardContent>
      </Card>

      <div className="forge-separator shrink-0" />

      {/* 3. Directives card with row of chips */}
      <Card data-tutorial="chips" className="bg-[#0F0F12] border-white/5 shadow-none rounded-xl flex flex-col shrink-0">
        <CardHeader data-tutorial="directives-header" className="p-1.5 pb-0 flex flex-col space-y-0 gap-1">
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-gray-300 shrink-0 text-center w-full flex items-center justify-center gap-2">
            System Directives
            <Tooltip>
              <TooltipTrigger render={(triggerProps) => (
                <button
                  {...triggerProps}
                  type="button"
                  onPointerDown={async (e) => {
                    e.preventDefault();
                    if (e.shiftKey) {
                      if (pttActive) {
                        const text = await togglePtt();
                        if (text && text.trim()) {
                          const currentText = config.additionalInstructions || "";
                          const newText = currentText ? `${currentText}\n• Directive: ${text.trim()}` : `• Directive: ${text.trim()}`;
                          updateConfig({ additionalInstructions: newText });
                          toast.success("PTT transcribed → added to directives");
                        }
                      } else {
                        await togglePtt();
                      }
                      return;
                    }
                    if (!pttActive && !pttLoading) {
                      const ok = await startPtt();
                      if (!ok) toast.error("Microphone access denied");
                    }
                  }}
                  onPointerUp={async (e) => {
                    e.preventDefault();
                    if (e.shiftKey) return;
                    if (pttActive) {
                      const text = await stopPtt();
                      if (text && text.trim()) {
                        const currentText = config.additionalInstructions || "";
                        const newText = currentText ? `${currentText}\n• Directive: ${text.trim()}` : `• Directive: ${text.trim()}`;
                        updateConfig({ additionalInstructions: newText });
                        toast.success("PTT transcribed → added to directives");
                      }
                    }
                  }}
                  onPointerLeave={(e) => {
                    if (e.shiftKey) return;
                    if (pttActive) {
                      e.preventDefault();
                      stopPtt().then((text) => {
                        if (text && text.trim()) {
                          const currentText = config.additionalInstructions || "";
                          const newText = currentText ? `${currentText}\n• Directive: ${text.trim()}` : `• Directive: ${text.trim()}`;
                          updateConfig({ additionalInstructions: newText });
                          toast.success("PTT transcribed → added to directives");
                        }
                      });
                    }
                  }}
                  disabled={pttLoading}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${
                    pttActive
                      ? "text-red-300 bg-red-500/30 border border-red-500/40 animate-pulse"
                      : pttLoading
                        ? "text-purple-300 bg-purple-500/20 border border-purple-500/30"
                        : "text-purple-400 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/20"
                  }`}
                >
                  {pttActive ? <Square className="w-2.5 h-2.5" /> : <Mic className="w-2.5 h-2.5" />}
                  {pttActive ? "Recording..." : pttLoading ? "Transcribing..." : "PTT"}
                </button>
              )} />
              <TooltipContent side="bottom" className="bg-[#0a0a0f] border border-purple-500/20 rounded-lg p-3 shadow-2xl max-w-[280px] z-50">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 pb-1.5 border-b border-purple-500/15">
                    <Mic className="w-3 h-3 text-purple-400" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-purple-300">Push to Talk</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[9px] font-bold text-purple-300 shrink-0">Hold</span>
                      <span className="text-[9px] text-gray-400 leading-tight">Press & hold to record — release to transcribe into Directives</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[9px] font-bold text-purple-300 shrink-0">Shift+Click</span>
                      <span className="text-[9px] text-gray-400 leading-tight">Toggle mode — stays recording until clicked again</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-0.5 pt-1.5 border-t border-purple-500/10">
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-[8px] text-gray-500">Recording</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                      <span className="text-[8px] text-gray-500">Transcribing via Whisper</span>
                    </div>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={(triggerProps) => (
                <button
                  {...triggerProps}
                  type="button"
                  onClick={async () => {
                    const vc = window.__voiceCommands;
                    if (!vc) return;
                    if (vc.voiceCommandsActive) {
                      vc.stopVoiceCommands();
                      toast.success("Voice commands stopped");
                    } else {
                      const ok = await vc.startVoiceCommands();
                      if (ok) toast.success("Voice commands active — say a command!");
                      else toast.error("Failed to start voice commands (need mic permission)");
                    }
                  }}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${
                    vcActive
                      ? vcListening
                        ? "text-green-300 bg-green-500/30 border border-green-500/40 animate-pulse"
                        : "text-green-300 bg-green-500/20 border border-green-500/30"
                      : "text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20"
                  }`}
                >
                  <Radio className="w-2.5 h-2.5" />
                  {vcActive ? (vcListening ? "Listening..." : "VC On") : "VC"}
                </button>
              )} />
              <TooltipContent side="bottom" className="bg-[#0a0a0f] border border-green-500/20 rounded-lg p-3 shadow-2xl max-w-[280px] z-50">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 pb-1.5 border-b border-green-500/15">
                    <Radio className="w-3 h-3 text-green-400" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-green-300">Voice Commands</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[9px] text-gray-400 leading-tight">Click to toggle always-on voice command listening. Speak naturally — the system uses Whisper to transcribe and match commands in real time.</span>
                  </div>
                  <div className="flex flex-col gap-0.5 pt-1.5 border-t border-green-500/10">
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-[8px] text-gray-500">Listening for speech</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500/50" />
                      <span className="text-[8px] text-gray-500">Active but silent</span>
                    </div>
                  </div>
                  <span className="text-[8px] text-gray-600 italic pt-1 border-t border-green-500/10">
                    Hover the help icon for the full command list.
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={(props) => (
                <span
                  {...props}
                  className="cursor-help text-gray-500 hover:text-green-400 transition-colors"
                >
                  <HelpCircle className="w-3 h-3" />
                </span>
              )} />
              <TooltipContent side="bottom" className="bg-[#0a0a0f] border border-green-500/20 rounded-lg p-3 shadow-2xl max-w-[320px] z-50">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 pb-1.5 border-b border-green-500/15">
                    <Radio className="w-3 h-3 text-green-400" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-green-300">Voice Commands</span>
                  </div>
                  <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto forge-scroll">
                    {Object.entries(
                      VOICE_COMMAND_REFERENCE.reduce((acc, cmd) => {
                        if (!acc[cmd.category]) acc[cmd.category] = [];
                        acc[cmd.category].push(cmd);
                        return acc;
                      }, {} as Record<string, typeof VOICE_COMMAND_REFERENCE>)
                    ).map(([category, cmds]) => (
                      <div key={category} className="flex flex-col gap-0.5">
                        <span className="text-[8px] font-bold uppercase tracking-wider text-green-500/60 mt-1">{category}</span>
                        {cmds.map((cmd) => (
                          <div key={cmd.trigger} className="flex items-baseline gap-1.5">
                            <code className="text-[9px] font-mono text-green-300 bg-green-500/10 px-1 rounded shrink-0">{cmd.trigger}</code>
                            <span className="text-[9px] text-gray-400 leading-tight">{cmd.description}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <span className="text-[8px] text-gray-600 italic pt-1 border-t border-green-500/10">
                    Say any command naturally — partial matches work.
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          </CardTitle>
          <div className="flex flex-wrap gap-1 pr-1">
            {customChips.map((c) => (
              <Badge
                key={c}
                variant="outline"
                className="text-[9px] bg-white/5 border-white/10 text-gray-300 hover:bg-white/10 hover:border-orange-500/30 cursor-pointer transition-all flex items-center justify-center gap-1 px-1.5 py-0 text-center group/chip"
                onClick={() => handleChipClick(c)}
              >
                <span>{c}</span>
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-1.5 pt-0.5 flex-1 flex flex-col gap-1.5">
          <div className="relative flex">
            <textarea
              className="directives-scroll w-full h-[225px] bg-black/40 border border-white/5 rounded-lg p-2.5 pr-8 resize-none text-xs text-gray-200 placeholder:text-gray-600 focus:border-orange-500/40 outline-none font-mono leading-relaxed"
            placeholder="Type custom instructions for the co-pilot (e.g. 'Be extra sarcastic today' or 'Reference the boss fight')..."
            value={config.additionalInstructions}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const droppedText = e.dataTransfer.getData("text/plain");
              if (droppedText) {
                const currentText = config.additionalInstructions || "";
                const newText = currentText ? `${currentText}\
• Directive: ${droppedText}` : `• Directive: ${droppedText}`;
                updateConfig({ additionalInstructions: newText });
                toast.success("Dropped text appended to directives!");
              }
            }}
            onChange={(e) =>
              updateConfig({ additionalInstructions: e.target.value })
            }
          />
            <button
              type="button"
              onClick={() => updateConfig({ additionalInstructions: "" })}
              className="absolute top-1.5 right-1.5 text-gray-600 hover:text-red-400 transition-colors p-0.5"
              title="Clear directives"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
          {pttNeedsDownload && (
            <div className="flex flex-col gap-2 p-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex items-center gap-2">
                <Mic className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                <span className="text-[10px] text-purple-200">
                  Push-to-Talk needs the Whisper speech model (~150MB, cached after first use). No API key required.
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirmPttDownload();
                    if (ok) toast.success("Whisper model ready — PTT is good to go!");
                    else toast.error("Failed to download Whisper model");
                  }}
                  className="px-3 py-1 rounded text-[10px] font-bold uppercase bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/30 transition-all"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={cancelPttDownload}
                  className="px-3 py-1 rounded text-[10px] font-bold uppercase bg-white/5 text-gray-400 hover:bg-white/10 border border-white/10 transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* E1/E4: Creative Tools — Templates & Mood Lock */}
      <Card className="bg-[#0F0F12] border-white/5 shadow-none rounded-xl shrink-0">
        <CardHeader className="p-1.5 pb-0 flex flex-col space-y-0 gap-1">
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-gray-300 shrink-0 text-center w-full flex items-center justify-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-pink-400" />
            Creative Tools
          </CardTitle>
        </CardHeader>
        <CardContent className="p-1.5 pt-0.5 grid grid-cols-2 gap-x-2 gap-y-3">
          {/* E1: Templates */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">Forge Templates</span>
              <button
                onClick={() => setShowTemplateInput(!showTemplateInput)}
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded font-bold transition-colors",
                  showTemplateInput
                    ? "bg-pink-500/30 text-pink-200"
                    : "bg-pink-500/20 text-pink-300 hover:bg-pink-500/30",
                )}
              >
                {showTemplateInput ? "Cancel" : "+ Save Current"}
              </button>
            </div>
            {showTemplateInput && (
              <div className="bg-white/[0.03] border border-pink-500/20 rounded-lg p-2 space-y-1.5">
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Template name..."
                  className="w-full bg-black/40 border border-pink-500/20 rounded px-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 outline-none focus:border-pink-500/40"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && templateName.trim()) {
                      addForgeTemplate({
                        name: templateName.trim(),
                        description: "Custom template",
                        directives: config.additionalInstructions || "",
                        humorLevel: config.humorLevel,
                        chaosLevel: config.chaosLevel,
                        emoteDensity: config.emoteDensity,
                        lengthPreference: config.lengthPreference,
                      });
                      setTemplateName("");
                      setShowTemplateInput(false);
                      toast.success("Template saved");
                    }
                    if (e.key === "Escape") { setTemplateName(""); setShowTemplateInput(false); }
                  }}
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      if (!templateName.trim()) return;
                      addForgeTemplate({
                        name: templateName.trim(),
                        description: "Custom template",
                        directives: config.additionalInstructions || "",
                        humorLevel: config.humorLevel,
                        chaosLevel: config.chaosLevel,
                        emoteDensity: config.emoteDensity,
                        lengthPreference: config.lengthPreference,
                      });
                      setTemplateName("");
                      setShowTemplateInput(false);
                      toast.success("Template saved");
                    }}
                    disabled={!templateName.trim()}
                    className="flex-1 py-1 rounded text-[10px] font-bold bg-pink-500/20 text-pink-300 hover:bg-pink-500/30 transition-colors disabled:opacity-40"
                  >
                    Save Template
                  </button>
                </div>
              </div>
            )}
            {forgeTemplates.length === 0 ? (
              <p className="text-[10px] text-gray-600 italic">No templates yet. Save your current config as a template.</p>
            ) : (
              <div className="space-y-1 max-h-32 overflow-y-auto forge-scroll">
                {forgeTemplates.map((t) => (
                  <div key={t.id} className="flex items-center gap-1.5 bg-white/[0.02] rounded px-2 py-1 group">
                    <button
                      onClick={() => { applyForgeTemplate(t.id); toast.success(`Applied template: ${t.name}`); }}
                      className="flex-1 text-left text-[10px] text-gray-300 hover:text-pink-300 font-bold truncate"
                    >
                      {t.name}
                    </button>
                    <span className="text-[8px] text-gray-600">H{t.humorLevel} C{t.chaosLevel}</span>
                    <button
                      onClick={() => removeForgeTemplate(t.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* E4: Mood Lock */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">Mood Lock</span>
              <button
                onClick={() => {
                  if (moodLock.locked) {
                    setMoodLock(false, null);
                    setShowMoodPicker(false);
                    toast.success("Mood lock released");
                  } else {
                    setShowMoodPicker(!showMoodPicker);
                  }
                }}
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded font-bold transition-colors",
                  moodLock.locked
                    ? "bg-orange-500/20 text-orange-300 hover:bg-orange-500/30"
                    : showMoodPicker
                      ? "bg-orange-500/30 text-orange-200"
                      : "bg-white/5 text-gray-400 hover:bg-white/10",
                )}
              >
                {moodLock.locked ? `Locked: ${moodLock.mood}` : showMoodPicker ? "Cancel" : "Lock Mood"}
              </button>
            </div>
            {showMoodPicker && !moodLock.locked && (
              <div className="bg-white/[0.03] border border-orange-500/20 rounded-lg p-2 space-y-1.5">
                <span className="text-[9px] text-gray-500">Select mood to lock:</span>
                <div className="flex flex-wrap gap-1">
                  {(["hyped", "gremlin", "chill", "thoughtful", "chaotic", "sentimental"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        setMoodLock(true, m);
                        setShowMoodPicker(false);
                        toast.success(`Mood locked to: ${m}`);
                      }}
                      className="px-2 py-1 rounded text-[10px] font-bold bg-orange-500/10 text-orange-300 hover:bg-orange-500/25 border border-orange-500/20 transition-colors capitalize"
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[9px] text-gray-600 italic">
              {moodLock.locked
                ? "Mood is locked — personality engine will use this mood regardless of chat signals."
                : "Lock the bot's mood to prevent it from changing based on chat signals."}
            </p>
          </div>

          {/* E3: Variant History */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">Variant History</span>
              {variantHistory.length > 0 && (
                <button
                  onClick={() => clearVariantHistory()}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400 hover:bg-white/10 font-bold"
                >
                  Clear
                </button>
              )}
            </div>
            {variantHistory.length === 0 ? (
              <p className="text-[10px] text-gray-600 italic">No variants yet. Forge some messages to build history.</p>
            ) : (
              <div className="space-y-1 max-h-32 overflow-y-auto forge-scroll">
                {[...variantHistory].reverse().slice(0, 15).map((v) => (
                  <div key={v.id} className="flex items-start gap-1.5 bg-white/[0.02] rounded px-2 py-1 group">
                    <span className="text-[10px] text-gray-300 flex-1 truncate">{v.message}</span>
                    <div className="flex gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => rateVariantHistory(v.id, "good")}
                        className={cn("text-[10px]", v.rating === "good" ? "text-green-400" : "text-gray-600 hover:text-green-400")}
                        title="Good"
                      >👍</button>
                      <button
                        onClick={() => rateVariantHistory(v.id, "bad")}
                        className={cn("text-[10px]", v.rating === "bad" ? "text-red-400" : "text-gray-600 hover:text-red-400")}
                        title="Bad"
                      >👎</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* E5: Reaction Sequences */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">Reaction Sequences</span>
              <button
                onClick={() => setShowSequenceInput(!showSequenceInput)}
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded font-bold transition-colors",
                  showSequenceInput
                    ? "bg-pink-500/30 text-pink-200"
                    : "bg-pink-500/20 text-pink-300 hover:bg-pink-500/30",
                )}
              >
                {showSequenceInput ? "Cancel" : "+ Add"}
              </button>
            </div>
            {showSequenceInput && (
              <div className="bg-white/[0.03] border border-pink-500/20 rounded-lg p-2 space-y-1.5">
                <input
                  type="text"
                  value={sequenceName}
                  onChange={(e) => setSequenceName(e.target.value)}
                  placeholder="Sequence name (e.g. Hype Train)..."
                  className="w-full bg-black/40 border border-pink-500/20 rounded px-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 outline-none focus:border-pink-500/40"
                  autoFocus
                />
                <input
                  type="text"
                  value={sequenceReactions}
                  onChange={(e) => setSequenceReactions(e.target.value)}
                  placeholder="Reactions separated by | (e.g. POG|KEKW|EZ)..."
                  className="w-full bg-black/40 border border-pink-500/20 rounded px-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 outline-none focus:border-pink-500/40"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && sequenceName.trim() && sequenceReactions.trim()) {
                      const reactions = sequenceReactions.split("|").map(r => r.trim()).filter(Boolean);
                      if (reactions.length > 0) {
                        addReactionSequence({ name: sequenceName.trim(), reactions });
                        setSequenceName("");
                        setSequenceReactions("");
                        setShowSequenceInput(false);
                        toast.success("Reaction sequence saved");
                      }
                    }
                    if (e.key === "Escape") { setSequenceName(""); setSequenceReactions(""); setShowSequenceInput(false); }
                  }}
                />
                <button
                  onClick={() => {
                    if (!sequenceName.trim() || !sequenceReactions.trim()) return;
                    const reactions = sequenceReactions.split("|").map(r => r.trim()).filter(Boolean);
                    if (reactions.length > 0) {
                      addReactionSequence({ name: sequenceName.trim(), reactions });
                      setSequenceName("");
                      setSequenceReactions("");
                      setShowSequenceInput(false);
                      toast.success("Reaction sequence saved");
                    }
                  }}
                  disabled={!sequenceName.trim() || !sequenceReactions.trim()}
                  className="w-full py-1 rounded text-[10px] font-bold bg-pink-500/20 text-pink-300 hover:bg-pink-500/30 transition-colors disabled:opacity-40"
                >
                  Save Sequence
                </button>
              </div>
            )}
            {reactionSequences.length === 0 ? (
              <p className="text-[10px] text-gray-600 italic">No sequences yet. Create quick multi-emote reactions.</p>
            ) : (
              <div className="space-y-1 max-h-24 overflow-y-auto forge-scroll">
                {reactionSequences.map((seq) => (
                  <div key={seq.id} className="flex items-center gap-1.5 bg-white/[0.02] rounded px-2 py-1 group">
                    <span className="text-[10px] text-pink-300 font-bold">{seq.name}</span>
                    <span className="text-[10px] text-gray-400 truncate flex-1">{seq.reactions.join(" → ")}</span>
                    <button
                      onClick={() => {
                        const platform = useAppStore.getState().platform;
                        const channel = useAppStore.getState().streamMetadata?.channelName;
                        const sendFn = getPlatformSendFn(platform);
                        if (sendFn && channel) {
                          seq.reactions.forEach((r, i) => {
                            setTimeout(() => sendFn(channel, r).catch(console.error), i * 1500);
                          });
                          toast.success(`Sending sequence: ${seq.name}`);
                        } else {
                          toast.error("No platform connection available");
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[9px] px-1 rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 font-bold transition-opacity"
                    >
                      Send
                    </button>
                    <button
                      onClick={() => removeReactionSequence(seq.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

            {/* C3: AutoForge Multi-Action Sequences — launcher */}
            <div className="space-y-1.5">
              <button
                onClick={() => { setShowSequencesOverlay(true); playSfx("hud_open"); }}
                className="w-full flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-orange-400 hover:text-orange-300 transition-colors group"
              >
                <span className="flex items-center gap-1.5">
                  <Layers className="w-3 h-3" />
                  AutoForge Sequences
                  {autoForgeSequences.length > 0 && (
                    <span className="text-[9px] text-gray-500 normal-case font-mono">
                      {autoForgeSequences.length} · {autoForgeSequences.filter(s => s.enabled).length} active
                    </span>
                  )}
                </span>
                <span className="text-gray-500 group-hover:text-orange-300">open →</span>
              </button>
              {autoForgeSequences.length === 0 ? (
                <p className="text-[10px] text-gray-600 italic mt-0.5">No sequences yet. Click to open the sequence builder.</p>
              ) : (
                <div className="space-y-0.5 max-h-16 overflow-y-auto forge-scroll mt-1">
                  {autoForgeSequences.slice(0, 4).map((seq) => (
                    <div key={seq.id} className="flex items-center gap-1.5 text-[9px]">
                      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", seq.enabled ? "bg-green-400" : "bg-gray-600")} />
                      <span className="text-orange-300 font-bold truncate">{seq.name}</span>
                      <span className="text-gray-600 shrink-0">{seq.steps.length} steps</span>
                    </div>
                  ))}
                  {autoForgeSequences.length > 4 && (
                    <p className="text-[9px] text-gray-600 italic">+{autoForgeSequences.length - 4} more...</p>
                  )}
                </div>
              )}
            </div>

            {/* C1: AutoForge Rule Engine — launcher */}
            <div className="space-y-1.5">
              <button
                onClick={() => { setShowRuleBuilderOverlay(true); playSfx("hud_open"); }}
                className="w-full flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-cyan-400 hover:text-cyan-300 transition-colors group"
              >
                <span className="flex items-center gap-1.5">
                  <GitBranch className="w-3 h-3" />
                  Rule Engine
                  {autoForgeRules.length > 0 && (
                    <span className="text-[9px] text-gray-500 normal-case font-mono">
                      {autoForgeRules.length} · {autoForgeRules.filter(r => r.enabled).length} active
                    </span>
                  )}
                </span>
                <span className="text-gray-500 group-hover:text-cyan-300">open →</span>
              </button>
              {autoForgeRules.length === 0 ? (
                <p className="text-[10px] text-gray-600 italic mt-0.5">No rules yet. Create IF-THEN automations.</p>
              ) : (
                <div className="space-y-0.5 max-h-16 overflow-y-auto forge-scroll mt-1">
                  {autoForgeRules.slice(0, 4).map((rule) => (
                    <div key={rule.id} className="flex items-center gap-1.5 text-[9px]">
                      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", rule.enabled ? "bg-green-400" : "bg-gray-600")} />
                      <span className="text-cyan-300 font-bold truncate">{rule.name}</span>
                      {rule.fireCount > 0 && <span className="text-orange-400 shrink-0">🔥{rule.fireCount}</span>}
                      <span className="text-gray-600 shrink-0">{rule.conditions.length}c · {rule.actions.length}a</span>
                    </div>
                  ))}
                  {autoForgeRules.length > 4 && (
                    <p className="text-[9px] text-gray-600 italic">+{autoForgeRules.length - 4} more...</p>
                  )}
                </div>
              )}
            </div>

            {/* C5: Advanced Rate Limiting Controls — full width */}
            <div className="space-y-1.5 col-span-2 pt-2 border-t border-white/5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">Per-Action Rate Limits</span>
                <button
                  onClick={() => setShowRateLimitEditor(!showRateLimitEditor)}
                  className="text-[9px] text-gray-500 hover:text-cyan-400"
                >
                  {showRateLimitEditor ? "done" : "edit"}
                </button>
              </div>
              {showRateLimitEditor && (
                <div className="space-y-1.5 mb-2">
                  {Object.entries(perActionRateLimits).map(([actionType, limits]) => (
                    <div key={actionType} className="flex items-center gap-1.5 text-[9px]">
                      <span className="text-gray-400 w-20 truncate font-mono">{actionType}</span>
                      <label className="flex items-center gap-0.5">
                        <span className="text-gray-600">/hr</span>
                        <input
                          type="number"
                          value={limits.maxPerHour}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            setPerActionRateLimits({
                              ...perActionRateLimits,
                              [actionType]: { ...limits, maxPerHour: val },
                            });
                          }}
                          className="w-10 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-gray-200 font-mono"
                        />
                      </label>
                      <label className="flex items-center gap-0.5">
                        <span className="text-gray-600">/10m</span>
                        <input
                          type="number"
                          value={limits.maxPerTenMinutes}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            setPerActionRateLimits({
                              ...perActionRateLimits,
                              [actionType]: { ...limits, maxPerTenMinutes: val },
                            });
                          }}
                          className="w-10 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-gray-200 font-mono"
                        />
                      </label>
                      <label className="flex items-center gap-0.5">
                        <span className="text-gray-600">cd</span>
                        <input
                          type="number"
                          value={limits.cooldownMs / 1000}
                          onChange={(e) => {
                            const val = (parseInt(e.target.value) || 0) * 1000;
                            setPerActionRateLimits({
                              ...perActionRateLimits,
                              [actionType]: { ...limits, cooldownMs: val },
                            });
                          }}
                          className="w-10 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-gray-200 font-mono"
                        />
                        <span className="text-gray-600">s</span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
        </CardContent>
      </Card>

      </div>

      {/* 4. Big Forge Button — locked to bottom */}
      <div className="shrink-0" data-tutorial="forge-buttons">
        <div className="flex gap-1.5 items-stretch">
          {/* Model selector button */}
          <div data-tutorial="provider" className="relative shrink-0">
            <button
              type="button"
              onClick={() => setModelMenuOpen(!modelMenuOpen)}
              className="h-11 px-2.5 flex items-center gap-1 rounded-lg bg-green-900/30 border border-green-700/30 text-green-500 hover:bg-green-900/50 hover:border-green-600/40 transition-all text-[10px] font-bold uppercase tracking-wider font-mono whitespace-nowrap"
              title="Active Provider Model"
            >
              {provider === 'gemini' ? 'Gem' : provider === 'gemini-env' ? 'Gem-E' : provider === 'gemini-pro' ? 'Gem+' : provider === 'openai' ? 'GPT' : provider === 'anthropic' ? 'Claude' : provider === 'ollama' ? 'Ollama' : 'OR'}
              <ChevronDown className="w-3 h-3 opacity-60" />
            </button>
            {modelMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setModelMenuOpen(false)} />
                <div className="absolute bottom-full left-0 mb-1 z-50 w-56 bg-[#0a0a0f] border border-white/10 rounded-lg shadow-2xl py-1 font-mono">
                  {[
                    { value: 'gemini', label: 'Gemini 3.8 Flash', desc: 'Recommended' },
                    { value: 'gemini-env', label: 'Gemini 3.8 Flash (Strict Env)', desc: 'Environment API' },
                    { value: 'gemini-pro', label: 'Gemini 3.7 Flash', desc: 'Alternate Flash' },
                    { value: 'openai', label: 'GPT-5.6 Luna', desc: 'Fast & cost-efficient' },
                    { value: 'anthropic', label: 'Claude Haiku 4.5', desc: 'Fast & affordable' },
                    { value: 'openrouter', label: 'OpenRouter / Custom', desc: 'Custom API' },
                    { value: 'ollama', label: 'Ollama / Local', desc: 'No key needed' },
                  ].map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => { handleProviderChange(m.value); setModelMenuOpen(false); }}
                      className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition-colors ${provider === m.value ? 'bg-green-500/10 text-green-400' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
                    >
                      <div className="flex flex-col">
                        <span className="text-[11px] font-bold">{m.label}</span>
                        <span className="text-[9px] opacity-50">{m.desc}</span>
                      </div>
                      {provider === m.value && <span className="text-green-400 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <Button
            className="flex-1 h-11 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 text-white font-black text-sm tracking-widest shadow-[0_0_24px_rgba(249,115,22,0.35)] gap-2"
            onClick={() => handleForge()}
            disabled={isForging}
          >
            {isForging ? (
              <>
                <Bot className="w-4 h-4 animate-spin" /> FORGING...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 text-white fill-current animate-pulse" /> FORGE SMART
              </>
            )}
          </Button>
          {[1, 2, 3, 4].map((n) => (
            <Button
              key={n}
              className={`w-11 h-11 font-black text-sm shadow-lg transition-all ${
                n === 1 ? "bg-orange-500/80 hover:bg-orange-400/80 text-white shadow-orange-500/20" :
                n === 2 ? "bg-orange-600/80 hover:bg-orange-500/80 text-white shadow-orange-600/20" :
                n === 3 ? "bg-red-600/80 hover:bg-red-500/80 text-white shadow-red-600/20" :
                          "bg-red-700/80 hover:bg-red-600/80 text-white shadow-red-700/20"
              }`}
              onClick={() => handleForge(n)}
              disabled={isForging}
            >
              {n}
            </Button>
          ))}
        </div>
      </div>

      {/* C3: AutoForge Sequences Full-Page Overlay */}
      <AutoForgeSequencesOverlay open={showSequencesOverlay} onClose={() => setShowSequencesOverlay(false)} />

      {/* C1: AutoForge Rule Engine Full-Page Overlay */}
      <RuleBuilderOverlay open={showRuleBuilderOverlay} onClose={() => setShowRuleBuilderOverlay(false)} />

    </div>
  );
}
