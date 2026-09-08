import type { Platform } from "./kick";
import { sendTwitchMessage } from "./twitch";
import { sendKickMessage } from "./kick";
import { sendJoystickMessage } from "./joystick";

export type PlatformSendFn = (channel: string, message: string) => Promise<void>;

export function getPlatformSendFn(platform: Platform): PlatformSendFn {
  if (platform === "joystick") {
    return (ch, msg) => sendJoystickMessage(ch, msg, window.__joystickChatClient || null);
  }
  if (platform === "kick") return sendKickMessage;
  return sendTwitchMessage;
}
