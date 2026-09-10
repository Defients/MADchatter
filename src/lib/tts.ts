import { useAppStore } from "../store";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TTSProvider = "web" | "elevenlabs";

export interface ElevenLabsVoicePreset {
  id: string;
  name: string;
  desc: string;
}

export interface ElevenLabsUserVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

// ─── ElevenLabs Voice Presets ────────────────────────────────────────────────

export const ELEVENLABS_VOICES: ElevenLabsVoicePreset[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel",     desc: "Female · American · Calm, conversational" },
  { id: "AZnzlk1XvdvUeBnXldC1", name: "Domi",       desc: "Female · American · Strong, confident" },
  { id: "ErXwobaYiN019PkyCvjx", name: "Antoni",     desc: "Male · American · Smooth, warm" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella",      desc: "Female · American · Soft, friendly" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh",       desc: "Male · American · Deep, narrative" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold",     desc: "Male · American · Deep, commanding" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam",       desc: "Male · American · Gravelly, mature" },
  { id: "yoZ06aMxZJJ28mC3DTQ4", name: "Sam",        desc: "Male · American · Raspy, energetic" },
  { id: "pFZP5JQGTRi55CqYF4IB", name: "Gigi",       desc: "Female · American · Young, lively" },
  { id: "N2lRS1M4TclokeyFqDyP", name: "Gordon",     desc: "Male · American · Gruff, authoritative" },
  { id: "CYw3kZ02d5n1UhXcX9f8", name: "Freya",      desc: "Female · American · Expressive, warm" },
  { id: "XBzWfohLFCbzjxAf7bk2", name: "Charlotte",  desc: "Female · American · Mature, confident" },
  { id: "iP95p4xoKVk53Go1jGh5", name: "Matthew",    desc: "Male · American · Clear, professional" },
];

// ─── Fetch User Voices from ElevenLabs ──────────────────────────────────────

export async function fetchElevenLabsVoices(apiKey: string): Promise<ElevenLabsUserVoice[]> {
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    method: "GET",
    headers: {
      "xi-api-key": apiKey,
      "Accept": "application/json",
    },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Invalid ElevenLabs API key");
    if (response.status === 429) throw new Error("ElevenLabs rate limit exceeded");
    throw new Error(`ElevenLabs API error ${response.status}`);
  }
  const data = await response.json();
  return (data.voices || []) as ElevenLabsUserVoice[];
}

// ─── Emote & Emoji Stripping ─────────────────────────────────────────────────

const COMMON_EMOTES = new Set([
  // Twitch globals
  "Kappa", "KappaPride", "KappaClaus", "KappaRoss", "Kreygasm", "EleGiggle",
  "PogChamp", "Poggers", "Pog", "KEKW", "LULW", "LUL", "OMEGALUL", "OmegaLUL",
  "monkaS", "monkaW", "monkaGIGA", "Pepega", "PepeHands", "PepeLa", "PepePls",
  "PepeSpooks", "5Head", "4Head", "EZ", "EZClap", "FeelsBadMan", "FeelsGoodMan",
  "FeelsWeirdMan", "FeelsDankMan", "FeelsOkayMan", "PJSalt", "ResidentSleeper",
  "BibleThump", "BabyRage", "WutFace", "NotLikeThis", "FailFish", "DansGame",
  "SwiftRage", "Keepo", "Jebaited", "TriHard", "CoolCat", "FrankerZ", "HeyGuys",
  "SeemsGood", "PartyTime", "BlessRNG", "BloodTrail", "BrainSlug", "BrokeBack",
  "CougarHunt", "DAESuppy", "DancingBanana", "DoritosChip", "DoubleRainbow",
  "EagleEye", "EarthDay", "EnchantedKnight", "Error404", "FootGoal", "FunRun",
  "GivePLZ", "GoldenKappa", "HumbleLife", "ImTyping", "ItsBacon", "JKanStyle",
  "JonCarnage", "KAPOW", "KevinTurtle", "Kippa", "MikeHogu", "MingLee", "MVGame",
  "NinjaTroll", "NoNoSpot", "NotATK", "OpieOP", "OptimizePrime", "OSFrog",
  "PanicVis", "Pazzerz", "PeoplesChamp", "PermaSmug", "PicoMound", "PipeHype",
  "PoooM", "PrChase", "PrimeMe", "PunchTrees", "RaccAttack", "RalpherZ",
  "RedCoat", "RitzMitz", "RuleFive", "ShadyLulu", "ShazBostix", "ShibeZ",
  "SMOrc", "SoBayed", "SoonerLater", "SriHead", "SSSsss", "StoneLightning",
  "StrawBeary", "SuperVinlin", "TF2John", "TheMeta", "TheRinger", "TheTarFu",
  "TheThing", "ThunBeast", "TinyFace", "TombRaid", "TwitchRaid", "TwitchUnity",
  "UleetBackup", "UncleNox", "UnSane", "Vinestone", "VolcanHug", "WholeWheat",
  "WTRuckus", "YouDontSay", "AlienPls", "CrateNotFound", "CurseLit",
  // BTTV / FFZ popular
  "Copium", "Hopium", "SillyGas", "WidePeepoHappy", "WidePeepoSad",
  "PeepoHappy", "PeepoSad", "PeepoGiggle", "PeepoClap", "PeepoHey",
  "PeepoShy", "PeepoWeird", "catJAM", "catCRY", "catKISS", "catSALUTE",
  "catPat", "catComfy", "PepegaBox", "FeelingKachow", "FeelingKneemo",
  "FeelingLewd", "FeelingPopular", "FeelingScared", "FeelingTouch",
  "PauseChamp", "WeirdChamp", "WeirdChamping", "ChadChamp",
  "ChadBoard", "YesBut", "NoBut", "ModCheck", "PogChampCool",
  "WICKED", "xqcL", "xqcCheat", "xqcDab", "xqcPaint", "xqcSlap", "xqcSpin",
  "xqcLove", "xqcREE", "xqcRage", "xqcSmash", "xqcClap", "xqcDance",
  "xqcFall", "xqcFeet", "xqcFrog", "xqcGiggle", "xqcGrin", "xqcHands",
  "xqcHi", "xqcJump", "xqcKiss", "xqcLick", "xqcMad", "xqcNod", "xqcO",
  "xqcPew", "xqcPog", "xqcRip", "xqcSad", "xqcScared", "xqcShrug",
  "xqcSleep", "xqcSmile", "xqcSpit", "xqcStare", "xqcSwag", "xqcT",
  "xqcThink", "xqcVibing", "xqcWah", "xqcWink", "xqcYawn", "xqcZ",
  // Kick / Joystick common
  "SugarPepo", "SugarPepoHappy", "SugarPepoSad", "BossCheese", "BossCheese2",
  "BossCheese3", "BossCheese4", "BossCheese5", "BossCheese6", "BossCheese7",
  "BossCheese8", "BossCheese9", "BossCheese10",
]);

// Emoji unicode ranges (comprehensive coverage)
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{1F018}-\u{1F270}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}-\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}-\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

// Markdown formatting
const MARKDOWN_REGEX = /(\*\*|__|~~|`|\*|_)/g;

// URLs
const URL_REGEX = /https?:\/\/\S+/gi;

// Mentions (@username)
const MENTION_REGEX = /@\w+/g;

function stripEmotesAndEmoji(text: string): string {
  let result = text;

  // Remove URLs
  result = result.replace(URL_REGEX, "");

  // Remove @mentions
  result = result.replace(MENTION_REGEX, "");

  // Remove emoji
  result = result.replace(EMOJI_REGEX, "");

  // Remove known emotes (case-insensitive, whole word)
  const words = result.split(/(\s+)/);
  const filtered = words.map((token) => {
    if (/^\s+$/.test(token)) return token;
    const cleaned = token.replace(/[^\w]/g, "");
    if (cleaned && COMMON_EMOTES.has(cleaned)) return "";
    if (cleaned && COMMON_EMOTES.has(cleaned.toLowerCase())) return "";
    return token;
  });
  result = filtered.join("");

  // Strip markdown formatting
  result = result.replace(MARKDOWN_REGEX, "");

  // Collapse multiple spaces
  result = result.replace(/[ \t]{2,}/g, " ");

  // Remove leading/trailing whitespace
  result = result.trim();

  return result;
}

// ─── Web Speech API ──────────────────────────────────────────────────────────

let cachedVoices: SpeechSynthesisVoice[] = [];

export function getWebSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    cachedVoices = voices;
  }
  return cachedVoices.length > 0 ? cachedVoices : voices;
}

export function onVoicesChanged(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.speechSynthesis) return () => {};
  const handler = () => {
    cachedVoices = window.speechSynthesis.getVoices();
    callback();
  };
  window.speechSynthesis.addEventListener("voiceschanged", handler);
  return () => {
    window.speechSynthesis.removeEventListener("voiceschanged", handler);
  };
}

export function isWebSpeechAvailable(): boolean {
  return typeof window !== "undefined" && !!window.speechSynthesis;
}

function speakWeb(text: string, voiceName: string | null, rate: number, volume: number): void {
  if (!isWebSpeechAvailable()) {
    console.warn("[TTS] Web Speech API not available");
    return;
  }

  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Math.max(0.1, Math.min(4, rate));
  utterance.volume = Math.max(0, Math.min(1, volume));
  utterance.pitch = 1;

  if (voiceName) {
    const voices = getWebSpeechVoices();
    const voice = voices.find((v) => v.name === voiceName);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
  }

  synth.speak(utterance);
}

// ─── ElevenLabs ──────────────────────────────────────────────────────────────

let elevenlabsAudioEl: HTMLAudioElement | null = null;
let elevenlabsCurrentUrl: string | null = null;

function revokeElevenLabsUrl(): void {
  if (elevenlabsCurrentUrl) {
    URL.revokeObjectURL(elevenlabsCurrentUrl);
    elevenlabsCurrentUrl = null;
  }
}

async function speakElevenLabs(
  text: string,
  voiceId: string,
  apiKey: string,
  volume: number,
): Promise<void> {
  // Truncate to ElevenLabs max (5000 chars for most models)
  const truncated = text.length > 4500 ? text.substring(0, 4500) : text;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text: truncated,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Invalid ElevenLabs API key");
    }
    if (response.status === 429) {
      throw new Error("ElevenLabs rate limit exceeded (check your plan quota)");
    }
    throw new Error(`ElevenLabs API error ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const blob = await response.blob();
  // Revoke any previous blob URL before creating a new one to avoid leaks
  revokeElevenLabsUrl();
  const audioUrl = URL.createObjectURL(blob);
  elevenlabsCurrentUrl = audioUrl;

  if (elevenlabsAudioEl) {
    elevenlabsAudioEl.pause();
    elevenlabsAudioEl.src = audioUrl;
  } else {
    elevenlabsAudioEl = new Audio(audioUrl);
  }

  elevenlabsAudioEl.volume = Math.max(0, Math.min(1, volume));

  // Route to TTS-specific audio output device if set (independent from sound effects)
  const state = useAppStore.getState();
  const ttsDeviceId = state.ttsAudioOutputDeviceId;
  if (ttsDeviceId && typeof (elevenlabsAudioEl as any).setSinkId === "function") {
    try {
      await (elevenlabsAudioEl as any).setSinkId(ttsDeviceId);
    } catch (e) {
      console.warn("[TTS] Failed to set TTS audio output sink:", e);
    }
  }

  // Clean up object URL after playback to avoid memory leaks
  elevenlabsAudioEl.addEventListener("ended", () => {
    revokeElevenLabsUrl();
  }, { once: true });

  try {
    await elevenlabsAudioEl.play();
  } catch (e) {
    // If playback fails, revoke the URL immediately so it doesn't leak
    revokeElevenLabsUrl();
    throw e;
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function speakMessage(text: string): Promise<void> {
  const state = useAppStore.getState();
  if (!state.ttsEnabled) return;

  const cleaned = stripEmotesAndEmoji(text);
  if (!cleaned.trim()) return;

  if (state.ttsProvider === "elevenlabs" && state.elevenlabsApiKey && state.ttsVoice) {
    try {
      await speakElevenLabs(cleaned, state.ttsVoice, state.elevenlabsApiKey, state.ttsVolume);
    } catch (e: any) {
      console.error("[TTS] ElevenLabs failed, falling back to Web Speech:", e?.message || e);
      speakWeb(cleaned, state.ttsVoice, state.ttsRate, state.ttsVolume);
    }
  } else {
    speakWeb(cleaned, state.ttsVoice, state.ttsRate, state.ttsVolume);
  }
}

export function stopSpeaking(): void {
  if (isWebSpeechAvailable()) {
    window.speechSynthesis.cancel();
  }
  if (elevenlabsAudioEl) {
    elevenlabsAudioEl.pause();
  }
  // Revoke any pending blob URL since playback is being stopped
  revokeElevenLabsUrl();
}

export async function testVoice(): Promise<void> {
  const sample = "Hey chat, this is a voice test. The co-pilot is online and ready to roll.";
  await speakMessage(sample);
}

// ─── Voice Sorting Helper ────────────────────────────────────────────────────

export function sortVoicesByQuality(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return [...voices].sort((a, b) => {
    const aNatural = /natural|online|neural|premium|enhanced/i.test(a.name) ? 0 : 1;
    const bNatural = /natural|online|neural|premium|enhanced/i.test(b.name) ? 0 : 1;
    if (aNatural !== bNatural) return aNatural - bNatural;
    return a.name.localeCompare(b.name);
  });
}

const LANG_NAMES: Record<string, string> = {
  "en-US": "English (United States)",
  "en-GB": "English (United Kingdom)",
  "en-AU": "English (Australia)",
  "en-CA": "English (Canada)",
  "en-IE": "English (Ireland)",
  "en-IN": "English (India)",
  "en-ZA": "English (South Africa)",
  "en-NZ": "English (New Zealand)",
  "es-ES": "Spanish (Spain)",
  "es-MX": "Spanish (Mexico)",
  "es-US": "Spanish (United States)",
  "es-AR": "Spanish (Argentina)",
  "es-CO": "Spanish (Colombia)",
  "fr-FR": "French (France)",
  "fr-CA": "French (Canada)",
  "de-DE": "German (Germany)",
  "de-AT": "German (Austria)",
  "it-IT": "Italian (Italy)",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "nl-NL": "Dutch (Netherlands)",
  "nl-BE": "Dutch (Belgium)",
  "ru-RU": "Russian (Russia)",
  "pl-PL": "Polish (Poland)",
  "sv-SE": "Swedish (Sweden)",
  "da-DK": "Danish (Denmark)",
  "fi-FI": "Finnish (Finland)",
  "no-NO": "Norwegian (Norway)",
  "cs-CZ": "Czech (Czech Republic)",
  "el-GR": "Greek (Greece)",
  "tr-TR": "Turkish (Turkey)",
  "hu-HU": "Hungarian (Hungary)",
  "ro-RO": "Romanian (Romania)",
  "bg-BG": "Bulgarian (Bulgaria)",
  "uk-UA": "Ukrainian (Ukraine)",
  "hr-HR": "Croatian (Croatia)",
  "sk-SK": "Slovak (Slovakia)",
  "sl-SI": "Slovenian (Slovenia)",
  "et-EE": "Estonian (Estonia)",
  "lv-LV": "Latvian (Latvia)",
  "lt-LT": "Lithuanian (Lithuania)",
  "ja-JP": "Japanese (Japan)",
  "ko-KR": "Korean (Korea)",
  "zh-CN": "Chinese (Simplified, China)",
  "zh-TW": "Chinese (Traditional, Taiwan)",
  "zh-HK": "Chinese (Hong Kong)",
  "hi-IN": "Hindi (India)",
  "th-TH": "Thai (Thailand)",
  "vi-VN": "Vietnamese (Vietnam)",
  "id-ID": "Indonesian (Indonesia)",
  "ms-MY": "Malay (Malaysia)",
  "fil-PH": "Filipino (Philippines)",
  "ar-SA": "Arabic (Saudi Arabia)",
  "ar-EG": "Arabic (Egypt)",
  "he-IL": "Hebrew (Israel)",
  "fa-IR": "Persian (Iran)",
  "bn-IN": "Bengali (India)",
  "bn-BD": "Bengali (Bangladesh)",
  "ta-IN": "Tamil (India)",
  "te-IN": "Telugu (India)",
  "mr-IN": "Marathi (India)",
  "gu-IN": "Gujarati (India)",
  "kn-IN": "Kannada (India)",
  "ml-IN": "Malayalam (India)",
  "pa-IN": "Punjabi (India)",
  "ur-PK": "Urdu (Pakistan)",
  "ur-IN": "Urdu (India)",
};

export function getLanguageName(lang: string): string {
  return LANG_NAMES[lang] || lang;
}

export interface VoiceGroup {
  lang: string;
  label: string;
  voices: SpeechSynthesisVoice[];
}

export function groupVoicesByLanguage(voices: SpeechSynthesisVoice[]): VoiceGroup[] {
  const groups = new Map<string, SpeechSynthesisVoice[]>();

  for (const voice of voices) {
    const lang = voice.lang || "unknown";
    if (!groups.has(lang)) {
      groups.set(lang, []);
    }
    groups.get(lang)!.push(voice);
  }

  const result: VoiceGroup[] = [];
  for (const [lang, groupVoices] of groups) {
    result.push({
      lang,
      label: getLanguageName(lang),
      voices: sortVoicesByQuality(groupVoices),
    });
  }

  // Sort groups: English first, then alphabetical by label
  result.sort((a, b) => {
    const aEn = a.lang.startsWith("en") ? 0 : 1;
    const bEn = b.lang.startsWith("en") ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;
    return a.label.localeCompare(b.label);
  });

  return result;
}
