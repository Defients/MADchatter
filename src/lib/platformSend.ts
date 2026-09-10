import type { Platform } from "./kick";
import { sendTwitchMessage, sendTwitchMessageAsBot } from "./twitch";
import { sendKickMessage, sendKickMessageAsBot } from "./kick";
import { sendJoystickMessage } from "./joystick";

export type PlatformSendFn = (channel: string, message: string) => Promise<void>;

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
  if (platform === "joystick") {
    return (ch, msg) => sendJoystickMessage(ch, msg, window.__joystickChatClient || null);
  }
  if (platform === "kick") {
    return botId ? (ch, msg) => sendKickMessageAsBot(botId, ch, msg) : sendKickMessage;
  }
  return botId ? (ch, msg) => sendTwitchMessageAsBot(botId, ch, msg) : sendTwitchMessage;
}
