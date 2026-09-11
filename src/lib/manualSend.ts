import { useAppStore } from "../store";
import { getPlatformSendFn } from "./platformSend";

type ManualSendSource = "manual" | "smart_reply" | "autoforge";

const pendingSends = new Set<string>();

/** One identity and accounting path for direct chat, variants, and shortcuts. */
export async function sendManualMessage({
  message,
  channel,
  botId,
  source = "manual",
}: {
  message: string;
  channel: string;
  botId?: string;
  source?: ManualSendSource;
}): Promise<void> {
  const state = useAppStore.getState();
  const text = message.trim();
  const destination = channel.trim();
  if (!text) throw new Error("Write a message before sending.");
  if (!destination) throw new Error("Set a channel before sending.");

  // Joystick uses the singleton session; per-bot sending is not supported there.
  const usesBots = state.multiBotEnabled && state.platform !== "joystick";
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
  const pendingKey = JSON.stringify([state.platform, destination, sentBot?.id, text]);
  if (pendingSends.has(pendingKey)) throw new Error("This message is already being sent.");
  pendingSends.add(pendingKey);
  try {
    await getPlatformSendFn(state.platform, sentBot?.id)(destination, text);
    const timestamp = Date.now();
    if (source !== "autoforge") state.setLastManualSendMs(timestamp);
    const event = {
      timestamp,
      type: "action_sent" as const,
      severity: "high" as const,
      summary: `${source === "autoforge" ? "AutoForge send" : source === "smart_reply" ? "Smart reply" : "Manual send"}${sentBot ? ` as @${sentBot.session?.username}` : ""}: "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`,
      details: { source, message: text, channel: destination, ...(sentBot ? { botId: sentBot.id } : {}) },
    };
    const sentMessage = { message: text, channel: destination, timestamp, source: source === "autoforge" ? "autoforge" as const : "manual" as const };
    if (sentBot) {
      state.addBotSentMessage(sentBot.id, { ...sentMessage, botId: sentBot.id });
      state.incrementBotStat(sentBot.id, "messagesSent");
      state.incrementBotStat(sentBot.id, source === "autoforge" ? "autoForgeActions" : "manualActions");
      state.addBotAutoForgeEvent(sentBot.id, event);
    } else {
      state.addSentMessage(sentMessage);
      state.incrementMessagesSent();
      state.incrementStat(source === "autoforge" ? "autoForgeActions" : "manualActions");
      state.addAutoForgeEvent(event);
    }
  } finally {
    pendingSends.delete(pendingKey);
  }
}
