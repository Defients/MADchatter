import React, { useState, useEffect, useRef, useCallback } from "react";
import { Camera, MonitorUp, StopCircle, ExternalLink } from "lucide-react";
import { cn } from "../lib/utils";
import { ThemedTooltip } from "./ui/tooltip";

interface StreamEmbedProps {
  channel: string;
  isLive: boolean;
  onScreenshotCapture: (screenshot: string) => void;
  lastCaptureTime: number | null;
}

export function StreamEmbed({
  channel,
  isLive,
  onScreenshotCapture,
  lastCaptureTime,
}: StreamEmbedProps) {
  const [capturing, setCapturing] = useState(false);
  const [pauseCountdown, setPauseCountdown] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCapturing(false);
  }, []);

  useEffect(() => {
    if (!isLive) {
      stopCapture();
    }
  }, [isLive, stopCapture]);

  const startCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCapturing(true);

      // Detect capture type for proper frame grabbing
      const videoTrack = stream.getVideoTracks()[0];
      const surfaceType = videoTrack?.getSettings().displaySurface || "window";
      const isTab = surfaceType === "browser";
      if (isTab) {
        // Tab capture: frames match the browser viewport — no cropping needed
        console.log("[StreamEmbed] Tab capture detected — full viewport frames");
      } else {
        // Window/monitor capture: full frame is the stream window
        console.log(`[StreamEmbed] ${surfaceType} capture detected — full frames`);
      }

      stream.getVideoTracks()[0].onended = () => {
        stopCapture();
      };
    } catch (e) {
      console.error("Failed to start capture", e);
    }
  };

  const grabFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !capturing) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Guard against uninitialized dimensions (0 or NaN)
    const videoWidth = video.videoWidth || 1280;
    const videoHeight = video.videoHeight || 720;
    const ratio = videoWidth / videoHeight;
    const maxWidth = 640;
    const width = Math.min(maxWidth, videoWidth);
    const height = width / ratio;

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.5);
    onScreenshotCapture(dataUrl);
  }, [capturing, onScreenshotCapture]);

  // Auto-capture every 30s
  useEffect(() => {
    if (!capturing) return;

    const interval = setInterval(() => {
      if (pauseCountdown <= 0) {
        grabFrame();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [capturing, pauseCountdown, grabFrame]);

  // Countdown timer
  useEffect(() => {
    if (pauseCountdown > 0) {
      const timer = setTimeout(() => setPauseCountdown((c) => c - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [pauseCountdown]);

  const handleManualCapture = () => {
    grabFrame();
    setPauseCountdown(60);
  };

  const openStreamWindow = () => {
    if (!channel) return;
    const url = `https://twitch.tv/${channel}`;
    window.open(url, "_blank");
  };

  return (
    <div className="h-64 bg-black relative shrink-0 overflow-hidden border-b border-white/5">
      {/* Canvas for taking screen snapshots */}
      <canvas ref={canvasRef} className="hidden" />

      {/* DUAL DISPLAY MODE: Capturing Video Feedback vs High-tech Vision Proxy */}
      {capturing ? (
        <div className="absolute inset-0 bg-black flex items-center justify-center">
          <video
            ref={videoRef}
            className="w-full h-full object-cover border border-blue-500/30"
            muted
            playsInline
          />
          <div className="absolute bottom-14 right-4 px-2 py-0.5 bg-blue-500/80 text-black text-[9px] font-mono font-bold uppercase rounded tracking-wider z-20 animate-pulse">
            FEED MONITOR ACTIVE
          </div>
        </div>
      ) : channel ? (
        <div className="absolute inset-0 bg-[#0C0C0F] flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="absolute inset-0 bg-gradient-to-b from-[#18181C]/10 to-black/80 pointer-events-none" />
          <div className="w-12 h-12 rounded-full bg-[#FF6321]/10 border border-[#FF6321]/20 flex items-center justify-center mb-3">
            <svg
              className="w-6 h-6 text-[#FF6321]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h3 className="text-xs font-black uppercase tracking-widest text-[#E0E0E6] mb-1">
            Vision Target: <span className="text-[#FF6321]">{channel}</span>
          </h3>
          <p className="text-[10px] text-gray-500 max-w-sm leading-relaxed mb-4">
            Twitch player embeds are restricted in sandboxed previews. To pipe
            real-time visual frames into Forge, open the stream below, then
            click <strong className="text-gray-300">Capture Window</strong> to
            sync!
          </p>
          <button
            onClick={openStreamWindow}
            className="px-3 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-[9px] font-bold uppercase tracking-wider text-gray-300 hover:text-white transition-all flex items-center gap-1.5"
          >
            <ExternalLink className="w-3 h-3 text-[#FF6321]" /> Open twitch.tv/
            {channel}
          </button>
        </div>
      ) : (
        /* VIDEO PLACEHOLDER */
        <div className="absolute inset-0 flex items-center justify-center bg-[#18181B]">
          <div className="flex flex-col items-center gap-2 opacity-30">
            <svg
              className="w-12 h-12 text-white"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M21 6.5L17 10.5V7c0-.55-.45-1-1-1H5c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h11c.55 0 1-.45 1-1v-3.5l4 4v-11z" />
            </svg>
            <span className="text-[10px] font-bold uppercase tracking-wider">
              No Channel Sync
            </span>
          </div>
        </div>
      )}

      {/* STREAM CONTROLS OVERLAY */}
      <div className="absolute top-4 left-4 z-20 flex gap-2">
        {isLive && (
          <div className="px-2 py-1 bg-red-600 rounded text-[9px] font-black tracking-widest flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />{" "}
            LIVE
          </div>
        )}
        {capturing && (
          <div className="px-2 py-1 bg-black/60 backdrop-blur rounded text-[9px] font-bold flex items-center gap-2">
            640px JPEG 0.5 ::{" "}
            {lastCaptureTime
              ? new Date(lastCaptureTime).toLocaleTimeString()
              : "Waiting..."}
          </div>
        )}
      </div>

      <div className="absolute bottom-4 left-4 right-4 z-20 flex justify-between items-end">
        <div className="flex gap-2">
          {capturing ? (
            <>
              <button
                onClick={stopCapture}
                className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 text-[10px] font-bold uppercase rounded border border-red-500/30 flex items-center gap-1.5 transition-colors backdrop-blur-md"
              >
                <StopCircle className="w-3.5 h-3.5" /> Stop Capture
              </button>
              <button
                onClick={handleManualCapture}
                disabled={pauseCountdown > 0}
                className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 disabled:opacity-50 text-blue-400 text-[10px] font-bold uppercase rounded border border-blue-500/30 flex items-center gap-1.5 transition-colors backdrop-blur-md"
              >
                <Camera className="w-3.5 h-3.5" />
                {pauseCountdown > 0
                  ? `Paused (${pauseCountdown}s)`
                  : "Capture Now"}
              </button>
            </>
          ) : (
            <button
              onClick={startCapture}
              className="px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-400 text-[10px] font-bold uppercase rounded border border-green-500/30 flex items-center gap-1.5 transition-colors backdrop-blur-md"
            >
              <MonitorUp className="w-3.5 h-3.5" /> Capture Window
            </button>
          )}
        </div>

        <ThemedTooltip content="Open Stream Window">
          <button
            onClick={openStreamWindow}
            disabled={!channel}
            className="p-2 bg-white/10 hover:bg-white/20 rounded-lg backdrop-blur-md border border-white/20 text-white transition-colors disabled:opacity-50"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
        </ThemedTooltip>
      </div>
    </div>
  );
}
