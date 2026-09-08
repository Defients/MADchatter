import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Tv, Volume2, VolumeX, ExternalLink, Camera, MonitorUp, StopCircle, MessageCircle, EyeOff, Eye, Lock, Unlock, Send, Mic } from "lucide-react";
import { useAppStore } from "../store";
import { getPlatformSendFn } from "../lib/platformSend";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import chanceImg from "../../assets/chance.jpg";
import mustardVideo from "../../assets/mustardfite.mp4";
import waterVideo from "../../assets/waterfite.mp4";
import kissVideo from "../../assets/kissfite.mp4";

declare global {
  interface Window { Twitch?: any; }
}

interface StreamOverlayProps {
  channel: string;
  onClose: () => void;
  size: { w: number; h: number };
  onResize: (size: { w: number; h: number }) => void;
  onVisualCapture: () => void;
  onMicrophoneCapture: () => void;
  isMicCapturing: boolean;
  onManualSnapshot: () => void;
  isVisualCapturing: boolean;
  visualCooldown: boolean;
  tabCaptureMode: boolean;
  onChatModeChange?: (active: boolean) => void;
  embedded?: boolean;
}

const MIN_W = 320;
const MIN_H = 180;

// Aspect ratio offsets — fine-tune to eliminate black bars from player internal chrome
const RATIO_W = 16;
const RATIO_H = 9;
const RATIO_W_OFFSET = 0; // adjust if bars appear on left/right
const RATIO_H_OFFSET = 0; // adjust if bars appear on top/bottom
const BAR_TRIM = 100; // px to trim from each side of the iframe to eliminate black bars
const effectiveRatio = (RATIO_H + RATIO_H_OFFSET) / (RATIO_W + RATIO_W_OFFSET);

export function StreamOverlay({
  channel,
  onClose,
  size,
  onResize,
  onVisualCapture,
  onMicrophoneCapture,
  isMicCapturing,
  onManualSnapshot,
  isVisualCapturing,
  visualCooldown,
  tabCaptureMode,
  onChatModeChange,
  embedded = false,
}: StreamOverlayProps) {
  const [muted, setMuted] = useState(false);
  const [chatInputMode, setChatInputMode] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const platform = useAppStore((s) => s.platform);
  const tutorialActive = useAppStore((s) => s.tutorialActive);
  const [tutorialVideoEnded, setTutorialVideoEnded] = useState(false);
  const [tutorialVideoPhase, setTutorialVideoPhase] = useState<"mustard" | "water" | "kiss">("mustard");
  const [tutorialMuted, setTutorialMuted] = useState(true);
  const [lockResolution, setLockResolution] = useState(() => {
    return localStorage.getItem("forge-stream-lock-res") === "true";
  });

  const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";

  // Twitch Player SDK refs
  const twitchPlayerRef = useRef<any>(null);
  const twitchContainerRef = useRef<HTMLDivElement>(null);
  const twitchPlayerId = useMemo(() => `twitch-player-${Math.random().toString(36).slice(2, 9)}`, []);
  const [twitchScriptLoaded, setTwitchScriptLoaded] = useState(() => !!window.Twitch);

  // Load Twitch embed script once
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

  // Create / recreate Twitch player when script loads, channel changes, or container remounts
  const createTwitchPlayer = useCallback(() => {
    if (platform === "kick" || platform === "joystick" || !channel || !twitchScriptLoaded || !window.Twitch) return;
    const el = document.getElementById(twitchPlayerId);
    if (!el) return;
    if (twitchPlayerRef.current) { try { twitchPlayerRef.current.destroy(); } catch {} }
    el.innerHTML = "";
    twitchPlayerRef.current = new window.Twitch.Player(twitchPlayerId, {
      channel, parent, muted: false, autoplay: true, width: "100%", height: "100%",
    });
  }, [channel, parent, platform, twitchScriptLoaded, twitchPlayerId]);

  // Callback ref — runs when the container div mounts (or remounts after path change)
  const twitchContainerCallback = useCallback((node: HTMLDivElement | null) => {
    twitchContainerRef.current = node;
    if (node) createTwitchPlayer();
  }, [createTwitchPlayer]);

  // Recreate player when channel changes (container stays mounted)
  useEffect(() => {
    if (twitchScriptLoaded && twitchContainerRef.current) createTwitchPlayer();
  }, [channel, twitchScriptLoaded, createTwitchPlayer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (twitchPlayerRef.current) { try { twitchPlayerRef.current.destroy(); } catch {} }
      twitchPlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("forge-stream-lock-res", lockResolution.toString());
  }, [lockResolution]);

  useEffect(() => {
    if (tutorialActive) {
      setTutorialVideoEnded(false);
      setTutorialVideoPhase("mustard");
      setTutorialMuted(true);
    }
  }, [tutorialActive]);

  useEffect(() => {
    onChatModeChange?.(chatInputMode);
  }, [chatInputMode, onChatModeChange]);

  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const resizingRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    setIsResizing(true);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current || !resizingRef.current) return;
      const dw = ev.clientX - resizeRef.current.startX;
      const dh = ev.clientY - resizeRef.current.startY;
      const maxW = Math.round(window.innerWidth * 0.8);
      const maxH = Math.round(window.innerHeight * 0.8);
      if (lockResolution) {
        const newW = Math.max(MIN_W, Math.min(maxW, resizeRef.current.startW + dw));
        const newH = Math.round(newW * 9 / 16);
        onResize({ w: newW, h: newH });
      } else {
        onResize({
          w: Math.max(MIN_W, Math.min(maxW, resizeRef.current.startW + dw)),
          h: Math.max(MIN_H, Math.min(maxH, resizeRef.current.startH + dh)),
        });
      }
    };
    const onUp = (ev: MouseEvent) => {
      ev.preventDefault();
      resizingRef.current = false;
      resizeRef.current = null;
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [size, onResize, lockResolution]);

  const handleSendKickChat = async () => {
    const msg = chatMessage.trim();
    if (!msg || !channel || chatSending) return;
    setChatSending(true);
    try {
      const sendFn = getPlatformSendFn(platform);
      await sendFn(channel, msg);
      setChatMessage("");
      toast.success(`Message sent to ${platform === 'joystick' ? 'Joystick' : 'Kick'} chat!`);
    } catch (e: any) {
      toast.error(e.message || `Failed to send message to ${platform === 'joystick' ? 'Joystick' : 'Kick'} chat`);
    } finally {
      setChatSending(false);
    }
  };

  const embedSrc = channel
    ? platform === 'kick'
      ? `https://player.kick.com/${channel}?autoplay=true&muted=true&parent=${parent}`
      : ""  // Twitch uses the JS SDK, not a direct iframe; Joystick doesn't allow embeds
    : "";
  const chatEmbedSrc = channel
    ? platform === 'kick'
      ? `https://kick.com/${channel}/chatroom`
      : platform === 'joystick'
        ? ""  // No chat embed for Joystick
        : `https://www.twitch.tv/embed/${channel}/chat?parent=${parent}&darkpopout`
    : "";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Full-screen overlay during resize — prevents iframes from swallowing mouse events */}
      {isResizing && (
        <div className="fixed inset-0 z-[99999] cursor-nwse-resize" />
      )}
      {/* Twitch Player / Chat Input */}
      <div className={`flex-1 relative bg-black min-h-0 overflow-hidden ${lockResolution && !chatInputMode ? "flex items-center justify-center" : ""}`}>
        {channel ? (
          <>
            {tutorialActive ? (
              <div data-stream-embed className="absolute inset-0 w-full h-full flex items-center justify-center bg-black overflow-hidden">
                {tutorialVideoEnded ? (
                  <img src={chanceImg} alt="Stream preview" className="w-full h-full object-cover" />
                ) : (
                  <>
                    <video
                      key="mustard"
                      src={mustardVideo}
                      autoPlay
                      muted={tutorialMuted}
                      playsInline
                      onEnded={() => setTutorialVideoPhase("water")}
                      className="w-full h-full object-cover"
                      style={{ display: tutorialVideoPhase === "mustard" ? "block" : "none" }}
                    />
                    <video
                      key="water"
                      src={waterVideo}
                      muted={tutorialMuted}
                      playsInline
                      preload="auto"
                      onEnded={() => setTutorialVideoPhase("kiss")}
                      ref={(el) => {
                        if (el && tutorialVideoPhase === "water") {
                          el.play().catch(() => {});
                        }
                      }}
                      className="w-full h-full object-cover"
                      style={{ display: tutorialVideoPhase === "water" ? "block" : "none" }}
                    />
                    <video
                      key="kiss"
                      src={kissVideo}
                      muted={tutorialMuted}
                      playsInline
                      preload="auto"
                      onEnded={() => setTutorialVideoEnded(true)}
                      ref={(el) => {
                        if (el && tutorialVideoPhase === "kiss") {
                          el.play().catch(() => {});
                        }
                      }}
                      className="w-full h-full object-cover"
                      style={{ display: tutorialVideoPhase === "kiss" ? "block" : "none" }}
                    />
                  </>
                )}
              </div>
            ) : (
            <>
            {/* Video embed — always visible, sits on top when chat mode is on */}
            {platform === 'joystick' ? (
              /* Joystick doesn't allow iframe embeds — show a large Capture Window button instead */
              <div className="flex items-center justify-center h-full bg-[#0a0a0f]">
                <div className="flex flex-col items-center gap-4">
                  {isVisualCapturing ? (
                    <>
                      <div className="flex items-center gap-2 text-emerald-400">
                        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-sm font-bold uppercase tracking-wider">Window Capturing</span>
                      </div>
                      <button
                        type="button"
                        onClick={onManualSnapshot}
                        disabled={visualCooldown}
                        className="h-12 px-6 flex items-center gap-2 rounded-xl text-sm font-bold uppercase tracking-wider transition-all disabled:opacity-50 text-blue-400 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30"
                      >
                        <Camera className="w-5 h-5" />
                        {visualCooldown ? "Cooldown..." : "Take Snapshot"}
                      </button>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={onVisualCapture}
                          className="h-10 px-5 flex items-center gap-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all text-red-400 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30"
                        >
                          <StopCircle className="w-4 h-4" />
                          Stop Capture
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (isMicCapturing) {
                              toast.info("Stopping microphone capture...", { duration: 3000 });
                            } else {
                              toast.info("Select your microphone to capture audio for transcription.", { duration: 6000 });
                            }
                            onMicrophoneCapture();
                          }}
                          className={`h-10 px-5 flex items-center gap-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all border ${
                            isMicCapturing
                              ? "text-red-300 bg-red-500/20 border-red-500/50 hover:bg-red-500/30 animate-pulse"
                              : "text-purple-400 bg-purple-500/15 hover:bg-purple-500/25 border-purple-500/30"
                          }`}
                        >
                          <Mic className="w-4 h-4" />
                          {isMicCapturing ? "Stop Mic" : "Microphone"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          toast.info("Select your Joystick.tv browser window to capture. Remember to toggle on the audio tab!", { duration: 6000 });
                          onVisualCapture();
                        }}
                        className="h-16 px-6 flex items-center gap-2 rounded-2xl text-sm font-bold uppercase tracking-wider transition-all text-orange-400 bg-orange-500/15 hover:bg-orange-500/25 border-2 border-orange-500/30 hover:border-orange-500/50 shadow-lg hover:shadow-orange-500/20"
                      >
                        <MonitorUp className="w-6 h-6" />
                        Capture Window
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isMicCapturing) {
                            toast.info("Stopping microphone capture...", { duration: 3000 });
                          } else {
                            toast.info("Select your microphone to capture audio for transcription. No browser capture needed!", { duration: 6000 });
                          }
                          onMicrophoneCapture();
                        }}
                        className={`h-16 px-6 flex items-center gap-2 rounded-2xl text-sm font-bold uppercase tracking-wider transition-all border-2 shadow-lg ${
                          isMicCapturing
                            ? "text-red-300 bg-red-500/20 border-red-500/50 hover:bg-red-500/30 hover:shadow-red-500/20 animate-pulse"
                            : "text-purple-400 bg-purple-500/15 hover:bg-purple-500/25 border-purple-500/30 hover:border-purple-500/50 hover:shadow-purple-500/20"
                        }`}
                      >
                        <Mic className="w-6 h-6" />
                        {isMicCapturing ? "Stop Mic" : "Microphone"}
                      </button>
                    </div>
                  )}
                  <p className="text-[10px] text-gray-600 max-w-xs text-center">
                    Joystick.tv doesn't allow stream embeds. Capture your browser window to enable visual context and snapshots.
                  </p>
                </div>
              </div>
            ) : lockResolution && !chatInputMode ? (
              <div className="relative w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
                {platform === 'kick' ? (
                  <iframe
                    src={embedSrc}
                    className="absolute inset-0 w-full h-full border-0"
                    allow="autoplay; fullscreen"
                    title={`Kick stream: ${channel}`}
                  />
                ) : (
                  <div data-stream-embed id={twitchPlayerId} ref={twitchContainerCallback} className="absolute inset-0 w-full h-full !overflow-hidden [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:!w-full [&>iframe]:!h-full [&>iframe]:border-0" />
                )}
              </div>
            ) : (
              platform === 'kick' ? (
                <iframe
                  src={embedSrc}
                  className={`border-0 ${chatInputMode ? "absolute top-0 left-0 right-0 z-10 w-full" : "absolute inset-0 w-full h-full"}`}
                  style={chatInputMode ? { height: `${size.h}px` } : undefined}
                  allow="autoplay; fullscreen"
                  title={`Kick stream: ${channel}`}
                />
              ) : (
                <div data-stream-embed id={twitchPlayerId} ref={twitchContainerCallback} className={`${chatInputMode ? "absolute top-0 left-0 right-0 z-10 w-full" : "absolute inset-0 w-full h-full !overflow-hidden"} [&>iframe]:!w-full [&>iframe]:!h-full [&>iframe]:border-0`} style={chatInputMode ? { height: `${size.h}px` } : undefined} />
              )
            )}
            </>
            )}
            {chatInputMode && platform !== 'kick' && platform !== 'joystick' && (
              <>
                {/* Chat embed — fills entire container, but video covers everything except the bottom input strip */}
                <iframe
                  src={chatEmbedSrc}
                  className="w-full h-full border-0 absolute top-0 left-0 z-0"
                  title={`Chat: ${channel}`}
                />
              </>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600 text-xs">
            <div className="flex flex-col items-center gap-2">
              <Tv className="w-8 h-8 opacity-30" />
              <span>No channel set</span>
            </div>
          </div>
        )}
      </div>

      {/* Native Kick/Joystick Chat Input Bar */}
      {chatInputMode && (platform === 'kick' || platform === 'joystick') && channel && (
        <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-t border-white/5 bg-[#121217]/90 backdrop-blur">
          <input
            type="text"
            value={chatMessage}
            onChange={(e) => setChatMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendKickChat();
              }
            }}
            placeholder="Send a message to Kick chat..."
            className="flex-1 bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-[#53fc18]/40 font-sans"
            disabled={chatSending}
          />
          <button
            type="button"
            onClick={handleSendKickChat}
            disabled={chatSending || !chatMessage.trim()}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-[#53fc18] bg-[#53fc18]/10 hover:bg-[#53fc18]/20 border border-[#53fc18]/20 hover:border-[#53fc18]/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="Send message"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Controls Bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-t border-white/5 bg-white/[0.02]">
        {tutorialActive ? (
          <Tooltip>
            <TooltipTrigger render={(props) => (
              <button
                {...props}
                type="button"
                onClick={() => setTutorialMuted((m) => !m)}
                className="h-6 w-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-white/10 transition-all relative"
              >
                {tutorialMuted ? (
                  <VolumeX className="w-3.5 h-3.5 animate-pulse text-orange-400" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                {tutorialMuted && (
                  <span className="absolute inset-0 rounded bg-orange-500/20 animate-ping" />
                )}
              </button>
            )} />
            <TooltipContent side="top" className="bg-[#1a1a1f] border border-white/10 text-gray-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
              {tutorialMuted ? "Unmute video" : "Mute video"}
            </TooltipContent>
          </Tooltip>
        ) : platform !== 'kick' && platform !== 'joystick' && (
        <Tooltip>
          <TooltipTrigger render={(props) => (
            <button
              {...props}
              type="button"
              onClick={() => {
                const newMuted = !muted;
                setMuted(newMuted);
                twitchPlayerRef.current?.setMuted(newMuted);
              }}
              className="h-6 w-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-white/10 transition-all"
            >
              {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
          )} />
          <TooltipContent side="top" className="bg-[#1a1a1f] border border-white/10 text-gray-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
            {muted ? "Unmute stream" : "Mute stream"}
          </TooltipContent>
        </Tooltip>
        )}

        {/* Visual Capture Button — hidden for Joystick (handled in-stream area) */}
        {platform !== 'joystick' && (
        <Tooltip>
          <TooltipTrigger render={(props) => (
            <button
              {...props}
              type="button"
              onClick={() => {
                if (!isVisualCapturing) {
                  toast.info("Remember to toggle on the audio tab when selecting a window to capture!", { duration: 6000 });
                }
                onVisualCapture();
              }}
              className={`h-6 px-2 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${
                isVisualCapturing
                  ? "text-red-400 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30"
                  : "text-orange-400 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/20"
              }`}
            >
              {isVisualCapturing ? <StopCircle className="w-3 h-3" /> : <MonitorUp className="w-3 h-3" />}
              {isVisualCapturing ? "Stop" : "Capture"}
            </button>
          )} />
          <TooltipContent side="top" className="bg-[#1a1a1f] border border-orange-500/20 text-orange-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
            {isVisualCapturing ? "Stop visual capture" : "Start visual capture (screen share)"}
          </TooltipContent>
        </Tooltip>
        )}

        {/* Manual Snapshot Button — only visible when capturing (hidden for Joystick) */}
        {isVisualCapturing && platform !== 'joystick' && (
          <Tooltip>
            <TooltipTrigger render={(props) => (
              <button
                {...props}
                type="button"
                onClick={onManualSnapshot}
                disabled={visualCooldown}
                className="h-6 px-2 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all disabled:opacity-50 text-blue-400 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/20"
              >
                <Camera className="w-3 h-3" />
                Snap
              </button>
            )} />
            <TooltipContent side="top" className="bg-[#1a1a1f] border border-blue-500/20 text-blue-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
              {visualCooldown ? "Cooldown active..." : "Capture snapshot now"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Toggle Chat Input — hidden when embedded in sidebar (handled externally) */}
        {channel && !embedded && (
          <Tooltip>
            <TooltipTrigger render={(props) => (
              <button
                {...props}
                type="button"
                onClick={() => setChatInputMode(!chatInputMode)}
                className={`h-6 px-2 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${
                  chatInputMode
                    ? "text-rose-400 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30"
                    : "text-emerald-400 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30"
                }`}
              >
                {chatInputMode ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {chatInputMode ? "Hide" : "Chat"}
              </button>
            )} />
            <TooltipContent side="top" className={`text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl border ${chatInputMode ? "bg-[#1a1a1f] border-rose-500/20 text-rose-300" : "bg-[#1a1a1f] border-emerald-500/20 text-emerald-300"}`}>
              {chatInputMode ? "Hide chat input strip" : "Show chat input below video"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Lock Resolution — maintain 16:9 aspect ratio (hidden in expanded sidebar) */}
        {channel && !embedded && (
          <Tooltip>
            <TooltipTrigger render={(props) => (
              <button
                {...props}
                type="button"
                onClick={() => {
                  if (!lockResolution) {
                    const newH = Math.round(size.w * 9 / 16);
                    onResize({ w: size.w, h: newH });
                  }
                  setLockResolution(!lockResolution);
                }}
                className={`h-6 px-2 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${
                  lockResolution
                    ? "text-cyan-400 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40"
                    : "text-gray-400 bg-white/5 hover:bg-white/10 border border-white/10"
                }`}
              >
                {lockResolution ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                16:9
              </button>
            )} />
            <TooltipContent side="top" className="bg-[#1a1a1f] border border-cyan-500/20 text-cyan-300 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
              {lockResolution ? "Unlock aspect ratio (free resize)" : "Lock to 16:9 aspect ratio (no black bars)"}
            </TooltipContent>
          </Tooltip>
        )}

        {channel && (
          <Tooltip>
            <TooltipTrigger render={(props) => (
              <button
                {...props}
                type="button"
                onClick={() => window.open(platform === 'kick' ? `https://kick.com/${channel}` : platform === 'joystick' ? `https://joystick.tv/u/${channel}` : `https://twitch.tv/${channel}`, "_blank")}
                className="h-6 px-2 flex items-center gap-1 rounded text-[9px] font-bold uppercase tracking-wider transition-all text-[#9146FF] bg-[#9146FF]/10 hover:bg-[#9146FF]/20 border border-[#9146FF]/20 hover:border-[#9146FF]/40"
              >
                <ExternalLink className="w-3 h-3" />
                {platform === 'kick' ? 'Kick' : platform === 'joystick' ? 'Joystick' : 'Twitch'}
              </button>
            )} />
            <TooltipContent side="top" className="bg-[#1a1a1f] border border-[#9146FF]/30 text-[#9146FF] text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
              Open on {platform === 'kick' ? 'Kick' : platform === 'joystick' ? 'Joystick' : 'Twitch'}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Resize Handle — hidden when embedded in left sidebar */}
        {!embedded && (
        <Tooltip>
          <TooltipTrigger render={(props) => (
            <div
              {...props}
              onMouseDown={startResize}
              className="ml-auto w-4 h-4 cursor-nwse-resize flex items-end justify-end group"
            >
              <svg className="w-3 h-3 text-gray-600 group-hover:text-gray-400 transition-colors" viewBox="0 0 12 12" fill="none">
                <path d="M11 1L1 11M11 6L6 11M11 11L11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          )} />
          <TooltipContent side="top" className="bg-[#1a1a1f] border border-white/10 text-gray-400 text-[10px] font-semibold rounded-lg px-2.5 py-1 shadow-xl">
            Drag to resize
          </TooltipContent>
        </Tooltip>
        )}
      </div>
    </div>
  );
}
