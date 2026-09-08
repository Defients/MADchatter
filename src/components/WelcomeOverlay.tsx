import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  Flame,
  Eye,
  AudioLines,
  MessageSquare,
  Brain,
  Tv,
  Bot,
  Zap,
  Sparkles,
  Keyboard,
  ChevronRight,
  CheckCircle2,
  Circle,
  Info,
  ExternalLink,
  Mail,
} from "lucide-react";
import { useTwitchAuth } from "../hooks/useTwitchAuth";
import { playSfx } from "../lib/sfx";
import { useKickAuth } from "../hooks/useKickAuth";
import { useJoystickAuth } from "../hooks/useJoystickAuth";
import { useAppStore } from "../store";
import { getKeys } from "../lib/keys";

const STORAGE_KEY = "madchatter-welcome-seen";

const FEATURES = [
  {
    icon: Eye,
    title: "Visual Capture",
    desc: "Share a browser tab and let MADchatter see the stream in real-time. Snapshots are analyzed for context-aware chat suggestions.",
    color: "text-orange-400",
    bg: "bg-orange-500/10",
    border: "border-orange-500/20",
    glow: "shadow-[0_0_20px_rgba(249,115,22,0.15)]",
  },
  {
    icon: AudioLines,
    title: "Audio Transcription",
    desc: "Turn on audio transcription to capture the streamer's audio live. MADchatter listens and weaves spoken words into its context fusion.",
    color: "text-purple-400",
    bg: "bg-purple-500/10",
    border: "border-purple-500/20",
    glow: "shadow-[0_0_20px_rgba(168,85,247,0.15)]",
  },
  {
    icon: MessageSquare,
    title: "Chat Stream Pulse",
    desc: "Live Twitch/Kick chat is monitored, analyzed, and fused into every Forge. Never lose track of the conversation rhythm.",
    color: "text-teal-400",
    bg: "bg-teal-500/10",
    border: "border-teal-500/20",
    glow: "shadow-[0_0_20px_rgba(20,184,166,0.15)]",
  },
  {
    icon: Brain,
    title: "Long-Term Memory",
    desc: "Pin important moments, context, and lore. MADchatter remembers across sessions — the stream's institutional knowledge.",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    glow: "shadow-[0_0_20px_rgba(59,130,246,0.15)]",
  },
  {
    icon: Bot,
    title: "Persona Masks",
    desc: "Six distinct personas — Gremlin, Hype Beast, Analyst, One-Worder, Questioner, and Support — each with their own voice and style.",
    color: "text-pink-400",
    bg: "bg-pink-500/10",
    border: "border-pink-500/20",
    glow: "shadow-[0_0_20px_rgba(236,72,153,0.15)]",
  },
  {
    icon: Tv,
    title: "Stream Embed",
    desc: "Watch the stream directly inside MADchatter. Resize, lock aspect ratio, and even chat into the stream without leaving the app.",
    color: "text-[#9146FF]",
    bg: "bg-[#9146FF]/10",
    border: "border-[#9146FF]/20",
    glow: "shadow-[0_0_20px_rgba(145,70,255,0.15)]",
  },
];

const HOTKEYS = [
  { keys: "Ctrl+K", label: "Command Palette" },
  { keys: "F", label: "Forge New Batch" },
  { keys: "S", label: "Send Top Variant" },
  { keys: "C", label: "Capture Stream" },
  { keys: "A", label: "Toggle AutoForge" },
  { keys: "T", label: "CosmoTech Theme" },
  { keys: "Ctrl+B", label: "Collapse Context Rail" },
];

export function WelcomeOverlay() {
  const [visible, setVisible] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const [tourCountdown, setTourCountdown] = useState(3);

  const twitchAuth = useTwitchAuth();
  const kickAuth = useKickAuth();
  const joystickAuth = useJoystickAuth();
  const platform = useAppStore((s) => s.platform);

  const isTwitchLoggedIn = !!twitchAuth.user;
  const isKickLoggedIn = !!kickAuth.user;
  const isJoystickLoggedIn = !!joystickAuth.user;
  const anyLoggedIn = isTwitchLoggedIn || isKickLoggedIn || isJoystickLoggedIn;
  const activeLoggedIn = platform === 'kick' ? isKickLoggedIn : platform === 'joystick' ? isJoystickLoggedIn : isTwitchLoggedIn;

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    setVisible(true);

    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = Math.max(0, 10 - elapsed);
      setCountdown(remaining);
      const tourRemaining = Math.max(0, 3 - elapsed);
      setTourCountdown(tourRemaining);
      if (remaining === 0) clearInterval(interval);
    }, 100);

    return () => clearInterval(interval);
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  const canDismiss = countdown === 0;
  const canTour = tourCountdown === 0;

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/85 backdrop-blur-lg overflow-y-auto py-8"
        >
          {/* Animated gradient backdrop */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute -top-1/4 -left-1/4 w-1/2 h-1/2 bg-orange-500/8 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: "6s" }} />
            <div className="absolute -bottom-1/4 -right-1/4 w-1/2 h-1/2 bg-purple-500/8 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: "8s", animationDelay: "2s" }} />
            <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-1/3 h-1/3 bg-cyan-500/6 rounded-full blur-[100px] animate-pulse" style={{ animationDuration: "7s", animationDelay: "1s" }} />
          </div>

          <motion.div
            initial={{ scale: 0.92, y: 30 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.92, y: 30 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-3xl mx-4 bg-gradient-to-b from-[#141419] to-[#0a0a0f] border border-white/[0.08] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            {/* Top accent bar */}
            <div className="h-[2px] w-full bg-gradient-to-r from-orange-500 via-purple-500 to-cyan-500" />

            <div className="p-8 md:p-10 max-h-[85vh] overflow-y-auto forge-scroll">
              {/* Joystick install notification */}
              {platform === 'joystick' && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15, duration: 0.4 }}
                  className="mb-7 bg-orange-500/[0.08] border border-orange-500/20 rounded-xl p-4 flex items-start gap-3"
                >
                  <Info className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-orange-200 font-semibold mb-1">Joystick Setup Required</p>
                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      Make sure you've installed this bot app on your channel at{" "}
                      <a
                        href="https://joystick.tv/applications"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-orange-400 hover:text-orange-300 underline inline-flex items-center gap-0.5"
                      >
                        joystick.tv/applications
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                      . The bot only works on channels that have explicitly installed and authorized it — it will not work on other users' channels unless they also install it.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Header */}
              <div className="text-center mb-10">
                <motion.img
                  src="https://madchatter.fun/assets/madchatter-wide.png"
                  alt="MADchatter"
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="mx-auto h-24 w-auto mb-3 object-contain"
                  style={{ filter: "drop-shadow(0 0 16px rgba(255, 250, 250, 0.25))" }}
                />
                <p className="text-sm text-gray-400 mt-3 max-w-md mx-auto leading-relaxed">
                  Your AI-powered stream chat co-pilot. Capture, tune, forge, and ship — all in one place.
                </p>
              </div>

              {/* Featured: AutoForge™ */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.4 }}
                className="group relative bg-gradient-to-r from-yellow-500/[0.08] via-orange-500/[0.08] to-red-500/[0.08] border border-yellow-500/20 rounded-xl p-4 mb-4 transition-all hover:scale-[1.01] cursor-default shadow-[0_0_30px_rgba(234,179,8,0.08)] w-[72%] mx-auto"
              >
                <div className="flex items-center gap-3.5">
                  <div className="shrink-0 w-12 h-12 rounded-xl bg-yellow-500/[0.08] border border-yellow-500/15 flex items-center justify-center">
                    <Zap className="w-6 h-6 text-yellow-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base font-black text-yellow-400 tracking-tight">AutoForge™</span>
                      <span className="text-[9px] font-bold uppercase tracking-widest text-yellow-500/60 bg-yellow-500/[0.08] px-1.5 py-0.5 rounded border border-yellow-500/15">Featured</span>
                    </div>
                    <div className="text-[11px] text-gray-400 leading-relaxed">Fully autonomous mode. AutoForge decides when to speak, what to say, and fires messages to chat on its own — with a full event report.</div>
                  </div>
                </div>
              </motion.div>

              {/* Feature Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 mb-10">
                {FEATURES.map((f, i) => (
                  <motion.div
                    key={f.title}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.38 + i * 0.08, duration: 0.4 }}
                    className={`group relative ${f.bg} ${f.border} border rounded-xl p-4 transition-all duration-200 hover:scale-[1.015] cursor-default hover:shadow-[0_4px_20px_rgba(0,0,0,0.3)]`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`shrink-0 w-10 h-10 rounded-lg ${f.bg} border ${f.border} flex items-center justify-center transition-transform group-hover:scale-105`}>
                        <f.icon className={`w-5 h-5 ${f.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-bold ${f.color} mb-1 tracking-tight`}>{f.title}</div>
                        <div className="text-[11px] text-gray-400 leading-relaxed">{f.desc}</div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Hotkeys Section */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.9, duration: 0.4 }}
                className="mb-10"
              >
                <div className="flex items-center gap-2 mb-3.5">
                  <Keyboard className="w-4 h-4 text-gray-500" />
                  <span className="text-xs font-black uppercase tracking-widest text-gray-500">Essential Hotkeys</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {HOTKEYS.map((h) => (
                    <div key={h.keys} className="flex items-center gap-1.5 bg-white/[0.03] border border-white/[0.07] rounded-lg px-2.5 py-1.5 transition-colors hover:border-white/[0.12]">
                      <kbd className="text-[10px] font-mono font-bold text-gray-300 bg-black/30 px-1.5 py-0.5 rounded border border-white/[0.08]">
                        {h.keys}
                      </kbd>
                      <span className="text-[10px] text-gray-500">{h.label}</span>
                    </div>
                  ))}
                </div>
              </motion.div>

              {/* Getting Started Flow */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.0, duration: 0.4 }}
                className="bg-gradient-to-r from-purple-500/[0.04] via-teal-500/[0.04] to-orange-500/[0.04] border border-white/[0.04] rounded-xl p-4 mb-10"
              >
                <div className="flex items-center gap-2 mb-3.5">
                  <Sparkles className="w-4 h-4 text-orange-400" />
                  <span className="text-xs font-black uppercase tracking-widest text-gray-400">Getting Started</span>
                </div>
                <div className="flex flex-col md:flex-row items-stretch gap-2">
                  {[
                    { step: "1", label: "Log in with Twitch, Kick, or Joystick", color: "text-purple-400", done: anyLoggedIn, isLoginStep: true },
                    { step: "2", label: "Set your channel name", color: "text-teal-400", done: !!useAppStore.getState().streamMetadata?.channelName },
                    { step: "3", label: "Add an AI API key in Settings", color: "text-orange-400", done: !!(getKeys().claudeKey || getKeys().chatGptKey || getKeys().geminiKey || getKeys().openRouterKey) },
                    { step: "4", label: "Press F to Forge", color: "text-red-400", done: false },
                  ].map((s, i) => (
                    <React.Fragment key={s.step}>
                      <div className={`flex-1 flex items-center gap-2.5 bg-black/20 rounded-lg px-3.5 py-2.5 transition-all ${s.done ? 'ring-1 ring-emerald-500/25' : ''}`}>
                        <span className={`text-lg font-black font-mono ${s.color}`}>{s.step}</span>
                        <span className="text-[11px] text-gray-300 font-medium flex-1 leading-snug">
                          {s.isLoginStep ? (
                            <>Log in with <span style={{ color: "#9146FF" }}>Twitch</span> <span style={{ color: "#53fc18" }}>Kick</span> or <span style={{ color: "#FF6B35" }}>Joystick</span></>
                          ) : s.label}
                        </span>
                        {s.done ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : (
                          <Circle className="w-3.5 h-3.5 text-gray-700 shrink-0" />
                        )}
                      </div>
                      {i < 3 && <ChevronRight className="hidden md:flex w-4 h-4 text-gray-700 shrink-0 self-center" />}
                    </React.Fragment>
                  ))}
                </div>
              </motion.div>

              {/* Acknowledge Button */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.1, duration: 0.4 }}
                className="flex flex-col items-center gap-2.5"
              >
                <button
                  onClick={() => { playSfx('welcome_dismiss'); dismiss(); }}
                  disabled={!canDismiss}
                  className={`group relative px-8 py-3 rounded-xl font-bold text-sm transition-all duration-300 overflow-hidden ${
                    canDismiss
                      ? "bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-[0_0_30px_rgba(249,115,22,0.25)] hover:shadow-[0_0_40px_rgba(249,115,22,0.4)] hover:scale-105"
                      : "bg-white/[0.03] text-gray-600 border border-white/[0.07] cursor-not-allowed"
                  }`}
                >
                  {canDismiss && (
                    <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                  )}
                  <span className="relative flex items-center gap-2">
                    <Flame className="w-4 h-4" />
                    {canDismiss ? "Acknowledge & Enter the Forge" : `Acknowledge available in ${countdown}s`}
                  </span>
                </button>
                <button
                  onClick={() => { playSfx('welcome_dismiss'); dismiss(); setTimeout(() => window.dispatchEvent(new CustomEvent('tutorial-start')), 400); }}
                  disabled={!canTour}
                  className={`px-5 py-2 rounded-lg font-bold text-xs transition-all duration-300 ${
                    canTour
                      ? "bg-white/5 text-orange-300 border border-orange-500/30 hover:bg-orange-500/15 hover:border-orange-500/50"
                      : "bg-white/[0.03] text-gray-700 border border-white/[0.05] cursor-not-allowed"
                  }`}
                >
                  {canTour ? "Take the Tour" : `Tour available in ${tourCountdown}s`}
                </button>
                <p className="text-[10px] text-gray-600">
                  This welcome screen won't appear again after you acknowledge.
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="text-[9px] text-gray-700 hover:text-gray-500 transition-colors">Privacy Policy</a>
                  <span className="text-[9px] text-gray-800">·</span>
                  <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="text-[9px] text-gray-700 hover:text-gray-500 transition-colors">Terms of Service</a>
                  <span className="text-[9px] text-gray-800">·</span>
                  <a href="mailto:kovrycha@gmail.com" className="text-[9px] text-gray-700 hover:text-gray-500 transition-colors inline-flex items-center gap-0.5">
                    <Mail className="w-2.5 h-2.5" />
                    Contact
                  </a>
                </div>
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
