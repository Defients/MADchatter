import React, { useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { ForgeLayout } from './components/ForgeLayout';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './components/ui/command';
import { useAppStore } from './store';
import { toast } from 'sonner';
import tmi from 'tmi.js';
import { useAutoForge } from './hooks/useAutoForge';
import { useMultiBotOrchestrator } from './hooks/useMultiBotOrchestrator';
import { useAutoMemory } from './hooks/useAutoMemory';
import { useVoiceCommands } from './hooks/useVoiceCommands';
import { AutoForgeHUD } from './components/AutoForgeHUD';
import { AnimatedBackground } from './components/AnimatedBackground';
import { CosmoTechBackground } from './components/CosmoTechBackground';
import { CorruptureBackground } from './components/CorruptureBackground';
import { MentionOverlay } from './components/MentionOverlay';
import { StatusBar } from './components/StatusBar';
import { ShortcutHelp } from './components/ShortcutHelp';
import { useBotToggleShortcuts } from './hooks/useBotToggleShortcuts';
import { WelcomeOverlay } from './components/WelcomeOverlay';
import { RageCursor } from './components/RageCursor';
import { EasterEggs } from './components/EasterEggs';
import { MobileAdvisory } from './components/MobileAdvisory';
import { useIsMobile } from './hooks/useMediaQuery';
import { getKeys } from './lib/keys';
import { tmiSendManager } from './lib/twitch';
import { KickChatClient, kickSendManager, fetchKickMetadata } from './lib/kick';
import { JoystickChatClient, getJoystickBasicAuthKey, getJoystickSession, getJoystickBotUsername } from './lib/joystick';
import { getPlatformSendFn } from './lib/platformSend';
import { playMessageSound, setAudioOutputSink, setSoundUrl, setSoundVolume } from './lib/sound';
import { playSfx, initSfxAudioContext } from './lib/sfx';
import { createChatMessage } from './lib/chatUtils';
import type { ChatMessage } from './types';
import { classifySentiment } from './lib/sentiment';
import { requestNotificationPermission, notifyMention } from './lib/notifications';
import { messageQueue, startQueueProcessor } from './lib/messageQueue';

// Lazy-load heavy panels/overlays — only loaded when opened, reducing initial bundle on mobile.
const AutoForgeReport = lazy(() => import('./components/AutoForgeReport').then(m => ({ default: m.AutoForgeReport })));
const TutorialWalkthrough = lazy(() => import('./components/TutorialWalkthrough').then(m => ({ default: m.TutorialWalkthrough })));
const MemoryPanel = lazy(() => import('./components/MemoryPanel').then(m => ({ default: m.MemoryPanel })));
const AnalyticsPanel = lazy(() => import('./components/AnalyticsPanel').then(m => ({ default: m.AnalyticsPanel })));
const VisualHistoryOverlay = lazy(() => import('./components/VisualHistoryOverlay').then(m => ({ default: m.VisualHistoryOverlay })));

export default function App() {
  const [openCommand, setOpenCommand] = React.useState(false);
  const [konamiActive, setKonamiActive] = React.useState(false);
  const [maxRageShake, setMaxRageShake] = React.useState(false);
  const [maxRageSettled, setMaxRageSettled] = React.useState(false);
  const isMobile = useIsMobile();
  const { 
    clearAllContext, 
    setVariants, 
    streamMetadata,
    updateStreamMetadata,
    markUserBanned,
    variants,
    setTmiReadState,
    setTmiSendState,
    incrementMessagesReceived,
    platform,
    theme,
    setTheme,
    messageSoundEnabled,
    audioOutputDeviceId,
    customSoundUrl,
    soundVolume,
    hypeLevel,
    cursorTrailEnabled,
  } = useAppStore();

  const tmiClientRef = useRef<tmi.Client | null>(null);
  const kickClientRef = useRef<KickChatClient | null>(null);
  const joystickClientRef = useRef<JoystickChatClient | null>(null);

  // Chat message batching buffer — flushes every 500ms to reduce re-renders on fast chat
  const chatBatchRef = useRef<ChatMessage[]>([]);
  const chatBatchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    chatBatchTimerRef.current = setInterval(() => {
      const batch = chatBatchRef.current;
      if (batch.length > 0) {
        chatBatchRef.current = [];
        useAppStore.getState().appendChatLogBatch(batch);
      }
    }, 500);
    return () => {
      if (chatBatchTimerRef.current) clearInterval(chatBatchTimerRef.current);
      // Flush any remaining
      const batch = chatBatchRef.current;
      if (batch.length > 0) {
        chatBatchRef.current = [];
        useAppStore.getState().appendChatLogBatch(batch);
      }
    };
  }, []);

  // Helper: queue a chat message for batched append
  const queueChatMessage = useCallback((msg: ChatMessage) => {
    chatBatchRef.current.push(msg);
    // If buffer gets too large, flush immediately
    if (chatBatchRef.current.length >= 50) {
      const batch = chatBatchRef.current;
      chatBatchRef.current = [];
      useAppStore.getState().appendChatLogBatch(batch);
    }
  }, []);

  // Expose joystick client globally for send manager to access
  useEffect(() => {
    window.__joystickChatClient = joystickClientRef.current;
  });

  // Refs to avoid re-subscribing keyboard listener on every variant change
  const variantsRef = useRef(variants);
  variantsRef.current = variants;
  const channelRef = useRef(streamMetadata?.channelName);
  channelRef.current = streamMetadata?.channelName;

  // Initialize AutoForge loop (legacy single-bot; self-disables in multi-bot mode)
  useAutoForge();
  // Multi-bot orchestrator (no-op unless multiBotEnabled === true). Returns JSX
  // that mounts one useAutoForgeBot loop per active+authenticated bot — MUST be
  // rendered, otherwise the per-bot AutoForge loops never run.
  const multiBotLoops = useMultiBotOrchestrator();
  // 1–9 shortcuts to toggle each bot on/off (no-op unless multi-bot is engaged)
  useBotToggleShortcuts();
  useAutoMemory();

  // Voice commands system
  const voiceCommands = useVoiceCommands();
  useEffect(() => {
    window.__voiceCommands = voiceCommands;
  }, [voiceCommands]);

  // Easter egg class listeners (konami rainbow + max-rage shake)
  useEffect(() => {
    const onKonami = (e: Event) => setKonamiActive((e as CustomEvent).detail.active);
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onMaxRage = (e: Event) => {
      const active = (e as CustomEvent).detail.active;
      setMaxRageShake(active);
      if (active) {
        // After 5s of intense shaking, settle into the periodic rumble
        setMaxRageSettled(false);
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => setMaxRageSettled(true), 5000);
      } else {
        if (settleTimer) clearTimeout(settleTimer);
        setMaxRageSettled(false);
      }
    };
    window.addEventListener('easter-egg-konami', onKonami);
    window.addEventListener('easter-egg-max-rage', onMaxRage);
    return () => {
      window.removeEventListener('easter-egg-konami', onKonami);
      window.removeEventListener('easter-egg-max-rage', onMaxRage);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, []);

  // 1. Load deepgram key from localStorage on startup
  useEffect(() => {
    const keys = getKeys();
    if (keys.deepgramKey) {
      localStorage.setItem('VITE_DEEPGRAM_API_KEY', keys.deepgramKey);
    }
  }, []);

  // 1b. Restore audio output device and custom sound URL on startup
  useEffect(() => {
    if (audioOutputDeviceId) {
      setAudioOutputSink(audioOutputDeviceId);
    }
    if (customSoundUrl) {
      setSoundUrl(customSoundUrl);
    }
    setSoundVolume(soundVolume);
  }, [audioOutputDeviceId, customSoundUrl, soundVolume]);

  // 1c. Initialize SFX audio context on first user interaction
  useEffect(() => {
    const init = () => { initSfxAudioContext(); };
    window.addEventListener('click', init, { once: true });
    window.addEventListener('keydown', init, { once: true });
    return () => {
      window.removeEventListener('click', init);
      window.removeEventListener('keydown', init);
    };
  }, []);

  // 1d. Request notification permission & start message queue processor
  useEffect(() => {
    const { desktopNotificationsEnabled } = useAppStore.getState();
    if (desktopNotificationsEnabled) requestNotificationPermission();
    const stopQueue = startQueueProcessor();
    const unsubQueue = messageQueue.onDepthChange((depth) => {
      useAppStore.getState().setMessageQueueDepth(depth);
    });
    return () => { stopQueue(); unsubQueue(); };
  }, []);

  // 1e. Desktop notification permission toggle watcher
  const desktopNotificationsEnabled = useAppStore((s) => s.desktopNotificationsEnabled);
  useEffect(() => {
    if (desktopNotificationsEnabled) requestNotificationPermission();
  }, [desktopNotificationsEnabled]);

  // Helper: process incoming chat message (sentiment + activity + chatter stats + keyword triggers)
  const processIncomingMessage = async (username: string, text: string, platform: string, badges: string[] = []) => {
    const state = useAppStore.getState();
    // Classify sentiment
    const { label, score } = classifySentiment(text);
    state.addSentimentReading({ timestamp: Date.now(), label, score, username, text });
    // Record chat activity for heatmap
    state.recordChatActivity();
    // Update chatter leaderboard stats
    const botUsername = platform === 'kick' ? window.__kickSession?.username : platform === 'joystick' ? window.__joystickSession?.username : window.__twitchSession?.username;
    const isMention = botUsername ? text.toLowerCase().includes(botUsername.toLowerCase()) : false;
    state.updateChatterStats(username, label, isMention, badges);

    // Evaluate keyword trigger rules
    const rules = useAppStore.getState().keywordTriggerRules;
    for (const rule of rules) {
      if (!rule.enabled) continue;
      let matched = false;
      try {
        if (rule.isRegex) {
          const flags = rule.caseSensitive ? '' : 'i';
          matched = new RegExp(rule.pattern, flags).test(text);
        } else {
          matched = rule.caseSensitive
            ? text.includes(rule.pattern)
            : text.toLowerCase().includes(rule.pattern.toLowerCase());
        }
      } catch { /* invalid regex — skip */ }
      if (matched) {
        useAppStore.getState().incrementTriggerMatch(rule.id);
        if (rule.actions.toast) {
          toast.warning(`Trigger: ${rule.label}`, { description: `${username}: ${text.slice(0, 80)}` });
        }
        if (rule.actions.notify && useAppStore.getState().desktopNotificationsEnabled) {
          notifyMention(username, `[${rule.label}] ${text}`);
        }
        if (rule.actions.sound) {
          playSfx('mention_alert');
        }
        if (rule.actions.forceAutoForge) {
          window.dispatchEvent(new CustomEvent("autoforge-force-check"));
        }
      }
    }
  };

  // 2. Real-time Chat background sync (Twitch via tmi.js OR Kick via Pusher WebSocket)
  useEffect(() => {
    const channel = streamMetadata?.channelName;
    if (!channel) return;

    let cancelled = false;

    if (platform === 'joystick') {
      const basicAuthKey = getJoystickBasicAuthKey();
      if (!basicAuthKey) {
        console.error('App.tsx: Joystick basic auth key not configured — cannot connect WebSocket');
        setTmiReadState('error');
        return;
      }
      const joystickClient = new JoystickChatClient(basicAuthKey);
      joystickClientRef.current = joystickClient;

      joystickClient.onMessage((username, content) => {
        queueChatMessage(createChatMessage(username, content, 'joystick'));
        incrementMessagesReceived();
        processIncomingMessage(username, content, 'joystick');
        const botName = getJoystickBotUsername();
        if (messageSoundEnabled && botName && username.toLowerCase() === botName.toLowerCase()) playMessageSound();
      });

      joystickClient.onStateChange((state) => {
        console.log('[App.tsx] Joystick state change:', state);
        setTmiReadState(state as any);
        if (state === 'connected') playSfx('connect');
        else if (state === 'disconnected' || state === 'error') playSfx('disconnect');
      });

      setTmiReadState('connecting');
      const connectTimer = setTimeout(() => {
        if (cancelled) return;
        console.log('App.tsx: Connecting Joystick WebSocket to channel:', channel);
        joystickClient.connect(channel).catch((err) => {
          if (!cancelled) {
            console.error('Joystick WebSocket connection failed:', err);
            setTmiReadState('error');
          }
        });
        window.__joystickChatClient = joystickClient;
      }, 100);

      return () => {
        cancelled = true;
        clearTimeout(connectTimer);
        joystickClient.disconnect();
        joystickClientRef.current = null;
        window.__joystickChatClient = null;
        setTmiReadState('disconnected');
      };
    }

    if (platform === 'kick') {
      const kickClient = new KickChatClient();
      kickClientRef.current = kickClient;

      kickClient.onMessage((username, content) => {
        queueChatMessage(createChatMessage(username, content, 'kick'));
        incrementMessagesReceived();
        processIncomingMessage(username, content, 'kick');
      });

      kickClient.onStateChange((state) => {
        setTmiReadState(state as any);
        if (state === 'connected') playSfx('connect');
        else if (state === 'disconnected' || state === 'error') playSfx('disconnect');
      });

      setTmiReadState('connecting');
      const connectTimer = setTimeout(() => {
        if (cancelled) return;
        console.log("App.tsx: Connecting Kick WebSocket to channel:", channel);
        kickClient.connect(channel).catch((err) => {
          if (!cancelled) {
            console.error("Kick WebSocket connection failed:", err);
            setTmiReadState('error');
          }
        });
      }, 100);

      return () => {
        cancelled = true;
        clearTimeout(connectTimer);
        kickClient.disconnect();
        kickClientRef.current = null;
        setTmiReadState('disconnected');
      };
    }

    // Twitch (default)
    const client = new tmi.Client({
      connection: {
        secure: true,
        reconnect: true
      },
      channels: [channel],
    });

    client.on('message', (channel, tags, message, self) => {
      if (self) return;
      const username = tags['display-name'] || tags.username || 'user';
      queueChatMessage(createChatMessage(username, message, 'twitch'));
      incrementMessagesReceived();
      processIncomingMessage(username, message, 'twitch');
    });

    client.on('ban', (_channel, username, _reason) => {
      markUserBanned(username);
    });
    client.on('timeout', (_channel, username, _reason, _duration) => {
      markUserBanned(username);
    });

    // C2: Stream event awareness — follows, subs, raids, cheers, hosts
    client.on('subscription', (_channel, username, methods, _message, _userstate) => {
      const plan = methods?.plan ? String(methods.plan) : "1000";
      useAppStore.getState().addStreamEvent(`🔔 ${username} subscribed (${methods.prime ? "Prime" : "Tier " + (Number(plan) / 1000)})`);
    });
    client.on('resub', (_channel, username, _months, _message, _userstate, methods) => {
      const plan = methods?.plan ? String(methods.plan) : "1000";
      useAppStore.getState().addStreamEvent(`🔔 ${username} resubscribed (${methods?.prime ? "Prime" : "Tier " + (Number(plan) / 1000)})`);
    });
    client.on('subgift', (_channel, username, _streakMonths, recipient, methods, _userstate) => {
      const plan = methods?.plan ? String(methods.plan) : "1000";
      useAppStore.getState().addStreamEvent(`🎁 ${username} gifted a sub to ${recipient} (${methods?.prime ? "Prime" : "Tier " + (Number(plan) / 1000)})`);
    });
    client.on('raided', (_channel, username, viewers) => {
      useAppStore.getState().addStreamEvent(`⚔️ ${username} raided with ${viewers} viewers`);
    });
    client.on('cheer', (_channel, _userstate, message) => {
      const bits = _userstate.bits || 0;
      const username = _userstate['display-name'] || _userstate.username || 'Someone';
      useAppStore.getState().addStreamEvent(`💎 ${username} cheered ${bits} bits: "${message}"`);
    });
    client.on('hosted', (_channel, username, viewers) => {
      useAppStore.getState().addStreamEvent(`📺 ${username} hosted with ${viewers || 0} viewers`);
    });

    client.on('connected', () => { setTmiReadState('connected'); playSfx('connect'); });
    client.on('disconnected', () => { setTmiReadState('disconnected'); playSfx('disconnect'); });
    client.on('connecting', () => setTmiReadState('connecting'));

    setTmiReadState('connecting');
    // Defer connection to avoid StrictMode double-mount race condition
    const connectTimer = setTimeout(() => {
      if (cancelled) return;
      console.log("App.tsx: Connecting tmi.js to channel:", channel);
      tmiClientRef.current = client;
      client.connect().catch((err) => {
        if (!cancelled) {
          console.error("tmi.js connection failed:", err);
          setTmiReadState('error');
        }
      });
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(connectTimer);
      if (tmiClientRef.current) {
        console.log("App.tsx: Disconnecting tmi.js from channel:", channel);
        tmiClientRef.current.disconnect();
        tmiClientRef.current = null;
      }
      setTmiReadState('disconnected');
    };
  }, [streamMetadata?.channelName, queueChatMessage, markUserBanned, incrementMessagesReceived, setTmiReadState, platform]);

  // 3. Periodic metadata polling (Twitch via decapi.me OR Kick via Kick API)
  useEffect(() => {
    const channel = streamMetadata?.channelName;
    if (!channel) return;

    const fetchMeta = async () => {
      try {
        if (platform === 'joystick') {
          // Joystick metadata is derived from WebSocket StreamEvents, not REST API.
          // No polling needed — metadata updates arrive in real-time via the chat client.
        } else if (platform === 'kick') {
          const meta = await fetchKickMetadata(channel);
          if (meta) {
            const current = useAppStore.getState().streamMetadata;
            updateStreamMetadata({
              category: meta.category || current.category,
              title: meta.title || current.title,
              viewerCount: meta.viewerCount || current.viewerCount,
            });
          }
        } else {
          const [game, title, viewers] = await Promise.all([
            fetch(`https://decapi.me/twitch/game/${channel}`).then((r) => r.text()),
            fetch(`https://decapi.me/twitch/title/${channel}`).then((r) => r.text()),
            fetch(`https://decapi.me/twitch/viewercount/${channel}`).then((r) => r.text()),
          ]);

          const current = useAppStore.getState().streamMetadata;
          updateStreamMetadata({
            category: !game.includes("User not found") ? game : current.category,
            title: !title.includes("User not found") ? title : current.title,
            viewerCount: !viewers.includes("User not found") && !isNaN(parseInt(viewers))
              ? parseInt(viewers)
              : current.viewerCount,
          });
        }
      } catch (e) {
        console.error("App.tsx: metadata fetch failed", e);
      }
    };

    fetchMeta();
    const interval = setInterval(fetchMeta, 60000);
    return () => clearInterval(interval);
  }, [streamMetadata?.channelName, platform]);

  // 4. Send connection state listener (Twitch or Kick)
  useEffect(() => {
    if (platform === 'kick') {
      const unsub = kickSendManager.onStateChange((state) => {
        setTmiSendState(state as any);
      });
      return () => { unsub(); };
    }
    const unsub = tmiSendManager.onStateChange((state) => {
      setTmiSendState(state as any);
    });
    return () => { unsub(); };
  }, [setTmiSendState, platform]);

  // 5. Keyboard Shortcuts listener (Ctrl+K palette & hotkeys F, C, S, A, R, H)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle Command Palette (⌘K / Ctrl+K)
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpenCommand((open) => !open);
        playSfx('palette_open');
        return;
      }

      // Skip single-key shortcuts when user is typing in inputs or textareas
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      // Hotkey: Esc = Dismiss mention overlay
      if (e.key === 'Escape') {
        window.dispatchEvent(new CustomEvent('mention-overlay-dismiss'));
        return;
      }

      // Hotkey: F = Forge
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('forge-trigger'));
        return;
      }

      // Hotkey: C = Capture (skip if Ctrl/Cmd held — allow copy)
      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('capture-trigger'));
        return;
      }

      // Hotkey: S = Send Focused/Top variant
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSendTopVariant();
        return;
      }

      // Hotkey: A = Toggle AutoForge
      if (e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const s = useAppStore.getState();
        const newVal = !s.autoForgeEnabled;
        s.setAutoForgeEnabled(newVal);
        s.addAutoForgeEvent({
          timestamp: Date.now(),
          type: "enable_disable",
          severity: "medium",
          summary: `AutoForge ${newVal ? "enabled" : "disabled"}`,
          details: { enabled: newVal },
        });
        toast.success(`AutoForge is now ${newVal ? 'enabled' : 'disabled'}`);
        playSfx(newVal ? 'autoforge_on' : 'autoforge_off');
        return;
      }

      // Hotkey: H = Toggle AutoForge HUD
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        const s = useAppStore.getState();
        const isOpening = !s.isAutoForgeHUDOpen;
        s.setIsAutoForgeHUDOpen(isOpening);
        playSfx(isOpening ? 'hud_open' : 'hud_close');
        return;
      }

      // Hotkey: T = Cycle Theme (default → cosmotech → corrupture → default)
      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        const s = useAppStore.getState();
        const themes: ("default" | "cosmotech" | "corrupture")[] = ["default", "cosmotech", "corrupture"];
        const currentIdx = themes.indexOf(s.theme);
        const nextTheme = themes[(currentIdx + 1) % themes.length];
        s.setTheme(nextTheme);
        const themeName = nextTheme === "default" ? "Default" : nextTheme === "cosmotech" ? "CosmoTech™" : "Corrupture™";
        toast.success(`${themeName} theme enabled`);
        playSfx('theme_toggle');
        return;
      }

      // Hotkey: D = Toggle Analytics Dashboard
      if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const s = useAppStore.getState();
        const isOpening = !s.analyticsPanelOpen;
        s.setAnalyticsPanelOpen(isOpening);
        playSfx(isOpening ? 'hud_open' : 'hud_close');
        return;
      }

      // Hotkey: V = Open Visual Snapshot History
      if (e.key.toLowerCase() === 'v') {
        e.preventDefault();
        const s = useAppStore.getState();
        s.setVisualHistoryOpen(true);
        playSfx('hud_open');
        return;
      }

      // Hotkey: Shift+R = Toggle R34L Typing Mode
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        const s = useAppStore.getState();
        const newVal = !s.r34lEnabled;
        s.setR34lEnabled(newVal);
        toast.success(`R34L mode is now ${newVal ? 'enabled' : 'disabled'}`);
        playSfx('theme_toggle');
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSendTopVariant = async () => {
    if (!variantsRef.current || variantsRef.current.length === 0) {
      toast.error("No variants available. Forge a batch first!");
      return;
    }
    const topMsg = variantsRef.current[0].message;
    const channelName = channelRef.current;
    if (!channelName) {
      toast.error("No channel set. Set a channel name first.");
      return;
    }
    const toastId = toast.loading(`Sending top variant to @${channelName}...`);

    const currentPlatform = useAppStore.getState().platform;
    try {
      const sendFn = getPlatformSendFn(currentPlatform);
      await sendFn(channelName, topMsg);
      useAppStore.getState().addSentMessage({
        message: topMsg,
        channel: channelName,
        timestamp: Date.now(),
        source: "manual",
      });
      useAppStore.getState().incrementMessagesSent();
      useAppStore.getState().incrementStat("manualActions");
      const platformLabel = currentPlatform === 'kick' ? 'Kick' : currentPlatform === 'joystick' ? 'Joystick' : 'Twitch';
      toast.success(`Sent top variant to ${platformLabel} chat!`, { id: toastId });
      playSfx('send_message');
    } catch (e: any) {
      toast.error(e.message || "Failed to send top variant", { id: toastId });
      playSfx('error');
    }
  };

  return (
    <div className={`flex flex-col h-dvh bg-[#0b0b11] text-[#e0e0e6] overflow-hidden font-sans relative z-0 ${!isMobile && cursorTrailEnabled ? 'select-none rage-cursor-active' : ''} ${theme === 'cosmotech' ? 'cosmotech' : ''} ${theme === 'corrupture' ? 'corrupture' : ''} ${konamiActive ? 'konami-active' : ''} ${maxRageShake ? (maxRageSettled ? 'max-rage-shake-settled' : 'max-rage-shake') : ''}`}>
      {/* Skip link — keyboard / screen-reader accessibility */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-lg focus:bg-orange-500 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white">
        Skip to main content
      </a>
      <MobileAdvisory />
      {theme === 'cosmotech' ? <CosmoTechBackground /> : theme === 'corrupture' ? <CorruptureBackground /> : <AnimatedBackground />}
      <MentionOverlay />
      {/* B12: Hype Mode Visual Effect */}
      {hypeLevel >= 2 && <div className="hype-mode-overlay" />}
      <div id="main-content" className="contents">
      <ForgeLayout />
      </div>
      {/* Per-bot AutoForge loops (renders null; mounts the useAutoForgeBot
          instances that drive multi-bot AutoForge). */}
      {multiBotLoops}

      {/* Command Palette (⌘K) */}
      {openCommand && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/70 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Command Palette" onClick={() => { setOpenCommand(false); playSfx('palette_close'); }} onKeyDown={(e) => { if (e.key === 'Escape') { setOpenCommand(false); playSfx('palette_close'); } }}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg">
            <Command className="rounded-2xl border border-white/[0.08] shadow-[var(--elev-4)] bg-[#131318] text-white max-w-lg overflow-hidden">
              <CommandInput placeholder="Type a command or search..." className="text-white placeholder:text-gray-500" autoFocus />
              <CommandList className="max-h-72">
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup heading="Actions" className="text-gray-400">
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    window.dispatchEvent(new CustomEvent('forge-trigger')); 
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Forge New Batch (HotKey: F)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    window.dispatchEvent(new CustomEvent('capture-trigger')); 
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Capture Browser Stream (HotKey: C)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    handleSendTopVariant(); 
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Send Top Variant to Chat (HotKey: S)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    const s = useAppStore.getState();
                    const newVal = !s.autoForgeEnabled;
                    s.setAutoForgeEnabled(newVal);
                    s.addAutoForgeEvent({ timestamp: Date.now(), type: "enable_disable", severity: "medium", summary: `AutoForge ${newVal ? "enabled" : "disabled"}`, details: { enabled: newVal } });
                    toast.success(`AutoForge is now ${newVal ? 'enabled' : 'disabled'}`);
                    playSfx(newVal ? 'autoforge_on' : 'autoforge_off');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Toggle AutoForge (HotKey: A)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    const s = useAppStore.getState();
                    const newVal = !s.r34lEnabled;
                    s.setR34lEnabled(newVal);
                    toast.success(`R34L mode is now ${newVal ? 'enabled' : 'disabled'}`);
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Toggle R34L Typing Mode (HotKey: Shift+R)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    const s = useAppStore.getState();
                    const newVal = !s.autoForgeDryRun;
                    s.setAutoForgeDryRun(newVal);
                    toast.success(`AutoForge Dry Run is now ${newVal ? 'enabled' : 'disabled'}`, { description: newVal ? 'Decisions will be logged but not sent.' : 'Messages will be sent as normal.' });
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Toggle AutoForge Dry Run Mode
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    useAppStore.getState().setAnalyticsPanelOpen(true); 
                    playSfx('hud_open');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Open Analytics Dashboard
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    useAppStore.getState().setAnalyticsPanelOpen(true); 
                    playSfx('hud_open');
                    // Scroll to token usage section after render
                    setTimeout(() => {
                      const el = document.querySelector('[data-section="token-usage"]');
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    View Token Usage (by Feature)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    useAppStore.getState().setVisualHistoryOpen(true); 
                    playSfx('hud_open');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Open Visual Snapshot History
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    const s = useAppStore.getState();
                    const isOpening = !s.isAutoForgeHUDOpen;
                    s.setIsAutoForgeHUDOpen(isOpening);
                    playSfx(isOpening ? 'hud_open' : 'hud_close');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Toggle AutoForge HUD (HotKey: H)
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    const ta = document.querySelector('textarea[placeholder*="Custom instructions"]') as HTMLTextAreaElement;
                    if (ta) ta.focus();
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Focus Tuning Instructions
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    useAppStore.getState().setIsAutoForgeReportOpen(true); 
                    playSfx('report_open');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    View AutoForge Report
                  </CommandItem>
                  <CommandItem onSelect={() => { 
                    setOpenCommand(false); 
                    playSfx('palette_select');
                    const s = useAppStore.getState();
                    const themes: ("default" | "cosmotech" | "corrupture")[] = ["default", "cosmotech", "corrupture"];
                    const currentIdx = themes.indexOf(s.theme);
                    const nextTheme = themes[(currentIdx + 1) % themes.length];
                    s.setTheme(nextTheme);
                    const themeName = nextTheme === "default" ? "Default" : nextTheme === "cosmotech" ? "CosmoTech™" : "Corrupture™";
                    toast.success(`${themeName} theme enabled`);
                    playSfx('theme_toggle');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Cycle Theme (Default / CosmoTech™ / Corrupture™)
                  </CommandItem>
                </CommandGroup>
                <CommandGroup heading="Help" className="text-gray-400 border-t border-white/[0.04] pt-2">
                  {!isMobile && (
                  <CommandItem onSelect={() => { setOpenCommand(false); playSfx('palette_select'); window.dispatchEvent(new CustomEvent('tutorial-start')); }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Start Tutorial Walkthrough
                  </CommandItem>
                  )}
                </CommandGroup>
                <CommandGroup heading="Management" className="text-gray-400 border-t border-white/[0.04] pt-2">
                  <CommandItem onSelect={() => { clearAllContext(); setOpenCommand(false); toast.success('Workspace context cleared'); playSfx('clear_context'); }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Clear All Context
                  </CommandItem>
                  <CommandItem onSelect={() => { setVariants([]); setOpenCommand(false); toast.success('Variants cleared'); playSfx('clear_context'); }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Clear Variants
                  </CommandItem>
                  <CommandItem onSelect={() => {
                    setOpenCommand(false);
                    playSfx('palette_select');
                    const json = useAppStore.getState().exportSettings();
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `autoforge-settings-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast.success('Settings exported');
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Export Settings
                  </CommandItem>
                  <CommandItem onSelect={() => {
                    setOpenCommand(false);
                    playSfx('palette_select');
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'application/json,.json';
                    input.onchange = (e: any) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        const ok = useAppStore.getState().importSettings(reader.result as string);
                        if (ok) toast.success('Settings imported successfully');
                        else toast.error('Failed to import settings — invalid file');
                      };
                      reader.readAsText(file);
                    };
                    input.click();
                  }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Import Settings
                  </CommandItem>
                  <CommandItem onSelect={() => { setOpenCommand(false); playSfx('palette_select'); window.dispatchEvent(new CustomEvent('forge-reset-layout')); }} className="text-white aria-selected:bg-white/10 aria-selected:text-white cursor-pointer py-2.5">
                    Reset Layout to FHD Defaults
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        </div>
      )}

      <AutoForgeHUD />
      <Suspense fallback={null}><AutoForgeReport /></Suspense>
      <Suspense fallback={null}><MemoryPanel /></Suspense>
      <Suspense fallback={null}><AnalyticsPanel /></Suspense>
      <Suspense fallback={null}><VisualHistoryOverlay /></Suspense>
      <StatusBar />
      <ShortcutHelp />
      <WelcomeOverlay />
      {!isMobile && <Suspense fallback={null}><TutorialWalkthrough /></Suspense>}
      {!isMobile && cursorTrailEnabled && <RageCursor />}
      <EasterEggs />
    </div>
  );
}
