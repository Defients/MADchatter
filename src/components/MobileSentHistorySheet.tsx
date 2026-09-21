import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { History, X } from "lucide-react";
import { useAppStore } from "../store";
import { selectMergedSentMessages } from "../lib/sentHistory";
import { SentMessageHistory } from "./SentMessageHistory";
import { playSfx } from "../lib/sfx";

export function MobileSentHistorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sheetRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const sentMessages = useAppStore((state) => state.sentMessages);
  const bots = useAppStore((state) => state.bots);
  const messages = useMemo(() => selectMergedSentMessages(sentMessages, bots), [sentMessages, bots]);
  const clear = () => {
    const state = useAppStore.getState();
    state.clearSentMessages();
    for (const bot of state.bots) state.clearBotSentMessages(bot.id);
  };
  const close = () => { onClose(); playSfx("drawer_close"); };

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      playSfx("drawer_close");
    };
    window.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLElement>('button[aria-label="Close sent history"]')?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[85] flex items-end bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.section
            ref={sheetRef}
            role="dialog" aria-modal="true" aria-label="Sent message history"
            initial={{ y: 28, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 28, opacity: 0 }}
            transition={{ duration: 0.18 }} onClick={(event) => event.stopPropagation()}
            className="flex max-h-[72dvh] min-h-[15rem] w-full flex-col overflow-hidden rounded-t-2xl border border-b-0 border-white/10 bg-[#121217] pb-[env(safe-area-inset-bottom)] shadow-2xl"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-white/10 bg-black/30 px-3 py-2.5">
              <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-200">
                <History className="h-4 w-4 text-cyan-300" /> Sent History
                <span className="font-mono text-[9px] text-gray-500">{messages.length}</span>
              </span>
              <button type="button" onClick={close} aria-label="Close sent history" className="mobile-icon-control rounded-lg p-1.5 text-gray-500 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </header>
            <SentMessageHistory messages={messages} onClear={clear} compact />
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
