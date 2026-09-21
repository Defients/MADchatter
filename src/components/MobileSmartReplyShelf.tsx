import React, { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, AtSign, Loader2, Send, Settings, X } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { sendManualMessage } from "../lib/manualSend";
import { playMessageSound } from "../lib/sound";
import { playSfx } from "../lib/sfx";
import { cn } from "../lib/utils";

export function MobileSmartReplyShelf({ onOpenTuning, compact = false, onOpenContext }: {
  onOpenTuning: () => void;
  compact?: boolean;
  onOpenContext?: () => void;
}) {
  const replies = useAppStore((state) => state.smartReplies);
  const loading = useAppStore((state) => state.smartRepliesLoading);
  const notice = useAppStore((state) => state.smartReplyNotice);
  const channel = useAppStore((state) => state.streamMetadata.channelName);
  const messageSoundEnabled = useAppStore((state) => state.messageSoundEnabled);
  const setReplies = useAppStore((state) => state.setSmartReplies);
  const setNotice = useAppStore((state) => state.setSmartReplyNotice);
  const setLoading = useAppStore((state) => state.setSmartRepliesLoading);
  const focusedKey = useAppStore((state) => state.focusedSmartReplyKey);
  const dismissThread = useAppStore((state) => state.dismissSmartReplyThread);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const visible = !!notice || loading || replies.length > 0;
  const actionableFailure = notice?.reason === "no_provider" || notice?.reason === "trial_expired";

  const dismiss = () => {
    if (focusedKey) {
      dismissThread(focusedKey);
      return;
    }
    setReplies([]);
    setNotice(null);
    setLoading(false);
  };

  if (compact) {
    return (
      <AnimatePresence initial={false}>
        {visible && (
          <motion.button
            type="button"
            key="mobile-smart-reply-notice"
            initial={{ opacity: 0, y: 8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: 8, height: 0 }}
            onClick={onOpenContext}
            className="mx-2 mb-1 flex min-h-9 shrink-0 items-center gap-2 overflow-hidden rounded-lg border border-cyan-400/25 bg-[#0d151b]/95 px-3 text-left text-[10px] font-bold text-cyan-200"
            aria-label="Open Smart Replies in Context"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AtSign className="h-3.5 w-3.5" />}
            <span className="min-w-0 flex-1 truncate">
              @{notice?.username ?? "mention"} · {replies.length > 0 ? `${replies.length} replies` : loading ? "generating replies" : "reply needs attention"}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.section
          key={`${notice?.messageId ?? "reply"}:${notice?.state ?? (loading ? "loading" : "ready")}`}
          initial={{ opacity: 0, y: 10, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: 8, height: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="mobile-smart-reply-shelf shrink-0 overflow-hidden border-t border-cyan-400/20 bg-[#0d151b]/95 backdrop-blur-xl"
          aria-label="Smart Replies"
          aria-live={notice?.state === "error" ? "assertive" : "polite"}
          aria-busy={loading}
        >
          <div className="flex items-start gap-2 px-3 pt-2 pb-1.5">
            <span className={cn(
              "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border",
              notice?.state === "error" || notice?.state === "unavailable"
                ? "border-amber-400/35 bg-amber-400/10 text-amber-300"
                : "border-cyan-400/35 bg-cyan-400/10 text-cyan-300 mobile-mention-pulse",
            )}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : notice?.state === "error" || notice?.state === "unavailable" ? <AlertCircle className="h-3.5 w-3.5" /> : <AtSign className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-cyan-300">
                Smart Replies
                {notice?.username && (
                  <span className="truncate font-mono normal-case tracking-normal text-cyan-100/70">
                    @{notice.username} → @{notice.botUsername}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-[11px] text-gray-400">
                {loading
                  ? "Mention detected — generating replies…"
                  : notice?.message
                    ? notice.message
                    : notice?.state === "ready" || replies.length > 0
                      ? "Choose one reply to send. Nothing is sent automatically."
                      : "Direct mention detected."}
              </p>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss Smart Replies"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {replies.length > 0 && !loading && (
            <div className="flex gap-2 overflow-x-auto px-3 pb-2.5 pt-1 [scrollbar-width:none]">
              {replies.map((reply) => (
                <button
                  key={reply.id}
                  type="button"
                  disabled={!!sendingId || !channel}
                  onClick={async () => {
                    if (!channel || sendingId) return;
                    setSendingId(reply.id);
                    try {
                      await sendManualMessage({
                        message: reply.text,
                        channel,
                        botId: reply.botId,
                        source: "smart_reply",
                      });
                      if (messageSoundEnabled) playMessageSound();
                      playSfx("send_message");
                      toast.success("Smart Reply sent");
                      dismiss();
                    } catch (error) {
                      playSfx("error");
                      toast.error(error instanceof Error ? error.message : "Failed to send Smart Reply");
                    } finally {
                      setSendingId(null);
                    }
                  }}
                  className="group flex min-h-11 max-w-[min(82vw,22rem)] shrink-0 items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-2 text-left text-[11px] font-semibold leading-snug text-cyan-50 shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition-all duration-150 hover:border-cyan-300/50 hover:bg-cyan-400/[0.14] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80"
                >
                  {sendingId === reply.id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Send className="h-3.5 w-3.5 shrink-0 text-cyan-300 transition-transform group-hover:translate-x-0.5" />}
                  <span className="line-clamp-2">{reply.text}</span>
                </button>
              ))}
            </div>
          )}

          {actionableFailure && (
            <div className="px-3 pb-2.5">
              <button
                type="button"
                onClick={() => { onOpenTuning(); playSfx("select_change"); }}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 text-[10px] font-bold uppercase tracking-wide text-amber-200 transition-colors hover:bg-amber-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
              >
                <Settings className="h-3.5 w-3.5" />
                Open Tuning
              </button>
            </div>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
