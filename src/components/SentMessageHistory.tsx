import { Copy, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import {
  formatSentHistoryForCopy,
  getSentSourcePresentation,
  type DisplaySentMessage,
} from "../lib/sentHistory";
import { playSfx } from "../lib/sfx";

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function SentMessageHistory({
  messages,
  onClear,
  compact = false,
}: {
  messages: readonly DisplaySentMessage[];
  onClear: () => void;
  compact?: boolean;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatSentHistoryForCopy(messages));
      playSfx("copy");
      toast.success("Sent history copied");
    } catch {
      toast.error("Could not copy sent history");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-1 border-b border-white/5 px-2 py-1.5">
        <button
          type="button"
          onClick={copy}
          aria-label="Copy sent message log"
          disabled={messages.length === 0}
          className="mobile-icon-control rounded p-1.5 text-gray-500 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { onClear(); playSfx("destructive_clear"); }}
          aria-label="Clear sent message log"
          disabled={messages.length === 0}
          className="mobile-icon-control rounded p-1.5 text-gray-500 transition-colors hover:bg-red-500/20 hover:text-red-400 disabled:opacity-30"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className={cn("flex-1 overflow-y-auto forge-scroll", compact ? "space-y-1.5 p-2.5" : "space-y-1 p-2")}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-8">
            <Send className="h-5 w-5 text-gray-700" />
            <span className="font-mono text-[10px] text-gray-600">No messages sent yet</span>
          </div>
        ) : messages.map((message) => {
          const source = getSentSourcePresentation(message.source);
          return (
            <article key={`${message.botId ?? "global"}:${message.id}`} className="rounded-lg border border-white/5 bg-black/30 p-2 transition-colors hover:border-white/10">
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase", source.className)}>
                  {source.label}
                </span>
                {message.botName && (
                  <span className="max-w-[10rem] truncate rounded border border-[#9146FF]/20 bg-[#9146FF]/10 px-1.5 py-0.5 font-mono text-[8px] font-bold text-[#c79bff]">
                    {message.botName}
                  </span>
                )}
                <time className="font-mono text-[9px] text-gray-600">{formatClock(message.timestamp)}</time>
              </div>
              <p className="break-words font-mono text-[11px] leading-snug text-gray-300">{message.message}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
