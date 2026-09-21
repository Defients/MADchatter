export type MobilePlatform = "twitch" | "kick";

export interface MobilePlatformPresentation {
  platform: MobilePlatform;
  label: "Twitch" | "Kick";
  iconClass: string;
  loginClass: string;
  showVideoClass: string;
  hideVideoClass: string;
  setButtonClass: string;
  activeSelectorClass: string;
  borderGlowClass: string;
}

const PRESENTATION: Record<MobilePlatform, MobilePlatformPresentation> = {
  twitch: {
    platform: "twitch",
    label: "Twitch",
    iconClass: "text-[#a970ff]",
    loginClass: "bg-[#9146FF] hover:bg-[#772ce8] text-white",
    showVideoClass: "text-purple-100 bg-[#9146FF]/30 border-[#a970ff]/50 hover:bg-[#9146FF]/40",
    hideVideoClass: "text-purple-200 bg-black/35 border-[#9146FF]/25 hover:bg-black/50",
    setButtonClass: "text-purple-100 bg-[#9146FF]/20 border-[#a970ff]/40 hover:bg-[#9146FF]/30",
    activeSelectorClass: "bg-[#9146FF]/20 border-[#a970ff]/55 text-purple-100",
    borderGlowClass: "border-[#9146FF]/30 shadow-[0_0_12px_rgba(145,70,255,0.12)]",
  },
  kick: {
    platform: "kick",
    label: "Kick",
    iconClass: "text-[#53fc18]",
    loginClass: "bg-[#53fc18] hover:bg-[#44d014] text-black",
    showVideoClass: "text-[#dfffd3] bg-[#53fc18]/20 border-[#53fc18]/50 hover:bg-[#53fc18]/30",
    hideVideoClass: "text-[#bafca3] bg-black/35 border-[#53fc18]/25 hover:bg-black/50",
    setButtonClass: "text-[#dfffd3] bg-[#53fc18]/15 border-[#53fc18]/40 hover:bg-[#53fc18]/25",
    activeSelectorClass: "bg-[#53fc18]/15 border-[#53fc18]/55 text-[#dfffd3]",
    borderGlowClass: "border-[#53fc18]/25 shadow-[0_0_12px_rgba(83,252,24,0.10)]",
  },
};

export function coerceMobilePlatform(platform: string): MobilePlatform {
  return platform === "kick" ? "kick" : "twitch";
}

export function normalizePersistedMobilePlatform(input: {
  platform: string;
  twitchAuthenticated: boolean;
  kickAuthenticated: boolean;
}): MobilePlatform {
  if (input.platform === "twitch" || input.platform === "kick") return input.platform;
  if (input.twitchAuthenticated) return "twitch";
  if (input.kickAuthenticated) return "kick";
  return "twitch";
}

export function getMobilePlatformPresentation(platform: string): MobilePlatformPresentation {
  return PRESENTATION[coerceMobilePlatform(platform)];
}
