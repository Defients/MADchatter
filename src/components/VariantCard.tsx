import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Copy, Send, Sparkles, MessageSquare, RefreshCw, Zap, GripVertical, X, AtSign, Check } from "lucide-react";
import { ForgeSuggestion, Bot } from "../types";
import { toast } from "sonner";
import { playSfx } from "../lib/sfx";
import { useAppStore } from "../store";
import { Input } from "./ui/input";
import { Tooltip, TooltipTrigger, TooltipContent, ThemedTooltip } from "./ui/tooltip";
import { cn } from "../lib/utils";

interface VariantCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant: ForgeSuggestion;
  onSend: (message: string, botId?: string) => void;
  onDryRunSend?: (message: string) => void | Promise<void>;
  onRefine: (id: number, type: string, customInstruction?: string) => Promise<void>;
  onClose?: (id: number) => void;
  multiBotActive?: boolean;
  activeBots?: Bot[];
}

const getProfileColor = (profile: string) => {
  const p = profile.toLowerCase();
  if (p.includes("gremlin"))
    return "bg-orange-500/10 text-orange-400 border-orange-500/20";
  if (p.includes("hype")) return "bg-red-500/10 text-red-400 border-red-500/20";
  if (p.includes("analyst"))
    return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  return "bg-teal-500/10 text-teal-400 border-teal-500/20";
};

export const VariantCard: React.FC<VariantCardProps> = ({
  variant,
  onSend,
  onRefine,
  onClose,
  multiBotActive = false,
  activeBots = [],
}) => {
  const [isSending, setIsSending] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  // A card locks once its message text has actually been sent — matched against
  // the sent-message records so the state survives re-renders and works for
  // multi-bot sends. Refining changes the text, which naturally unlocks the card.
  const sentMessages = useAppStore((s) => s.sentMessages);
  const bots = useAppStore((s) => s.bots);
  const trimmedMsg = variant.message.trim();
  const hasSent =
    sentMessages.some((m) => !m.dryRun && m.message.trim() === trimmedMsg) ||
    bots.some((b) => b.runtime.sentMessages.some((m) => !m.dryRun && m.message.trim() === trimmedMsg));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [customRefineInput, setCustomRefineInput] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    };
  }, []);

  const startCardDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('[role="button"]')) {
      return;
    }
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (!draggedWidth) {
      setDraggedWidth(rect.width);
    }
    setDragPos({ x: rect.left, y: rect.top });
    setIsDragging(true);
    e.preventDefault();
  };

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      setDragPos({
        x: e.clientX - dragOffsetRef.current.x,
        y: e.clientY - dragOffsetRef.current.y
      });
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  const handleCopy = () => {
    navigator.clipboard.writeText(variant.message).then(
      () => { toast.success("Copied to clipboard!"); playSfx('copy'); },
      () => toast.error("Failed to copy — clipboard not available"),
    );
  };

  const handleDoubleClick = () => {
    navigator.clipboard.writeText(variant.message).then(
      () => { toast.success("Copied to clipboard!"); playSfx('copy'); },
      () => {},
    );
  };

  const handleSend = () => {
    setIsSending(true);
    onSend(variant.message);
    sendTimerRef.current = setTimeout(() => {
      setIsSending(false);
      sendTimerRef.current = null;
    }, 2000);
  };

  const handleSendAsBot = (botId: string) => {
    setIsSending(true);
    onSend(variant.message, botId);
    sendTimerRef.current = setTimeout(() => {
      setIsSending(false);
      sendTimerRef.current = null;
    }, 2000);
  };

  const handleRefineClick = async (type: string, customText?: string) => {
    setIsRefining(true);
    try {
      await onRefine(variant.variant_id, type, customText);
      setDialogOpen(false);
      setCustomRefineInput("");
    } catch (e) {
      // toast shown by parent
    } finally {
      setIsRefining(false);
    }
  };

  const refineChips = [
    { label: "🔥 Hype", type: "hype" },
    { label: "👹 Troll", type: "gremlin" },
    { label: "✂️ Shorten", type: "short" },
    { label: "🧠 Analyst", type: "analyze" },
    { label: "😏 Sarcastic", type: "sarcasm" }
  ];

  const card = (
    <div
      ref={cardRef}
      style={dragPos ? {
        position: "fixed",
        left: `${dragPos.x}px`,
        top: `${dragPos.y}px`,
        width: draggedWidth ? `${draggedWidth}px` : undefined,
        zIndex: 25000, // Higher than any other panel and 'mini-widgets'
        pointerEvents: "auto",
        transition: isDragging ? "none" : "transform 0.15s ease-out, left 0.15s ease-out, top 0.15s ease-out",
      } : undefined}
    >
    <Card
      className={cn(
        "bg-[#121217] border-white/5 rounded-xl overflow-hidden flex flex-col hover:border-white/10 hover:shadow-[0_4px_24px_rgba(0,0,0,0.4)] transition-all shadow-none",
        variant.best && "border-cyan-400/40 shadow-[0_0_16px_rgba(34,211,238,0.15)]"
      )}
      style={isDragging ? { cursor: "grabbing" } : undefined}
    >
      {/* Card Header — draggable */}
      <div
        onMouseDown={startCardDrag}
        className="flex items-center justify-between p-2 border-b border-white/5 bg-[#0F0F12] cursor-grab active:cursor-grabbing select-none hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <GripVertical className="w-3 h-3 text-gray-600 shrink-0" />
          <Badge
            variant="outline"
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${getProfileColor(variant.profile)}`}
          >
            {variant.profile}
          </Badge>
          {variant.best && (
            <ThemedTooltip content="Highest-ranked variant by local scoring" zIndex={25001}>
              <Badge
                variant="outline"
                className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border bg-cyan-500/15 border-cyan-400/40 text-cyan-300 pointer-events-none"
              >
                ★ Best
              </Badge>
            </ThemedTooltip>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge
            variant="outline"
            className="text-[9px] bg-white/5 border-white/10 text-gray-500 font-mono pointer-events-none"
          >
            {variant.message.length} chars
          </Badge>
          <ThemedTooltip content="Estimated token size of this comment" zIndex={25001}>
            <Badge
              variant="outline"
              className="text-[9px] bg-yellow-500/15 border-yellow-500/20 text-yellow-400 font-mono font-bold pointer-events-none"
            >
              ~{Math.ceil(variant.message.length / 4.1)} TKNS
            </Badge>
          </ThemedTooltip>
          <Badge
            variant="outline"
            className="text-[9px] bg-purple-500/10 border-purple-500/20 text-purple-400 font-bold font-mono pointer-events-none"
          >
            CONF: {Math.round(variant.confidence * 100)}%
          </Badge>
          {onClose && (
            <ThemedTooltip content="Close card" zIndex={25001}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(variant.variant_id);
                }}
                className="p-1 text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </ThemedTooltip>
          )}
        </div>
      </div>

      {/* Card Body */}
      <div className="flex-1 p-2 flex flex-col justify-center">
        <ThemedTooltip content="Double-click to copy" zIndex={25001}>
          <div className="bg-[#18181B] border border-white/5 rounded-lg p-2.5 relative shadow-inner" onDoubleClick={handleDoubleClick}>
            <MessageSquare className="absolute -left-2 -top-2 w-4 h-4 text-gray-600 fill-current opacity-10" />
            <p className="text-sm text-gray-200 leading-relaxed font-semibold">
              {variant.message}
            </p>
          </div>
        </ThemedTooltip>
        {variant.why_it_fits && (
          <div className="mt-1.5 p-1.5 bg-[#0F0F12]/50 rounded-lg border border-white/5 flex gap-1.5 items-start">
            <span className="text-[10px] uppercase font-bold text-orange-400 font-mono leading-none pt-0.5">FIT:</span>
            <p className="text-[10px] text-gray-400 leading-snug font-medium flex-1">
              {variant.why_it_fits}
            </p>
          </div>
        )}
      </div>

      {/* Card Actions */}
      <div className="p-2 bg-[#0F0F12] border-t border-white/5 flex gap-1.5 shrink-0">
        {/* Copy Button */}
        <ThemedTooltip content="Copy message to clipboard" zIndex={25001}>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0 bg-white/5 border-white/10 hover:bg-white/10 text-gray-300 rounded-lg"
            onClick={handleCopy}
          >
            <Copy className="w-4 h-4" />
          </Button>
        </ThemedTooltip>

        {/* Refine Dialog Trigger */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <ThemedTooltip content="Refine Suggestion" zIndex={25001}>
            <DialogTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0 bg-white/5 border-white/10 hover:bg-white/10 text-gray-300 rounded-lg"
                />
              }
            >
              <Sparkles className="w-4 h-4 text-orange-400 animate-pulse" />
            </DialogTrigger>
          </ThemedTooltip>
          <DialogContent className="sm:max-w-[425px] bg-[#0a0a0f] border-white/10 text-white shadow-2xl">
            <DialogHeader>
              <DialogTitle className="text-white font-black uppercase tracking-wider text-sm font-mono border-b border-white/5 pb-2">
                Refine Variant #{variant.variant_id}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              <div className="p-3 bg-white/5 border border-white/10 rounded-xl">
                <span className="text-[9px] font-black uppercase tracking-widest text-gray-500 block mb-1">
                  Original Suggestion
                </span>
                <p className="text-xs text-gray-200 italic leading-relaxed">
                  "{variant.message}"
                </p>
              </div>

              {/* Refinement Preset chips */}
              <div className="space-y-1.5">
                <span className="text-[9px] font-black uppercase tracking-widest text-gray-500 block">
                  Quick Style Presets
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {refineChips.map((chip) => (
                    <Badge
                      key={chip.type}
                      variant="outline"
                      className="text-[10px] bg-white/5 border-white/10 text-gray-300 hover:bg-[#ff6b00]/20 hover:border-[#ff6b00]/30 cursor-pointer transition-all py-1 px-2.5"
                      onClick={() => handleRefineClick(chip.type)}
                    >
                      {chip.label}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Custom instruction input */}
              <div className="space-y-1.5">
                <span className="text-[9px] font-black uppercase tracking-widest text-gray-500 block">
                  Custom Refinement Directive
                </span>
                <div className="flex gap-2">
                  <Input
                    value={customRefineInput}
                    onChange={(e) => setCustomRefineInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customRefineInput.trim()) {
                        handleRefineClick("custom", customRefineInput);
                      }
                    }}
                    placeholder="e.g. 'Make it super sarcastic' or 'Add emojis'..."
                    className="flex-1 bg-black/40 border-white/10 text-xs text-gray-300"
                    autoFocus
                  />
                  <Button
                    onClick={() => handleRefineClick("custom", customRefineInput)}
                    disabled={isRefining || !customRefineInput.trim()}
                    className="bg-orange-500 hover:bg-orange-600 text-white font-black text-xs uppercase shrink-0"
                  >
                    {isRefining ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      "Forge"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Send to Chat — multi-bot mode shows per-bot numbered squares */}
        {multiBotActive && activeBots.length >= 2 ? (
          <div className="flex-1 flex gap-1 items-stretch">
            {activeBots.slice(0, 9).map((bot, idx) => (
              <Tooltip key={bot.id}>
                <TooltipTrigger
                  render={
                    <button
                      onClick={() => handleSendAsBot(bot.id)}
                      disabled={isSending || hasSent}
                      className={cn(
                        "flex-1 h-8 min-w-0 rounded-lg font-black text-xs flex items-center justify-center transition-all border",
                        hasSent
                          ? "bg-white/5 text-gray-600 border-white/5 cursor-not-allowed"
                          : isSending
                          ? "bg-green-600/30 text-green-300 border-green-500/30"
                          : "bg-green-500/15 border-green-500/30 text-green-300 hover:bg-green-500 hover:text-black hover:border-green-400",
                      )}
                    >
                      <span className="flex flex-col items-center gap-0.5">
                        {hasSent ? <Check className="w-3 h-3 shrink-0" /> : <Send className="w-3 h-3 shrink-0" />}
                        <span className="text-[9px] leading-none">{idx + 1}</span>
                      </span>
                    </button>
                  }
                />
                <TooltipContent
                  side="top"
                  sideOffset={6}
                  zIndex={25001}
                  className="bg-[#1a1a1f] border border-green-500/30 text-green-300 text-[11px] font-semibold rounded-lg px-2.5 py-1.5 shadow-xl flex items-center gap-1.5"
                >
                  <AtSign className="w-3 h-3 text-green-400/70 shrink-0" />
                  <span className="font-mono">{bot.session?.username ?? bot.label}</span>
                  <span className="text-green-500/50 font-mono ml-0.5">#{idx + 1}</span>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : (
          <div className="flex-1 flex gap-1.5 items-stretch">
            <Button
              className={cn(
                "flex-1 h-8 font-black tracking-widest text-xs rounded-lg",
                hasSent
                  ? "bg-white/5 text-gray-600 border border-white/5 cursor-not-allowed shadow-none"
                  : `shadow-[0_0_15px_rgba(34,197,94,0.2)] ${isSending ? "bg-green-600 text-white" : "bg-green-500 hover:bg-green-400 text-black"}`,
              )}
              onClick={handleSend}
              disabled={isSending || hasSent}
            >
              {hasSent ? (
                <span className="flex items-center gap-1.5 justify-center">
                  <Check className="w-3.5 h-3.5 shrink-0" /> SENT
                </span>
              ) : isSending ? (
                "SENT!"
              ) : (
                <span className="flex items-center gap-1.5 justify-center">
                  <Send className="w-3.5 h-3.5 shrink-0" /> SEND TO CHAT
                </span>
              )}
            </Button>
          </div>
        )}
      </div>
    </Card>
    </div>
  );

  // When dragging, portal to document.body so position:fixed is relative to the
  // viewport, not the transformed motion.div forge group ancestor.
  return dragPos ? createPortal(card, document.body) : card;
};
