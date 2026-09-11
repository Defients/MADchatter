import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { Users, X, Plus, Trash2, Bot as BotIcon, Zap, LogOut, Send, ChevronDown, ChevronUp, Megaphone } from "lucide-react";
import { cn } from "../lib/utils";
import { useAppStore, selectMultiBotActive } from "../store";
import { useTwitchAuth } from "../hooks/useTwitchAuth";
import { useKickAuth } from "../hooks/useKickAuth";
import { removeTwitchSessionForBot } from "../lib/twitch";
import { removeKickSessionForBot } from "../lib/kick";
import { getPlatformSendFn } from "../lib/platformSend";
import { playMessageSound } from "../lib/sound";
import { speakMessage } from "../lib/tts";
import { ThemedTooltip } from "./ui/tooltip";

/**
 * MultiBotPanel — toggle + bot management UI (multi-bot mode).
 *
 * Rendered only when the user opens it. When multiBotEnabled === false the
 * panel shows just the toggle; the rest of the app remains on the original
 * single-bot UI. Enabling copies the current single-bot state into bots[0]
 * (non-destructive); disabling syncs bots[0] back into the global fields.
 */
export function MultiBotPanel({ onClose }: { onClose?: () => void }) {
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const enableMultiBot = useAppStore((s) => s.enableMultiBot);
  const disableMultiBot = useAppStore((s) => s.disableMultiBot);
  const bots = useAppStore((s) => s.bots);
  const removeBot = useAppStore((s) => s.removeBot);
  const updateBotPersona = useAppStore((s) => s.updateBotPersona);
  const platform = useAppStore((s) => s.platform);

  const twitchAuth = useTwitchAuth();
  const kickAuth = useKickAuth();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const dragControls = useDragControls();

  // Bots that already have a live session.
  const authedBots = bots.filter((b) => b.session);

  const handleAddBot = () => {
    if (platform === "kick") {
      kickAuth.addKickBot();
    } else {
      twitchAuth.addBot();
    }
  };

  // Authenticate an EXISTING bot slot (e.g. the auto-seeded primary) that has
  // no session yet. Opens OAuth routed back to that slot via the state param.
  const handleAuthBot = (botId: string) => {
    if (platform === "kick") {
      kickAuth.authKickBot(botId);
    } else {
      twitchAuth.authBot(botId);
    }
  };

  // Log off a bot: clear its session (keeps the slot, persona, and memory).
  const handleLogoffBot = (botId: string) => {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) return;
    if (bot.platform === "kick") {
      removeKickSessionForBot(botId);
    } else {
      removeTwitchSessionForBot(botId);
    }
    useAppStore.getState().bumpAuthTick();
    toast.success(`Logged off ${bot.label}`);
  };

  // Persistent info toast: while multi-bot is on and fewer than two bots are
  // authenticated, keep an informative toast on screen that does not auto-dismiss.
  // It is cleared only once two bots are connected (or multi-bot is turned off).
  //
  // No cleanup is returned: under React StrictMode (dev) an effect runs
  // setup → cleanup → setup, and a cleanup that calls toast.dismiss() would
  // kill the toast mid-animation; sonner then ignores the re-show for the same
  // id, leaving it closed (the "flashes then disappears" bug). Dismissing only
  // on the explicit clear-conditions below avoids that.
  useEffect(() => {
    if (!multiBotEnabled || authedBots.length >= 2) {
      toast.dismiss("multibot-auth-prompt");
      return;
    }
    const platformName = platform === "kick" ? "Kick" : "Twitch";
    const site = platform === "kick" ? "kick.com" : "twitch.tv";
    const remaining = 2 - authedBots.length;
    toast.info(`${remaining === 2 ? "Authenticate two" : "Authenticate one more"} ${platformName} bot${remaining === 1 ? "" : "s"} to enable multi-bot`, {
      id: "multibot-auth-prompt",
      duration: Infinity,
      description: `Hit "Auth" on the Primary bot, then "Add ${platformName} Bot" for a second account. The login popup authorizes whichever ${platformName} account is logged in — to add a different bot, use the account switcher / "Log Out" link on the ${platformName} authorize page in the popup (or switch accounts on ${site} beforehand), then approve. This message stays until two bots are connected.`,
    });
  }, [multiBotEnabled, authedBots.length, platform]);

  return (
    <motion.div
      drag
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      className="w-80 max-h-[70vh] overflow-hidden bg-[#0F0F12]/95 border border-white/10 rounded-lg shadow-2xl backdrop-blur-md flex flex-col"
    >
      {/* Header — drag handle + collapse/close. Always visible. */}
      <div
        onPointerDown={(e) => dragControls.start(e)}
        className="flex items-center justify-between p-3 border-b border-white/10 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[#9146FF]" />
          <span className="text-xs font-bold uppercase tracking-wider text-white">Multi-Bot</span>
        </div>
        <div className="flex items-center gap-2">
          <Toggle on={multiBotEnabled} onChange={(v) => (v ? enableMultiBot() : disableMultiBot())} />
          <ThemedTooltip content={collapsed ? "Expand" : "Collapse"}>
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </ThemedTooltip>
          {onClose && (
            <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 forge-scroll">
            {!multiBotEnabled ? (
              <p className="text-[11px] text-gray-400 leading-relaxed">
                Off — single-bot mode (the original experience). Turn on to run multiple bot identities in this channel, each with its own persona &amp; brain. Existing settings are preserved.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  Each bot has its own identity, persona, and memory. AutoForge picks one speaker per cycle. Add a bot to authenticate a second account.
                </p>

                {/* Bot list */}
                <div className="flex flex-col gap-2">
                  {bots.map((bot, idx) => (
                    <div key={bot.id} className="border border-white/10 rounded-md bg-white/[0.02]">
                      <div className="flex items-center gap-2 p-2">
                        <BotIcon className={cn("w-3.5 h-3.5 shrink-0", bot.active ? "text-[#9146FF]" : "text-gray-600")} />
                        {idx < 9 && (
                          <ThemedTooltip content={`Press ${idx + 1} to toggle this bot`}>
                            <kbd
                              className="text-[9px] font-mono font-bold bg-white/10 border border-white/15 rounded px-1 py-0.5 text-gray-300 shrink-0"
                            >
                              {idx + 1}
                            </kbd>
                          </ThemedTooltip>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className={cn("text-[11px] font-bold truncate", bot.active ? "text-white" : "text-gray-500 line-through")}>{bot.label}</div>
                          <div className="text-[10px] text-gray-400 truncate">
                            {bot.session ? `@${bot.session.username}` : "Not authenticated"}
                            {idx === 0 ? " · primary" : ""}
                            {!bot.active ? " · paused" : ""}
                          </div>
                        </div>
                        <button
                          onClick={() => setExpandedId(expandedId === bot.id ? null : bot.id)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-gray-300 transition-colors"
                        >
                          {expandedId === bot.id ? "Hide" : "Edit"}
                        </button>
                        {!bot.session && platform !== "joystick" && (
                          <ThemedTooltip content={`Authenticate this bot with ${platform === "kick" ? "Kick" : "Twitch"}`}>
                            <button
                              onClick={() => handleAuthBot(bot.id)}
                              className="text-[10px] px-2 py-0.5 rounded bg-[#9146FF] hover:bg-[#772ce8] text-white font-bold uppercase tracking-wider transition-colors"
                            >
                              Auth
                            </button>
                          </ThemedTooltip>
                        )}
                        {bot.session && (
                    <ThemedTooltip content="Log off (keep the bot slot & memory)">
                      <button
                        onClick={() => handleLogoffBot(bot.id)}
                        className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                      >
                        <LogOut className="w-3 h-3" />
                      </button>
                    </ThemedTooltip>
                  )}
                  {idx !== 0 && (
                    <ThemedTooltip content="Remove bot">
                      <button
                        onClick={() => removeBot(bot.id)}
                        className="p-1 rounded hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </ThemedTooltip>
                  )}
                </div>

                {expandedId === bot.id && (
                  <div className="p-2 pt-0 flex flex-col gap-2 border-t border-white/5">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase tracking-wider text-gray-400">Label</span>
                      <input
                        value={bot.label}
                        onChange={(e) => {
                          // label lives on Bot, not persona — update via a direct store set
                          useAppStore.setState((s) => ({
                            bots: s.bots.map((b) => (b.id === bot.id ? { ...b, label: e.target.value } : b)),
                          }));
                        }}
                        className="text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-white outline-none focus:border-[#9146FF]/50"
                      />
                    </label>
                    <PersonaControls botId={bot.id} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add bot */}
          {platform !== "joystick" && (
            <button
              onClick={handleAddBot}
              className="flex items-center justify-center gap-1.5 h-8 rounded-md bg-[#9146FF]/20 hover:bg-[#9146FF]/30 border border-[#9146FF]/40 text-[#c79bff] text-[11px] font-bold uppercase tracking-wider transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add {platform === "kick" ? "Kick" : "Twitch"} Bot
            </button>
          )}
          {platform === "joystick" && (
            <p className="text-[10px] text-gray-500">Joystick multi-bot is not supported in v1.</p>
          )}
        </>
      )}
          </div>
        </>
      )}

      {/* Director note input — private streamer-to-bot directives (never sent to chat) */}
      {multiBotEnabled && <DirectorNoteInput />}

      {/* Pinned direct-message sender — always visible, even when collapsed */}
      {multiBotEnabled && <ChatSender />}
    </motion.div>
  );
}

/** Persona tuning controls for a single bot. */
function PersonaControls({ botId }: { botId: string }) {
  const bot = useAppStore((s) => s.bots.find((b) => b.id === botId));
  const updateBotPersona = useAppStore((s) => s.updateBotPersona);
  if (!bot) return null;
  const c = bot.persona.config;
  const setConfig = (patch: Partial<typeof c>) => updateBotPersona(botId, { config: { ...c, ...patch } });

  return (
    <div className="flex flex-col gap-2.5">
      {/* Primary profile — the bot's dominant "voice" */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-400">Primary profile</span>
        <div className="grid grid-cols-3 gap-1">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              onClick={() => setConfig({ primaryProfile: p.id })}
              className={cn(
                "text-[10px] py-1 rounded border transition-colors",
                c.primaryProfile === p.id
                  ? "bg-[#9146FF]/25 border-[#9146FF]/60 text-[#c79bff]"
                  : "bg-white/[0.02] border-white/10 text-gray-400 hover:bg-white/5",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <Slider label="Humor" value={c.humorLevel} onChange={(v) => setConfig({ humorLevel: v })} />
      <Slider label="Chaos" value={c.chaosLevel} onChange={(v) => setConfig({ chaosLevel: v })} />

      <Segmented
        label="Emote density"
        value={c.emoteDensity}
        options={[["minimal", "Minimal"], ["moderate", "Moderate"], ["heavy", "Heavy"]]}
        onChange={(v) => setConfig({ emoteDensity: v })}
      />
      <Segmented
        label="Length"
        value={c.lengthPreference}
        options={[["short", "Short"], ["medium", "Medium"], ["long", "Long"]]}
        onChange={(v) => setConfig({ lengthPreference: v })}
      />
      <Segmented
        label="Effort"
        value={c.effortLevel || "medium"}
        options={[["smart", "Smart"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]]}
        onChange={(v) => setConfig({ effortLevel: v as "low" | "medium" | "high" | "smart" })}
      />

      {/* System Directive — free-form per-bot instructions */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-400">System directive</span>
        <textarea
          value={c.customDirectives}
          onChange={(e) => setConfig({ customDirectives: e.target.value })}
          rows={3}
          placeholder="Unique instructions for THIS bot — e.g. 'Speak like a grumpy arena announcer. Never use exclamation marks. Root for the underdog.'"
          className="text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-white outline-none focus:border-[#9146FF]/50 resize-none themed-scroll overflow-y-auto"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-400">Identity mode</span>
        <select
          value={bot.persona.botIdentityMode}
          onChange={(e) => updateBotPersona(botId, { botIdentityMode: e.target.value as "admit" | "custom" })}
          className="text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-white outline-none focus:border-[#9146FF]/50"
        >
          <option value="admit">Admit (it's a bot)</option>
          <option value="custom">Custom persona</option>
        </select>
      </label>
      {bot.persona.botIdentityMode === "custom" && (
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-gray-400">Persona story</span>
          <textarea
            value={bot.persona.botIdentityStory}
            onChange={(e) => updateBotPersona(botId, { botIdentityStory: e.target.value })}
            rows={3}
            placeholder="Who this bot is..."
            className="text-[11px] bg-black/40 border border-white/10 rounded px-2 py-1 text-white outline-none focus:border-[#9146FF]/50 resize-none themed-scroll overflow-y-auto"
          />
        </label>
      )}
    </div>
  );
}

const PROFILES: { id: string; label: string }[] = [
  { id: "hype", label: "Hype" },
  { id: "analyst", label: "Analyst" },
  { id: "gremlin", label: "Gremlin" },
  { id: "Support", label: "Support" },
  { id: "Chill", label: "Chill" },
  { id: "translator", label: "Translator" },
];

/** A small segmented control (single-select pill group). */
function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
      <div className="grid grid-cols-3 gap-1">
        {options.map(([val, lbl]) => (
          <button
            key={val}
            onClick={() => onChange(val)}
            className={cn(
              "text-[10px] py-1 rounded border transition-colors",
              value === val
                ? "bg-[#9146FF]/25 border-[#9146FF]/60 text-[#c79bff]"
                : "bg-white/[0.02] border-white/10 text-gray-400 hover:bg-white/5",
            )}
          >
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
        <span className="text-[10px] text-gray-300">{value}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[#9146FF] h-1"
      />
    </label>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={cn(
        "relative w-9 h-5 rounded-full transition-colors",
        on ? "bg-[#9146FF]" : "bg-white/15",
      )}
      aria-pressed={on}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform",
          on && "translate-x-4",
        )}
      />
    </button>
  );
}

/**
 * DirectorNoteInput — lets the streamer send private directives to one bot or
 * all bots. Unlike ChatSender, these notes are NEVER sent to the chat channel.
 * They are injected into the bot's AutoForge context as a high-priority
 * [DIRECTOR NOTES] section so the bot adapts its behavior mid-stream.
 * Rendered above ChatSender when multi-bot mode is enabled.
 */
function DirectorNoteInput() {
  const bots = useAppStore((s) => s.bots);
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const addBotDirectorNote = useAppStore((s) => s.addBotDirectorNote);
  const addBotAutoForgeEvent = useAppStore((s) => s.addBotAutoForgeEvent);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>("all"); // "all" | botId

  const activeBots = bots.filter((b) => b.active);

  const handleSend = () => {
    const message = text.trim();
    if (!message || activeBots.length === 0) return;

    const targets = target === "all" ? activeBots : activeBots.filter((b) => b.id === target);
    if (targets.length === 0) return;

    for (const bot of targets) {
      addBotDirectorNote(bot.id, message);
      addBotAutoForgeEvent(bot.id, {
        timestamp: Date.now(),
        type: "director_note",
        severity: "high",
        summary: `Director note: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`,
        details: { source: "director", message, botId: bot.id },
      });
    }

    const names = targets.map((b) => `@${b.session?.username ?? "?"}`).join(", ");
    toast.success(`Director note sent to ${names}`, {
      description: "The bot(s) will factor this into their next AutoForge decision.",
    });
    setText("");
  };

  return (
    <div className="shrink-0 border-t border-white/10 bg-gradient-to-b from-purple-950/20 to-black/30 p-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Megaphone className="w-3 h-3 text-purple-400 shrink-0" />
        <span className="text-[9px] uppercase tracking-wider text-purple-400 font-bold shrink-0">Director Note</span>
        <ThemedTooltip
          side="bottom"
          content={
            <div className="max-w-[220px] space-y-1">
              <div className="font-bold text-purple-300">Director Notes</div>
              <div>Private directives to your bot(s). <span className="text-purple-300 font-semibold">Never sent to chat</span> — injected into the bot's next AutoForge decision as a high-priority directive.</div>
              <div className="text-gray-400">Use for feedback, status updates, or things you want the bot to remember mid-stream.</div>
            </div>
          }
        >
          <span className="text-gray-600 hover:text-purple-400 transition-colors cursor-help text-[10px]">?</span>
        </ThemedTooltip>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={activeBots.length === 0}
          className="flex-1 min-w-0 text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-white outline-none focus:border-purple-500/50 disabled:opacity-50"
        >
          <option value="all" className="bg-[#0F0F12] text-white">All bots ({activeBots.length})</option>
          {activeBots.map((b, i) => (
            <option key={b.id} value={b.id} className="bg-[#0F0F12] text-white">
              #{i + 1} @{b.session?.username ?? "?"}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-stretch gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Direct your bot(s) — e.g. 'tone it down', 'the raid is starting soon', 'remember this user likes X'…"
          disabled={activeBots.length === 0}
          rows={2}
          className="flex-1 min-w-0 resize-none text-[11px] leading-snug bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white outline-none focus:border-purple-500/50 placeholder:text-gray-600 disabled:opacity-50 forge-scroll"
        />
        <ThemedTooltip content="Send director note (Enter)">
          <button
            onClick={handleSend}
            disabled={text.trim().length === 0 || activeBots.length === 0}
            className={cn(
              "shrink-0 w-8 flex items-center justify-center rounded-md border transition-colors",
              text.trim().length === 0 || activeBots.length === 0
                ? "bg-white/5 border-white/10 text-gray-600 cursor-not-allowed"
                : "bg-purple-600 border-purple-500/60 text-white hover:bg-purple-500",
            )}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </ThemedTooltip>
      </div>
    </div>
  );
}

/**
 * ChatSender — pinned to the bottom of the MultiBotPanel. Lets the user type a
 * direct message and send it to the channel as the bot selected in the
 * dropdown (shares manualSendBotId with the header SendAsPicker). Mirrors the
 * bookkeeping in TheForge.handleSend so the send is recorded against the
 * chosen bot's runtime/stats/event log.
 */
function ChatSender() {
  const bots = useAppStore((s) => s.bots);
  const platform = useAppStore((s) => s.platform);
  const streamMetadata = useAppStore((s) => s.streamMetadata);
  const manualSendBotId = useAppStore((s) => s.manualSendBotId);
  const setManualSendBotId = useAppStore((s) => s.setManualSendBotId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const sendableBots = bots.filter((b) => b.active && b.session);

  // Keep the dropdown selection valid (in case the header picker isn't mounted
  // or a bot was logged off / removed).
  useEffect(() => {
    if (manualSendBotId && !sendableBots.find((b) => b.id === manualSendBotId)) {
      setManualSendBotId(sendableBots[0]?.id ?? null);
    } else if (!manualSendBotId && sendableBots.length > 0) {
      setManualSendBotId(sendableBots[0].id);
    }
  }, [sendableBots, manualSendBotId, setManualSendBotId]);

  const channel = streamMetadata?.channelName;
  const disabled = sending || !channel || sendableBots.length === 0 || text.trim().length === 0;

  const handleSend = async () => {
    if (disabled) return;
    const message = text.trim();
    const state = useAppStore.getState();
    const botId = manualSendBotId ?? sendableBots[0]?.id ?? null;
    if (!botId || !channel) return;
    setSending(true);
    const toastId = toast.loading("Sending to chat...", { description: `@${sendableBots.find((b) => b.id === botId)?.session?.username}: "${message.substring(0, 40)}"` });
    try {
      const sendFn = getPlatformSendFn(platform, botId);
      await sendFn(channel, message);
      state.setLastManualSendMs(Date.now());
      if (state.messageSoundEnabled) playMessageSound();
      speakMessage(message);
      state.addBotSentMessage(botId, {
        message,
        channel,
        timestamp: Date.now(),
        source: "manual",
        botId,
      });
      state.incrementBotStat(botId, "messagesSent");
      state.addBotAutoForgeEvent(botId, {
        timestamp: Date.now(),
        type: "action_sent",
        severity: "high",
        summary: `Direct send as @${sendableBots.find((b) => b.id === botId)?.session?.username}: "${message.substring(0, 60)}${message.length > 60 ? "..." : ""}"`,
        details: { source: "manual", message, channel, botId },
      });
      setText("");
      toast.success("Sent to chat", { id: toastId });
    } catch (e: any) {
      toast.error(e?.message || "Failed to send message", { id: toastId });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-white/10 bg-black/30 p-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wider text-gray-500 shrink-0">Chat as</span>
        <select
          value={manualSendBotId ?? ""}
          onChange={(e) => setManualSendBotId(e.target.value || null)}
          disabled={sendableBots.length === 0}
          className="flex-1 min-w-0 text-[10px] bg-black/40 border border-white/10 rounded px-1.5 py-1 text-white outline-none focus:border-[#9146FF]/50 disabled:opacity-50"
        >
          {sendableBots.length === 0 && <option value="">No bots authed</option>}
          {sendableBots.map((b) => (
            <option key={b.id} value={b.id} className="bg-[#0F0F12] text-white">
              @{b.session?.username}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-stretch gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={channel ? `Message #${channel}…` : "Set a channel first…"}
          disabled={sendableBots.length === 0 || !channel}
          rows={2}
          className="flex-1 min-w-0 resize-none text-[11px] leading-snug bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white outline-none focus:border-[#9146FF]/50 placeholder:text-gray-600 disabled:opacity-50 forge-scroll"
        />
        <ThemedTooltip content="Send to chat (Enter)">
          <button
            onClick={handleSend}
            disabled={disabled}
            className={cn(
              "shrink-0 w-8 flex items-center justify-center rounded-md border transition-colors",
              disabled
                ? "bg-white/5 border-white/10 text-gray-600 cursor-not-allowed"
                : "bg-[#9146FF] border-[#9146FF]/60 text-white hover:bg-[#772ce8]",
            )}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </ThemedTooltip>
      </div>
    </div>
  );
}

/** Compact launcher button for the header. */
export function MultiBotButton({ onClick, active }: { onClick: () => void; active: boolean }) {
  return (
    <ThemedTooltip content="Multi-Bot">
      <button
        onClick={onClick}
        className={cn(
          "h-7 px-2 flex items-center gap-1.5 rounded-md border text-[10px] font-bold uppercase tracking-wider transition-colors",
          active
            ? "bg-[#9146FF]/20 border-[#9146FF]/50 text-[#c79bff]"
            : "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10",
        )}
      >
        <Zap className="w-3 h-3" />
        <span>Bots</span>
      </button>
    </ThemedTooltip>
  );
}

/**
 * MultiBotModeBadge — a visual indicator shown in the header when the app has
 * actually switched to the multi-bot pipeline (toggle on AND ≥2 bots authed).
 * Fires a toast the first time the mode engages so the change is obvious.
 */
export function MultiBotModeBadge() {
  const multiBotActive = useAppStore(selectMultiBotActive);
  const prevActiveRef = useRef(false);

  useEffect(() => {
    if (multiBotActive && !prevActiveRef.current) {
      toast.success("Multi-Bot mode engaged", {
        description: "Two bots are connected. Per-bot AutoForge loops + the coordinator are now driving; the legacy single-bot loop has stood down.",
        duration: 5000,
      });
    } else if (!multiBotActive && prevActiveRef.current) {
      toast.info("Multi-Bot mode disengaged", {
        description: "Back to the single-bot pipeline.",
        duration: 3500,
      });
    }
    prevActiveRef.current = multiBotActive;
  }, [multiBotActive]);

  return (
    <AnimatePresence>
      {multiBotActive && (
        <ThemedTooltip content="Multi-Bot pipeline is active: per-bot AutoForge + coordinator running">
        <motion.div
          initial={{ opacity: 0, scale: 0.8, width: 0 }}
          animate={{ opacity: 1, scale: 1, width: "auto" }}
          exit={{ opacity: 0, scale: 0.8, width: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="shrink-0 h-7 flex items-center gap-1.5 px-2 rounded-md border border-[#9146FF]/50 bg-[#9146FF]/15 overflow-hidden"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#9146FF] opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#c79bff]" />
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#c79bff] whitespace-nowrap">
            Multi-Bot
          </span>
        </motion.div>
        </ThemedTooltip>
      )}
    </AnimatePresence>
  );
}

/**
 * SendAsPicker — header control that selects which authenticated bot identity
 * manual/Forge sends go out as. Only rendered when multi-bot mode is enabled
 * and at least one bot is authenticated. Lives in the top bar (via ForgeLayout)
 * so it isn't floating inside the centered Forge content area.
 */
export function SendAsPicker() {
  const multiBotEnabled = useAppStore((s) => s.multiBotEnabled);
  const bots = useAppStore((s) => s.bots);
  const manualSendBotId = useAppStore((s) => s.manualSendBotId);
  const setManualSendBotId = useAppStore((s) => s.setManualSendBotId);
  const sendableBots = bots.filter((b) => b.active && b.session);

  // Keep the selection valid as bots come/go (auth/logoff/remove).
  useEffect(() => {
    if (!multiBotEnabled) return;
    if (manualSendBotId && !sendableBots.find((b) => b.id === manualSendBotId)) {
      setManualSendBotId(sendableBots[0]?.id ?? null);
    } else if (!manualSendBotId && sendableBots.length > 0) {
      setManualSendBotId(sendableBots[0].id);
    }
  }, [multiBotEnabled, sendableBots, manualSendBotId, setManualSendBotId]);

  if (!multiBotEnabled || sendableBots.length === 0) return null;

  return (
    <div className="shrink-0 flex items-center gap-1.5 h-7 px-2 rounded-md border border-white/10 bg-white/[0.03]">
      <span className="text-[10px] uppercase tracking-wider text-gray-400">Send as</span>
      <select
        value={manualSendBotId ?? ""}
        onChange={(e) => setManualSendBotId(e.target.value || null)}
        className="text-[11px] bg-transparent border-none outline-none text-white cursor-pointer max-w-[140px]"
      >
        {sendableBots.map((b) => (
          <option key={b.id} value={b.id} className="bg-[#0F0F12] text-white">
            @{b.session?.username}
          </option>
        ))}
      </select>
    </div>
  );
}
