import React, { useState, useEffect, useCallback } from "react";
import { X, AtSign } from "lucide-react";
import { cn } from "../lib/utils";

interface MentionOverlayProps {
  maxLines?: number;
  autoDismissMs?: number;
}

interface MentionData {
  lines: string[];
  timestamp: number;
  channel: string;
}

export const MentionOverlay: React.FC<MentionOverlayProps> = ({
  maxLines = 5,
  autoDismissMs = 12000,
}) => {
  const [mention, setMention] = useState<MentionData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const handleMention = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail as MentionData;
    if (!detail || !detail.lines || detail.lines.length === 0) return;
    setMention(detail);
    setDismissed(false);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setTimeout(() => setMention(null), 300);
  }, []);

  useEffect(() => {
    window.addEventListener("bot-mentioned", handleMention as EventListener);
    const handleDismiss = () => dismiss();
    window.addEventListener("mention-overlay-dismiss", handleDismiss);
    return () => {
      window.removeEventListener("bot-mentioned", handleMention as EventListener);
      window.removeEventListener("mention-overlay-dismiss", handleDismiss);
    };
  }, [handleMention, dismiss]);

  useEffect(() => {
    if (!mention || dismissed) return;
    const timer = setTimeout(() => {
      dismiss();
    }, autoDismissMs);
    return () => clearTimeout(timer);
  }, [mention, dismissed, autoDismissMs, dismiss]);

  if (!mention) return null;

  return (
    <div
      className={cn(
        "fixed top-4 left-1/2 -translate-x-1/2 z-[9999] transition-all duration-300",
        dismissed ? "opacity-0 -translate-y-4 scale-95" : "opacity-100 translate-y-0 scale-100"
      )}
      role="alert"
      aria-live="assertive"
    >
      <div className="relative flex flex-col w-[min(560px,calc(100vw-32px))] bg-[#121217]/95 backdrop-blur-xl border border-cyan-400/40 rounded-xl shadow-[0_0_32px_rgba(34,211,238,0.25),0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden">
        {/* Animated top accent */}
        <div className="h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-pulse" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-cyan-500/15 border border-cyan-400/40 flex items-center justify-center">
              <AtSign className="w-3.5 h-3.5 text-cyan-300 animate-pulse" />
            </div>
            <div>
              <div className="text-sm font-bold text-cyan-300 tracking-wide">MENTIONED</div>
              <div className="text-[10px] text-gray-500 font-mono">
                {mention.channel} · {new Date(mention.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
          <button
            onClick={dismiss}
            className="w-7 h-7 rounded-md hover:bg-white/10 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Dismiss mention"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mention lines */}
        <div className="px-4 py-3 space-y-2 max-h-[280px] overflow-y-auto forge-scroll">
          {mention.lines.slice(0, maxLines).map((line, i) => {
            const colonIdx = line.indexOf(":");
            const username = colonIdx > 0 ? line.slice(0, colonIdx) : "Someone";
            const message = colonIdx > 0 ? line.slice(colonIdx + 1).trim() : line;
            return (
              <div key={i} className="flex gap-2.5 items-start">
                <div className="w-1 self-stretch rounded-full bg-cyan-400/30 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-cyan-300/90 truncate">{username}</div>
                  <div className="text-sm text-gray-200 break-words">{message}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-white/5 flex items-center justify-between">
          <span className="text-[10px] text-gray-600">
            Auto-dismiss in {Math.ceil(autoDismissMs / 1000)}s · Press Esc to close
          </span>
          <button
            onClick={dismiss}
            className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors font-medium"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};
