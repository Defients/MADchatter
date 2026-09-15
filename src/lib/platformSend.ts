import type { Platform } from "./kick";
import { sendTwitchMessage, sendTwitchMessageAsBot, getTwitchSession } from "./twitch";
import { sendKickMessage, sendKickMessageAsBot, getKickSession } from "./kick";
import { sendJoystickMessage, getJoystickSession } from "./joystick";

import { useAppStore } from "../store";
import { captureSessionScope, isSessionScopeCurrent } from "./sessionScope";
import { throwIfSendCancelled } from "./sendCancellation";

export type PlatformSendFn = (channel: string, message: string, signal?: AbortSignal) => Promise<void>;

/**
 * Returns a send function for the given platform.
 *
 * When `botId` is omitted (legacy single-bot mode), the returned function uses
 * the singleton send managers — identical to the original behavior.
 *
 * When `botId` is provided (multi-bot mode), the returned function sends as
 * that specific bot identity via its own per-bot send manager + rate limiter.
 * Joystick ignores `botId` (single-bot for v1).
 */
export function getPlatformSendFn(platform: Platform, botId?: string): PlatformSendFn {
  return async (channel, message, signal) => {
    const scope = captureSessionScope();
    const initial = useAppStore.getState();
    const controller = new AbortController();
    const identity = () => {
      if (botId && platform !== "joystick") {
        const bot = useAppStore.getState().bots.find(b => b.id === botId);
        return bot?.active && bot.platform === platform ? bot.session : null;
      }
      if (platform === "joystick") {
        const session = getJoystickSession();
        return session ? { username: session.username, userId: session.channelId } : null;
      }
      return platform === "kick" ? getKickSession() : getTwitchSession();
    };
    const originalIdentity = identity();
    if (botId && platform !== "joystick" && !originalIdentity) controller.abort();
    const check = () => {
      const current = identity();
      if (!isSessionScopeCurrent(scope) || platform !== scope.platform ||
        useAppStore.getState().multiBotEnabled !== initial.multiBotEnabled ||
        current?.username !== originalIdentity?.username || current?.userId !== originalIdentity?.userId) controller.abort();
    };
    const cancel = () => controller.abort();
    const unsubscribe = useAppStore.subscribe(check);
    window.addEventListener("storage", check);
    window.addEventListener("send-identity-changed", check);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      check();
      throwIfSendCancelled(controller.signal);
      if (platform === "joystick") {
        await sendJoystickMessage(channel, message, window.__joystickChatClient || null, controller.signal);
      } else if (platform === "kick") {
        if (botId) await sendKickMessageAsBot(botId, channel, message, controller.signal);
        else await sendKickMessage(channel, message, controller.signal);
      } else {
        if (botId) await sendTwitchMessageAsBot(botId, channel, message, controller.signal);
        else await sendTwitchMessage(channel, message, controller.signal);
      }
    } finally {
      unsubscribe();
      window.removeEventListener("storage", check);
      window.removeEventListener("send-identity-changed", check);
      signal?.removeEventListener("abort", cancel);
    }
  };
}
