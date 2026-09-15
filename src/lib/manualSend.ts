import { useAppStore } from "../store";
import { getPlatformSendFn } from "./platformSend";
import { captureSessionScope, isSessionScopeCurrent, normalizeSessionChannel } from "./sessionScope";

type ManualSendSource = "manual" | "smart_reply" | "autoforge";

const pendingSends = new Set<string>();

/** One identity and accounting path for direct chat, variants, and shortcuts. */
export async function sendManualMessage({
  message,
  channel,
  botId,
  source = "manual",
  dryRun = false,
  useBaseIdentity = false,
}: {
  message: string;
  channel: string;
  botId?: string;
  source?: ManualSendSource;
  dryRun?: boolean;
  /** Send as the base singleton login (legacy session) even in multi-bot
   *  mode. The multi-bot roster has its own per-bot send controls; surfaces
   *  like the STUDIO Chat Input represent the user's primary account, not
   *  "Primary" (bots[0]) or whatever manualSendBotId happens to point at. */
  useBaseIdentity?: boolean;
}): Promise<void> {
  const state = useAppStore.getState();
  const scope = captureSessionScope();
  const text = message.trim();
  const destination = channel.trim();
  if (!text) throw new Error("Write a message before sending.");
  if (!destination) throw new Error("Set a channel before sending.");

  // Joystick uses the singleton session; per-bot sending is not supported there.
  const usesBots = state.multiBotEnabled && state.platform !== "joystick" && !useBaseIdentity;
  const availableBots = state.bots.filter((bot) =>
    bot.active && bot.session && bot.platform === state.platform,
  );
  const sentBot = usesBots
    ? (botId
      ? availableBots.find((bot) => bot.id === botId)
      : availableBots.find((bot) => bot.id === state.manualSendBotId) ?? availableBots[0])
    : undefined;
  if (usesBots && !sentBot) {
    throw new Error("Choose an active, signed-in bot for this platform before sending.");
  }

  // Covers double clicks and overlapping keyboard/card sends until delivery resolves.
  const pendingKey = JSON.stringify([scope.revision, state.platform, normalizeSessionChannel(destination), sentBot?.id, text, dryRun]);
  if (pendingSends.has(pendingKey)) throw new Error("This message is already being sent.");
  pendingSends.add(pendingKey);
  try {
    // Dry run: skip the platform send entirely. Record the message locally so
    // it appears in the chat log, but never post to the live channel.
    if (!dryRun) {
      await getPlatformSendFn(state.platform, sentBot?.id)(destination, text);
    }
    // Delivery may finish after navigation or an identity change. It cannot be
    // undone, but its old history must never be written into the new session.
    const current = useAppStore.getState();
    const currentBot = sentBot && current.bots.find((bot) => bot.id === sentBot.id);
    if (!isSessionScopeCurrent(scope) || current.multiBotEnabled !== state.multiBotEnabled ||
      (sentBot && (!currentBot?.active || currentBot.platform !== sentBot.platform ||
        currentBot.session?.username !== sentBot.session?.username ||
        currentBot.session?.userId !== sentBot.session?.userId))) return;
    const timestamp = Date.now();
    if (source !== "autoforge" && !dryRun) state.setLastManualSendMs(timestamp);
    const event = {
      timestamp,
      type: "action_sent" as const,
      severity: "high" as const,
      summary: `${dryRun ? "[DRY RUN] " : ""}${source === "autoforge" ? "AutoForge send" : source === "smart_reply" ? "Smart reply" : "Manual send"}${sentBot ? ` as @${sentBot.session?.username}` : ""}: "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`,
      details: { source, message: text, channel: destination, dryRun, ...(sentBot ? { botId: sentBot.id } : {}) },
    };
    const sentMessage = { message: text, channel: destination, timestamp, source: source === "autoforge" ? "autoforge" as const : "manual" as const, ...(dryRun ? { dryRun: true } : {}) };
    if (sentBot) {
      state.addBotSentMessage(sentBot.id, { ...sentMessage, botId: sentBot.id });
      if (!dryRun) {
        state.incrementBotStat(sentBot.id, "messagesSent");
        state.incrementBotStat(sentBot.id, source === "autoforge" ? "autoForgeActions" : "manualActions");
      }
      state.addBotAutoForgeEvent(sentBot.id, event);
    } else {
      state.addSentMessage(sentMessage);
      if (!dryRun) {
        state.incrementMessagesSent();
        state.incrementStat(source === "autoforge" ? "autoForgeActions" : "manualActions");
      }
      state.addAutoForgeEvent(event);
    }
    // Onboarding milestone: first successful send (not dry-run). Derived from
    // actual send success, not button click — if the platform rejects, auth
    // is expired, or the request fails, the throw above prevents this.
    if (!current.hasSentMessage && !dryRun) {
      state.setHasSentMessage(true);
    }
  } finally {
    pendingSends.delete(pendingKey);
  }
}
