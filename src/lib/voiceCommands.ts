export interface VoiceCommand {
  patterns: string[];
  description: string;
  action: () => void | Promise<void>;
}

export interface VoiceCommandMatch {
  command: VoiceCommand;
  transcript: string;
}

export interface VoiceCommandRef {
  trigger: string;
  description: string;
  category: string;
}

export const VOICE_COMMAND_REFERENCE: VoiceCommandRef[] = [
  { trigger: "forge", description: "Generate chat variants", category: "Forge" },
  { trigger: "forge and send", description: "Forge + auto-send best variant", category: "Forge" },
  { trigger: "enable autoforge", description: "Enable autonomous mode", category: "AutoForge" },
  { trigger: "disable autoforge", description: "Disable autonomous mode", category: "AutoForge" },
  { trigger: "start capture", description: "Start visual/audio screen capture", category: "Capture" },
  { trigger: "stop capture", description: "Stop screen capture", category: "Capture" },
  { trigger: "microphone", description: "Start/stop mic audio capture", category: "Capture" },
  { trigger: "snapshot", description: "Take a manual visual snapshot", category: "Capture" },
  { trigger: "enable memory", description: "Enable auto-memory system", category: "Memory" },
  { trigger: "disable memory", description: "Disable auto-memory system", category: "Memory" },
  { trigger: "open memory panel", description: "Open the Memory Panel", category: "Memory" },
  { trigger: "close memory panel", description: "Close the Memory Panel", category: "Memory" },
  { trigger: "enable real mode", description: "Enable R34L typing style", category: "R34L" },
  { trigger: "disable real mode", description: "Disable R34L typing style", category: "R34L" },
  { trigger: "enable voice", description: "Enable text-to-speech", category: "Audio" },
  { trigger: "disable voice", description: "Disable text-to-speech", category: "Audio" },
  { trigger: "enable sound", description: "Enable message sound", category: "Audio" },
  { trigger: "disable sound", description: "Disable message sound", category: "Audio" },
  { trigger: "enable sfx", description: "Enable UI sound effects", category: "Audio" },
  { trigger: "disable sfx", description: "Disable UI sound effects", category: "Audio" },
  { trigger: "stop speaking", description: "Stop TTS playback immediately", category: "Audio" },
  { trigger: "clear variants", description: "Clear all forge variants", category: "Clear" },
  { trigger: "clear chat", description: "Clear the chat log", category: "Clear" },
  { trigger: "clear audio", description: "Clear audio transcript", category: "Clear" },
  { trigger: "clear all", description: "Clear all context (full reset)", category: "Clear" },
  { trigger: "open hud", description: "Open AutoForge HUD", category: "UI" },
  { trigger: "close hud", description: "Close AutoForge HUD", category: "UI" },
  { trigger: "open settings", description: "Open system configuration", category: "UI" },
  { trigger: "max humor", description: "Set humor to maximum", category: "Tuning" },
  { trigger: "zero humor", description: "Set humor to zero", category: "Tuning" },
  { trigger: "max chaos", description: "Set chaos to maximum", category: "Tuning" },
  { trigger: "zero chaos", description: "Set chaos to zero", category: "Tuning" },
  { trigger: "voice commands", description: "Log all commands to console", category: "Help" },
];

export function parseVoiceCommand(transcript: string, commands: VoiceCommand[]): VoiceCommandMatch | null {
  const normalized = transcript.toLowerCase().trim().replace(/[.,!?]/g, "");
  if (!normalized) return null;

  for (const cmd of commands) {
    for (const pattern of cmd.patterns) {
      const p = pattern.toLowerCase().trim();
      if (normalized === p || normalized.startsWith(p + " ") || normalized.includes(p)) {
        return { command: cmd, transcript };
      }
    }
  }
  return null;
}

export function buildDefaultVoiceCommands(getStore: () => any): VoiceCommand[] {
  const commands: VoiceCommand[] = [];

  // Forge commands
  commands.push({
    patterns: ["forge", "generate", "make variants", "create variants", "forge variants"],
    description: "Trigger a Forge cycle to generate chat variants",
    action: () => {
      window.dispatchEvent(new CustomEvent("forge-trigger", { detail: { autoSend: false } }));
    },
  });

  commands.push({
    patterns: ["forge and send", "forge auto send", "auto forge", "forge send"],
    description: "Forge variants and auto-send the best one",
    action: () => {
      window.dispatchEvent(new CustomEvent("forge-trigger", { detail: { autoSend: true } }));
    },
  });

  // AutoForge toggle
  commands.push({
    patterns: ["enable autoforge", "turn on autoforge", "autoforge on", "start autoforge"],
    description: "Enable AutoForge autonomous mode",
    action: () => {
      const s = getStore();
      if (!s.autoForgeEnabled) {
        s.setAutoForgeEnabled(true);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "AutoForge enabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["disable autoforge", "turn off autoforge", "autoforge off", "stop autoforge"],
    description: "Disable AutoForge autonomous mode",
    action: () => {
      const s = getStore();
      if (s.autoForgeEnabled) {
        s.setAutoForgeEnabled(false);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "AutoForge disabled", type: "success" } }));
      }
    },
  });

  // Capture commands
  commands.push({
    patterns: ["start capture", "capture window", "capture screen", "begin capture"],
    description: "Start visual/audio capture",
    action: () => {
      window.dispatchEvent(new CustomEvent("capture-trigger"));
    },
  });

  commands.push({
    patterns: ["stop capture", "end capture", "stop screen share"],
    description: "Stop visual/audio capture",
    action: () => {
      window.dispatchEvent(new CustomEvent("capture-trigger"));
    },
  });

  commands.push({
    patterns: ["microphone", "start microphone", "mic capture", "start mic"],
    description: "Start microphone audio capture",
    action: () => {
      window.dispatchEvent(new CustomEvent("mic-capture-trigger"));
    },
  });

  commands.push({
    patterns: ["snapshot", "take snapshot", "capture snapshot", "manual snapshot"],
    description: "Take a manual visual snapshot",
    action: () => {
      window.dispatchEvent(new CustomEvent("manual-snapshot-trigger"));
    },
  });

  // Auto-memory toggle
  commands.push({
    patterns: ["enable memory", "turn on memory", "memory on", "start memory", "enable auto memory"],
    description: "Enable auto-memory system",
    action: () => {
      const s = getStore();
      if (!s.autoMemoryConfig?.enabled) {
        s.updateAutoMemoryConfig({ enabled: true });
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Auto-Memory enabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["disable memory", "turn off memory", "memory off", "stop memory", "disable auto memory"],
    description: "Disable auto-memory system",
    action: () => {
      const s = getStore();
      if (s.autoMemoryConfig?.enabled) {
        s.updateAutoMemoryConfig({ enabled: false });
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Auto-Memory disabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["open memory panel", "show memory", "memory panel", "view memories"],
    description: "Open the Memory Panel",
    action: () => {
      getStore().setMemoryPanelOpen(true);
    },
  });

  commands.push({
    patterns: ["close memory panel", "hide memory", "close memory"],
    description: "Close the Memory Panel",
    action: () => {
      getStore().setMemoryPanelOpen(false);
    },
  });

  // R34L mode toggle
  commands.push({
    patterns: ["enable real mode", "turn on real mode", "real mode on", "r34l on", "enable r34l"],
    description: "Enable R34L typing style",
    action: () => {
      const s = getStore();
      if (!s.r34lEnabled) {
        s.setR34lEnabled(true);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "R34L mode enabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["disable real mode", "turn off real mode", "real mode off", "r34l off", "disable r34l"],
    description: "Disable R34L typing style",
    action: () => {
      const s = getStore();
      if (s.r34lEnabled) {
        s.setR34lEnabled(false);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "R34L mode disabled", type: "success" } }));
      }
    },
  });

  // TTS toggle
  commands.push({
    patterns: ["enable voice", "turn on voice", "voice on", "enable tts", "tts on"],
    description: "Enable text-to-speech",
    action: () => {
      const s = getStore();
      if (!s.ttsEnabled) {
        s.setTtsEnabled(true);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Voice TTS enabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["disable voice", "turn off voice", "voice off", "disable tts", "tts off", "stop voice"],
    description: "Disable text-to-speech",
    action: () => {
      const s = getStore();
      if (s.ttsEnabled) {
        s.setTtsEnabled(false);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Voice TTS disabled", type: "success" } }));
      }
    },
  });

  // Sound toggle
  commands.push({
    patterns: ["enable sound", "turn on sound", "sound on", "message sound on"],
    description: "Enable message sound",
    action: () => {
      const s = getStore();
      if (!s.messageSoundEnabled) {
        s.setMessageSoundEnabled(true);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Message sound enabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["disable sound", "turn off sound", "sound off", "message sound off"],
    description: "Disable message sound",
    action: () => {
      const s = getStore();
      if (s.messageSoundEnabled) {
        s.setMessageSoundEnabled(false);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Message sound disabled", type: "success" } }));
      }
    },
  });

  // SFX toggle
  commands.push({
    patterns: ["enable sfx", "turn on sfx", "sfx on", "sound effects on"],
    description: "Enable sound effects",
    action: () => {
      const s = getStore();
      if (!s.sfxEnabled) {
        s.setSfxEnabled(true);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "SFX enabled", type: "success" } }));
      }
    },
  });

  commands.push({
    patterns: ["disable sfx", "turn off sfx", "sfx off", "sound effects off"],
    description: "Disable sound effects",
    action: () => {
      const s = getStore();
      if (s.sfxEnabled) {
        s.setSfxEnabled(false);
        window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "SFX disabled", type: "success" } }));
      }
    },
  });

  // Clear variants
  commands.push({
    patterns: ["clear variants", "reset variants", "delete variants"],
    description: "Clear all forge variants",
    action: () => {
      getStore().setVariants([]);
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Variants cleared", type: "success" } }));
    },
  });

  // Clear chat log
  commands.push({
    patterns: ["clear chat", "reset chat", "clear chat log"],
    description: "Clear the chat log",
    action: () => {
      getStore().setChatLog([]);
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Chat log cleared", type: "success" } }));
    },
  });

  // Clear audio transcript
  commands.push({
    patterns: ["clear audio", "reset audio", "clear transcript"],
    description: "Clear the audio transcript",
    action: () => {
      getStore().setAudioTranscript("");
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Audio transcript cleared", type: "success" } }));
    },
  });

  // Clear all context
  commands.push({
    patterns: ["clear all", "reset all", "clear everything", "full reset"],
    description: "Clear all context (chat, audio, variants, visual)",
    action: () => {
      getStore().clearAllContext();
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "All context cleared", type: "success" } }));
    },
  });

  // HUD toggle
  commands.push({
    patterns: ["open hud", "show hud", "autoforge hud", "open autoforge hud"],
    description: "Open AutoForge HUD",
    action: () => {
      getStore().setIsAutoForgeHUDOpen(true);
    },
  });

  commands.push({
    patterns: ["close hud", "hide hud"],
    description: "Close AutoForge HUD",
    action: () => {
      getStore().setIsAutoForgeHUDOpen(false);
    },
  });

  // Settings
  commands.push({
    patterns: ["open settings", "show settings", "open config", "settings panel", "system config"],
    description: "Open system configuration/settings",
    action: () => {
      const button = document.querySelector('[title="System Configuration"]') as HTMLButtonElement;
      if (button) button.click();
    },
  });

  // Humor level
  commands.push({
    patterns: ["max humor", "humor max", "set humor to max", "maximum humor"],
    description: "Set humor level to maximum",
    action: () => {
      getStore().updateConfig({ humorLevel: 100 });
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Humor set to max", type: "success" } }));
    },
  });

  commands.push({
    patterns: ["zero humor", "no humor", "humor off", "set humor to zero"],
    description: "Set humor level to zero",
    action: () => {
      getStore().updateConfig({ humorLevel: 0 });
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Humor set to 0", type: "success" } }));
    },
  });

  // Chaos level
  commands.push({
    patterns: ["max chaos", "chaos max", "set chaos to max", "maximum chaos"],
    description: "Set chaos level to maximum",
    action: () => {
      getStore().updateConfig({ chaosLevel: 100 });
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Chaos set to max", type: "success" } }));
    },
  });

  commands.push({
    patterns: ["zero chaos", "no chaos", "chaos off", "set chaos to zero"],
    description: "Set chaos level to zero",
    action: () => {
      getStore().updateConfig({ chaosLevel: 0 });
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Chaos set to 0", type: "success" } }));
    },
  });

  // Stop speaking
  commands.push({
    patterns: ["stop speaking", "stop talking", "shut up", "quiet", "silence"],
    description: "Stop TTS playback",
    action: () => {
      window.dispatchEvent(new CustomEvent("voice-stop-tts"));
    },
  });

  // Help
  commands.push({
    patterns: ["voice commands", "what commands", "command list", "help commands"],
    description: "Show available voice commands",
    action: () => {
      const list = commands.map((c) => `• "${c.patterns[0]}" — ${c.description}`).join("\n");
      window.dispatchEvent(new CustomEvent("voice-toast", { detail: { msg: "Voice commands available in console", type: "info" } }));
      console.log("[Voice Commands]\n" + list);
    },
  });

  return commands;
}
