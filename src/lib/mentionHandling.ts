import { toast } from "sonner";
import { useAppStore } from "../store";
import type { SmartReplyNotice, SmartReplyThread } from "../types";
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
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function threadKey(event: Pick<MentionEvent, "botId" | "botUsername" | "messageId">): string {
  const botKey = event.botId ? `id:${event.botId}` : `username:${event.botUsername.toLowerCase()}`;
  return `${botKey}:mention:${event.messageId}`;
}

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

function scheduleExpiry(key: string, notice: SmartReplyNotice): void {
  const existing = expiryTimers.get(key);
  if (existing) clearTimeout(existing);
  const duration = notice.state === "ready" ? 60_000 : 9_000;
  const expiryTimer = setTimeout(() => {
    const state = useAppStore.getState();
    const current = state.smartReplyThreads.find((item) => item.key === key);
    if (!current || current.messageId !== notice.messageId) return;
    state.dismissSmartReplyThread(key);
    expiryTimers.delete(key);
  }, duration);
  expiryTimers.set(key, expiryTimer);
}

function acknowledgeMention(event: MentionEvent, alertUser: boolean): void {
  const state = useAppStore.getState();
  state.incrementStat("mentionsDetected");
  if (alertUser) {
    if (state.desktopNotificationsEnabled) notifyMention(event.username, event.text);
    playMentionAlert();
    toast.warning(`@${event.botUsername} was mentioned`, {
      description: `${event.username}: ${event.text.slice(0, 100)}`,
      id: `mention-alert:${event.botUsername.toLowerCase()}`,
      duration: 5000,
    });
  }
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
  // Direct attention is an explicit urgency exception to an ordinary manual
  // Interval deadline. The existing force path still enforces AutoForge's
  // master enable and scheduler/session guards.
  window.dispatchEvent(new CustomEvent("autoforge-force-check", {
    detail: event.botId ? { botId: event.botId, directMention: true } : { directMention: true },
  }));
}

export function resetDirectMentionHandling(): void {
  coordinator.reset();
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
  const state = useAppStore.getState();
  state.setSmartReplies([]);
  state.setSmartRepliesLoading(false);
  state.setSmartReplyNotice(null);
  state.clearSmartReplyThreads();
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
    const key = threadKey(event);
    const botKey = event.botId ? `id:${event.botId}` : `username:${event.botUsername.toLowerCase()}`;
    const upsert = (patch: Partial<SmartReplyThread>, focus = true) => {
      const state = useAppStore.getState();
      const existing = state.smartReplyThreads.find((item) => item.key === key);
      const notice = patch.notice ?? existing?.notice ?? {
        state: "mentioned", messageId: event.messageId, username: event.username,
        botUsername: event.botUsername, text: event.text, receivedAt: event.receivedAt,
      };
      state.upsertSmartReplyThread({
        key, botKey, messageId: event.messageId, botId: event.botId,
        botUsername: event.botUsername, receivedAt: event.receivedAt,
        loading: patch.loading ?? existing?.loading ?? false,
        replies: patch.replies ?? existing?.replies ?? [], notice,
      }, focus);
    };
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
      setReplies: (replies) => upsert({ replies }, true),
      setLoading: (loading) => {
        // A superseded/disabled request dismisses its thread before its
        // finally callback. Never resurrect that retired thread merely to
        // project loading=false.
        if (!loading && !useAppStore.getState().smartReplyThreads.some((item) => item.key === key)) return;
        upsert({ loading }, loading);
      },
      setNotice: (notice) => {
        if (!notice) {
          useAppStore.getState().dismissSmartReplyThread(key);
          return;
        }
        upsert({ notice, loading: notice.state === "loading" }, true);
        if (notice.state !== "loading" && notice.state !== "mentioned") scheduleExpiry(key, notice);
      },
    });
  }
}
