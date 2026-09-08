import type { JoystickChatClient, JoystickSession } from "./lib/joystick";
import type { KickSession } from "./lib/kick";
import type { TwitchSession } from "./lib/twitch";

declare global {
  interface Window {
    __joystickChatClient: JoystickChatClient | null;
    __joystickSession?: JoystickSession;
    __kickSession?: KickSession;
    __twitchSession?: TwitchSession;
    __voiceCommands?: {
      voiceCommandsActive: boolean;
      voiceCommandsListening: boolean;
      voiceCommandsNeedsDownload: boolean;
      lastHeardCommand: string | null;
      startVoiceCommands: () => Promise<boolean>;
      stopVoiceCommands: () => void;
      confirmVoiceCommandsDownload: () => void;
      cancelVoiceCommandsDownload: () => void;
    };
  }
}

export {};
