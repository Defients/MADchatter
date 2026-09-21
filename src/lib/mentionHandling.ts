import { toast } from "sonner";
import { useAppStore } from "../store";
import type { SmartReplyNotice } from "../types";
import { playMentionAlert } from "./attentionAudio";
import {
  classifyDirectMentionEvents,
  DirectMentionCoordinator,
  type MentionEvent,
  type MentionTarget,
} from "./directMention";
import { generateSmartReplies } from "./smartReplies";
import { notifyMention } from "./notifications";
import { getTwitchSession } from "./twitch";
import { getKickSession } from "./kick";
import { getJoystickBotUsername } from "./joystick";
import { normalizeSessionChannel } from "./sessionScope";

const coordinator = new DirectMentionCoordinator();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function currentSessionUsername(platform: string): string | undefined {
  if (platform === "kick") return getKickSession()?.username;
  if (platform === "joystick") return getJoystickBotUsername() || undefined;
  return getTwitchSession()?.username;
}

export function resolveDirectMentionTargets(platform: string): MentionTarget[] {
  const state = useAppStore.getState();
  if (state.multiBotEnabled && platform !== "joystick") {
    return state.bots
      .filter((bot) => bot.active && bot.platform === platform && bot.session?.username)
      .map((bot) => ({ botUsername: bot.session!.username, botId: bot.id }));
  }
  const username = currentSessionUsername(platform);
  return username ? [{ botUsername: username }] : [];
}

function isEventSessionCurrent(event: MentionEvent): boolean {
  const state = useAppStore.getState();
  return state.sessionRevision === event.sessionRevision &&
    state.platform === event.platform &&
    normalizeSessionChannel(state.streamMetadata.channelName) === normalizeSessionChannel(event.channel);
}

function scheduleExpiry(notice: SmartReplyNotice): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  const duration = notice.state === "ready" ? 60_000 : 9_000;
  expiryTimer = setTimeout(() => {
    const state = useAppStore.getState();
    const current = state.smartReplyNotice;
    if (!current || current.messageId !== notice.messageId || current.botUsername !== notice.botUsername) return;
    state.setSmartReplies([]);
    state.setSmartReplyNotice(null);
    state.setSmartRepliesLoading(false);
  }, duration);
}

function acknowledgeMention(event: MentionEvent): void {
  const state = useAppStore.getState();
  state.incrementStat("mentionsDetected");
  if (state.desktopNotificationsEnabled) notifyMention(event.username, event.text);
  playMentionAlert();
  toast.warning(`@${event.botUsername} was mentioned`, {
    description: `${event.username}: ${event.text.slice(0, 100)}`,
    id: `mention-alert:${event.botUsername.toLowerCase()}:${event.messageId}`,
    duration: 5000,
  });
  window.dispatchEvent(new CustomEvent("bot-mentioned", {
    detail: {
      lines: [`${event.username}: ${event.text}`],
      timestamp: event.receivedAt,
      channel: event.channel,
      messageId: event.messageId,
      botUsername: event.botUsername,
    },
  }));
  const logEvent = {
    timestamp: event.receivedAt,
    type: "mention" as const,
    severity: "high" as const,
    summary: `Direct mention of @${event.botUsername} by ${event.username}: ${event.text.slice(0, 120)}`,
    details: {
      messageId: event.messageId,
      botUsername: event.botUsername,
      botId: event.botId,
      evidence: event.evidence,
    },
  };
  if (event.botId) state.addBotAutoForgeEvent(event.botId, logEvent);
  else state.addAutoForgeEvent(logEvent);
}

export function resetDirectMentionHandling(): void {
  coordinator.reset();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const state = useAppStore.getState();
  state.setSmartReplies([]);
  state.setSmartRepliesLoading(false);
  state.setSmartReplyNotice(null);
}

/**
 * Canonical non-blocking incoming-chat entrypoint. Recognition and attention
 * feedback are synchronous; provider generation continues independently.
 */
export function handleIncomingDirectMentions(input: {
  messageId: string;
  username: string;
  text: string;
  receivedAt: number;
  channel: string;
  platform: string;
  sessionRevision: number;
  replyTargetUsername?: string | null;
}): void {
  const events = classifyDirectMentionEvents({
    ...input,
    targets: resolveDirectMentionTargets(input.platform),
  });
  for (const event of events) {
    void coordinator.handle(event, {
      now: Date.now,
      acknowledge: acknowledgeMention,
      smartRepliesEnabled: () => useAppStore.getState().smartRepliesEnabled,
      generate: (mention, signal) => generateSmartReplies(
        [`${mention.username}: ${mention.text}`],
        {
          botId: mention.botId,
          mentionMessageId: mention.messageId,
          mentionedUsername: mention.username,
          botUsername: mention.botUsername,
          signal,
        },
      ),
      isSessionCurrent: isEventSessionCurrent,
      setReplies: (replies) => useAppStore.getState().setSmartReplies(replies),
      setLoading: (loading) => useAppStore.getState().setSmartRepliesLoading(loading),
      setNotice: (notice) => {
        useAppStore.getState().setSmartReplyNotice(notice);
        if (notice && notice.state !== "loading" && notice.state !== "mentioned") scheduleExpiry(notice);
      },
    });
  }
}
