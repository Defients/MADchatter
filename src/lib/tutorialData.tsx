import type { ChatMessage, PinnedMemory } from "../types";
import { createChatMessage } from "./chatUtils";
import { generateId } from "./ids";
import React from "react";
import { useAppStore } from "../store";

export interface TutorialStep {
  selector: string;
  title: React.ReactNode;
  description: React.ReactNode;
  position: "top" | "bottom" | "right" | "left";
  icon?: string;
  scrollTarget?: string;
  scrollBehavior?: "smooth" | "auto";
  onActivate?: () => void;
}

export const TUTORIAL_STORAGE_KEY = "madchatter-tutorial-seen";

const CHUNCE_RAW = `[2026-07-01 08:26:14] #skippypoppin thecreature: i did it Chunce. i rly did it.. and now the rest of the Streaming world (includin' u) will have to 'suffer' from my creation.
[2026-07-01 08:26:34] #skippypoppin justinboneeer: Chunce
[2026-07-01 08:26:43] #skippypoppin pako2603: Chunce xdd
[2026-07-01 08:26:52] #skippypoppin notaloginname: i tried playing this game act 1 was decently easy on tactician but in act 2 the difficulty scales really steep do you guys have any tips? just buy better gear or what to do?
[2026-07-01 08:26:53] #skippypoppin shovel_knight25: monkaOMEGA hes summoning mahoraga
[2026-07-01 08:26:58] #skippypoppin aedhyl: Chuda
[2026-07-01 08:26:58] #skippypoppin alexation: Chudunce
[2026-07-01 08:27:09] #skippypoppin thecreature: all i gotta do is this: *** (^:
[2026-07-01 08:27:22] #skippypoppin shovel_knight25: *** it works
[2026-07-01 08:27:36] #skippypoppin googleaj: @NotALoginName act 2 layout is not linear, some fights are 9, some lvl 13, gotta just find easier quest/fights
[2026-07-01 08:27:39] #skippypoppin lyynad: @NotALoginName act 2 is more open, so you can go into the location underleveled
[2026-07-01 08:27:50] #skippypoppin thecreature: madchatter (dot) fun
[2026-07-01 08:27:52] #skippypoppin thecreature: yw
[2026-07-01 08:27:56] #skippypoppin notaloginname: hmm yeah i thought so thanks
[2026-07-01 08:28:22] #skippypoppin googleaj: how is sebille missing exp
[2026-07-01 08:28:30] #skippypoppin pako2603: SOON
[2026-07-01 08:28:33] #skippypoppin pako2603: NODDERS
[2026-07-01 08:28:41] #skippypoppin thecreature: The Chunce Saga continues... what fresh chaos have I wrought upon this stream?
[2026-07-01 08:29:41] #skippypoppin lyynad: killing the dogos SadCatW
[2026-07-01 08:29:45] #skippypoppin mectuka: Yoink
[2026-07-01 08:29:57] #skippypoppin shovel_knight25: FeelsDankMan its just a vibecoded chat bot
[2026-07-01 08:30:07] #skippypoppin smau_1: Yo any kings on? ive been in chat jail for months can i please get unbanned on sodas stream BEGGING
[2026-07-01 08:30:38] #skippypoppin naarnia: mods ban that guy here too
[2026-07-01 08:30:43] #skippypoppin pako2603: LO
[2026-07-01 08:30:44] #skippypoppin smau_1: NOOOO
[2026-07-01 08:31:07] #skippypoppin lathund: Yeah, complete your sentencing
[2026-07-01 08:31:19] #skippypoppin thecreature: @shovel_knight25 yes. and there's none of this caliber out there with as many features for 0 cost. :D
[2026-07-01 08:31:21] #skippypoppin googleaj: shoot that guy
[2026-07-01 08:31:41] #skippypoppin steffox1848: sodaWoah
[2026-07-01 08:31:48] #skippypoppin thefro_0: MODS
[2026-07-01 08:32:08] #skippypoppin lil_mandelbrot: don't kill the doggo
[2026-07-01 08:32:14] #skippypoppin kinger1500: are you winning
[2026-07-01 08:32:25] #skippypoppin pako2603: Based Sebille
[2026-07-01 08:32:32] #skippypoppin thecreature: @shovel_knight25 took me ~3days btw tehe
[2026-07-01 08:32:37] #skippypoppin naarnia: ripbozo i guess
[2026-07-01 08:32:38] #skippypoppin kaexium: mods checked his logs and sent him into space
[2026-07-01 08:32:40] #skippypoppin rubeguh: How far did they get on the previous playthrough?
[2026-07-01 08:33:05] #skippypoppin lil_mandelbrot: i think they just replay act 1 just to kill that dog
[2026-07-01 08:33:17] #skippypoppin pako2603: saved
[2026-07-01 08:33:33] #skippypoppin pako2603: @lil_mandelbrot Wait till you see the bear and the dub
[2026-07-01 08:34:08] #skippypoppin kinger1500: I would have played it differently
[2026-07-01 08:34:13] #skippypoppin naarnia: i gotta say.. the new emotes are growing on me, they're super cute sodaBoop
[2026-07-01 08:34:21] #skippypoppin shovel_knight25: @THECREATURE theres no such thing as 0 cost
[2026-07-01 08:34:28] #skippypoppin shovel_knight25: 1) tokens have to come from somewhere
[2026-07-01 08:34:44] #skippypoppin shovel_knight25: 2) your privacy policy says what data is sent to third party providers, and its a lot
[2026-07-01 08:34:57] #skippypoppin thecreature: @shovel_knight25 oops mb. a $5/mo neocities host and a $4/year domain. mb
[2026-07-01 08:35:22] #skippypoppin kinger1500: seems like the wrong move
[2026-07-01 08:36:14] #skippypoppin shovel_knight25: maybe the world is at the point where vibecoded slop is to be taken seriously
[2026-07-01 08:36:21] #skippypoppin shovel_knight25: but im not at that point yet Sadge
[2026-07-01 08:36:41] #skippypoppin thecreature: it's 2ez. if u got a brain and time
[2026-07-01 08:36:41] #skippypoppin kaexium: im just waiting for when theres jobs to specifically unvibe the code mhm
[2026-07-01 08:37:06] #skippypoppin wulfiegametv: why did they reset?
[2026-07-01 08:37:31] #skippypoppin thecreature: btw: GME-5.2 is op
[2026-07-01 08:38:07] #skippypoppin thecreature: D: Not the doggo price tag! The Chunce Saga is officially an investment! D:
[2026-07-01 08:38:20] #skippypoppin lathund: Chance has to pay tribute to vei for Carry ing him LULW
[2026-07-01 08:42:46] #skippypoppin lyynad: we are out of fort joy Pog
[2026-07-01 08:42:52] #skippypoppin viruszwerg125: monkaOMEGA automod
[2026-07-01 08:44:11] #skippypoppin lyynad: vei did the character
[2026-07-01 08:44:19] #skippypoppin pako2603: NODDERS Beard adds +5 to tanking
[2026-07-01 08:45:03] #skippypoppin adeow: what the heck is this
[2026-07-01 08:46:35] #skippypoppin thecreature: @shovel_knight25 i fixt the PP.. i prolly should read it 4Head -- also pushed out: Persona Presets, Keyword Trigger Rules, and Session Goals
[2026-07-01 08:46:52] #skippypoppin pako2603: So much ragebait in the chat got me feeling exhausted today
[2026-07-01 08:47:19] #skippypoppin thecreature: The Chunce Saga: now with better PP and Persona Presets! This is evolving faster than a DOS2 build Pog
[2026-07-01 08:51:03] #skippypoppin shovel_knight25: @Lyynad i think they got to act 3 before dropping
[2026-07-01 08:52:10] #skippypoppin bogusny: this is why AI is a mistake, too much power put into the hands of complete retards
[2026-07-01 08:53:05] #skippypoppin thecreature: tru dat. all i have to say is ... </> ... i mean: 2013
[2026-07-01 08:54:15] #skippypoppin naarnia: sodaLookup the fuck did i miss
[2026-07-01 08:56:27] #skippypoppin lyynad: base game archer just nukes everything
[2026-07-01 08:58:34] #skippypoppin kaijupooper: dnd works for table top but for video games its pretty limiting 1 acion 1 bonus action zzzz
[2026-07-01 08:59:24] #skippypoppin tonkatush: Wait i left 1 hour 30 into the first reset. Was there a second? xdd
[2026-07-01 08:59:43] #skippypoppin gargawang: NOOOO
[2026-07-01 08:59:44] #skippypoppin batsun1corn: ggs
[2026-07-01 08:59:46] #skippypoppin naarnia: ggs
[2026-07-01 08:59:50] #skippypoppin lyynad: NOOOO
[2026-07-01 09:00:00] #skippypoppin breaderick: ggs
[2026-07-01 09:00:02] #skippypoppin zakyprime: Skippy not even saying gn
[2026-07-01 09:00:17] #skippypoppin pako2603: ggs
[2026-07-01 09:00:19] #skippypoppin pako2603: o7
[2026-07-01 09:02:11] #skippypoppin viruszwerg125: Sadge didnt even raid bulpes`;

export interface TimedChatMessage {
  message: ChatMessage;
  delayMs: number;
}

const TIMESTAMP_REGEX = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+#\S+\s+(\S+):\s+(.*)$/;

function parseTimestamp(ts: string): number {
  return new Date(ts.replace(" ", "T")).getTime();
}

const RAPID_REACTIONS = ["ggs", "NOOOO", "o7", "SOON", "NODDERS", "LO", "Yoink", "Chunce", "Chuda", "Chudunce"];
const QUESTION_PATTERN = /\?|how|why|what|wait|did they|are you|can i|should i/i;
const EMOTION_PATTERN = /^(NOOOO|ggs|o7|LO|Sadge|sodaLookup|sodaWoah|sodaBoop|monkaOMEGA|Pog)/i;

export function parseChunceLogWithDelays(): TimedChatMessage[] {
  const lines = CHUNCE_RAW.split("\n");
  const parsed: { message: ChatMessage; realTime: number }[] = [];

  for (const line of lines) {
    const match = line.match(TIMESTAMP_REGEX);
    if (match) {
      const [, ts, username, text] = match;
      parsed.push({
        message: createChatMessage(username, text, "twitch"),
        realTime: parseTimestamp(ts),
      });
    }
  }

  if (parsed.length === 0) return [];

  // Compute real delays between consecutive messages
  const realDelays: number[] = [];
  for (let i = 1; i < parsed.length; i++) {
    realDelays.push(parsed[i].realTime - parsed[i - 1].realTime);
  }

  // Compress: scale so total playback is ~75 seconds
  const totalRealTime = parsed[parsed.length - 1].realTime - parsed[0].realTime;
  const TARGET_TOTAL_MS = 75_000;
  const scale = totalRealTime > 0 ? Math.min(1, TARGET_TOTAL_MS / totalRealTime) : 0.5;

  const result: TimedChatMessage[] = [];
  result.push({ message: parsed[0].message, delayMs: 0 });

  for (let i = 1; i < parsed.length; i++) {
    const realDelay = realDelays[i - 1];
    let compressed = realDelay * scale;

    // Slow down the first 8 messages so the user has time to read them
    if (i <= 8) {
      compressed = Math.max(compressed, 2500 + Math.random() * 1000);
    }

    // Context-aware adjustments
    const prevMsg = parsed[i - 1].message;
    const currMsg = parsed[i].message;
    const currText = currMsg.text.trim();
    const prevText = prevMsg.text.trim();

    // Let "tru dat" linger before the next message
    if (prevMsg.user === "thecreature" && prevMsg.text.includes("tru dat")) {
      compressed = Math.max(compressed, 4000);
    }

    // Rapid-fire reactions (short emotional responses right after another) — minimum delay
    const isRapidReaction =
      RAPID_REACTIONS.some((r) => currText.toLowerCase().startsWith(r.toLowerCase())) ||
      EMOTION_PATTERN.test(currText) ||
      currText.length < 15;

    // Same user consecutive messages — very short delay
    if (currMsg.user === prevMsg.user) {
      compressed = Math.min(compressed, 300 + Math.random() * 400);
    }
    // Rapid reactions after emotional messages
    else if (isRapidReaction && (EMOTION_PATTERN.test(prevText) || prevText.length < 20)) {
      compressed = Math.min(compressed, 200 + Math.random() * 500);
    }
    // Question asked → response has a natural thinking delay
    else if (QUESTION_PATTERN.test(prevText) && currText.includes("@")) {
      compressed = Math.max(compressed, 1500 + Math.random() * 1000);
    }
    // Long messages (paragraphs) get more time to be "typed"
    else if (currText.length > 80) {
      compressed = Math.max(compressed, 1200 + Math.random() * 800);
    }

    // Clamp: 150ms minimum (feels live), 5000ms max (doesn't feel dead)
    compressed = Math.max(150, Math.min(5000, compressed));

    result.push({ message: currMsg, delayMs: compressed });
  }

  return result;
}

export function parseChunceLog(): ChatMessage[] {
  return parseChunceLogWithDelays().map((t) => t.message);
}

export function getTutorialSampleMemories(): PinnedMemory[] {
  return [
    {
      id: generateId(),
      type: "chat",
      content: "thecreature: i did it Chunce. i rly did it.. and now the rest of the Streaming world will have to suffer from my creation.",
      label: "thecreature: i did it Chunce. i rly did it.. and now the rest of the Streaming world will have to suffer from my creation.",
      timestamp: Date.now() - 60000,
    },
    {
      id: generateId(),
      type: "chat",
      content: "pako2603: So much ragebait in the chat got me feeling exhausted today",
      label: "pako2603: So much ragebait in the chat got me feeling exhausted today",
      timestamp: Date.now() - 30000,
    },
    {
      id: generateId(),
      type: "audio",
      content: "[08:44:19] The streamer is playing Divinity Original Sin 2, currently in Act 1 Fort Joy",
      label: "[08:44] Playing DOS2 Act 1 — Fort Joy",
      timestamp: Date.now() - 120000,
    },
  ];
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    selector: '[data-tutorial="channel"]',
    title: "Welcome to the Forge!",
    description: (
      <>
        Click here to set your stream channel name. Empty sessions preview <span className="text-teal-400 font-bold">'skippypoppin'</span> with sample chat so you can see how everything works. Existing session context stays in place during the tour.
      </>
    ),
    position: "bottom",
  },
  {
    selector: '[data-tutorial="platform-tabs"]',
    title: "Pick Your Platform",
    description: (
      <>
        <span className="text-orange-400 font-bold">MADchatter</span> works with <span className="text-[#9146FF] font-bold">Twitch</span>, <span className="text-[#53fc18] font-bold">Kick</span>, and <span className="text-[#FF6B35] font-bold">Joystick</span>. Switch anytime — your chat connection, auth, and send logic all adapt automatically. No restart needed.
      </>
    ),
    position: "bottom",
  },
  {
    selector: '[data-tutorial="chat-widget"]',
    title: "Chat Stream Pulse",
    description: (
      <>
        Live chat flows in here in real-time. <span className="text-orange-400 font-bold">MADchatter</span> analyzes every message for sentiment, mentions, and context fusion. Right-click any message to copy it, hover to pin it to memory. When someone asks a question the bot can answer, <span className="text-cyan-400 font-bold">Smart Reply</span> chips appear below — one click to send.
      </>
    ),
    position: "right",
  },
  {
    selector: '[data-tutorial="stream-widget"]',
    title: "Stream Embed",
    description: (
      <>
        Watch the stream directly inside <span className="text-orange-400 font-bold">MADchatter</span>. Resize the embed, lock aspect ratio, and even chat into the stream without leaving the app. The embed also helps Visual Capture crop frames correctly when using same-tab capture.
      </>
    ),
    position: "right",
  },
  {
    selector: '[data-tutorial="visual-widget"]',
    title: "Visual Capture",
    description: (
      <>
        Share a browser tab and let <span className="text-orange-400 font-bold">MADchatter</span> see the stream in real-time. Snapshots are analyzed by AI vision for context-aware chat suggestions. Try Smart Capture — it dynamically adjusts the capture interval based on how fast the scene is changing!
      </>
    ),
    position: "right",
    scrollTarget: '[data-tutorial="visual-widget"]',
    scrollBehavior: "smooth",
  },
  {
    selector: '[data-tutorial="audio-widget"]',
    title: "Audio Transcription",
    description: (
      <>
        Turn on audio transcription to capture the streamer's voice live. <span className="text-orange-400 font-bold">MADchatter</span> weaves spoken words into every Forge — and bots will even <span className="text-teal-400 font-bold">recognize their own name</span> spoken aloud, triggering a targeted response. Uses in-browser Whisper — no API key required, just a one-time model download (~150MB, cached after).
      </>
    ),
    position: "right",
    scrollTarget: '[data-tutorial="audio-widget"]',
    scrollBehavior: "smooth",
  },
  {
    selector: '[data-tutorial="memory-widget"]',
    title: "Pinned Memories",
    description: (
      <>
        Pin important moments from chat, audio, or visual snapshots. Star a <span className="text-yellow-400 font-bold">Golden Memory</span> for extra impact on forged comments. Export and import memories between sessions. This is your stream's institutional knowledge — manually curated.
      </>
    ),
    position: "right",
  },
  {
    selector: '[data-tutorial="auto-memory"]',
    title: "Auto-Memory System",
    description: (
      <>
        Toggle this to let <span className="text-purple-400 font-bold">AI automatically extract memories</span> from chat — facts, traits, user profiles, inside jokes, and personality evolution. Each bot builds its own independent memory across sessions. Click the brain icon to open the memory management panel and review what your bot has learned.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="forge-buttons"]',
    title: "The Forge",
    description: (
      <>
        Press <span className="inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 rounded bg-orange-500/20 border border-orange-500/40 text-orange-300 font-bold text-[14px] leading-none shadow-[0_0_8px_rgba(249,115,22,0.3)]">F</span> or click Forge to generate AI-powered chat variants. Each variant is tailored to the stream context — visual, audio, chat, and memory all fused together. Refine, copy, or send any variant directly to chat. Check the token usage bar to track your API costs.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="sliders"]',
    title: "Tune the Vibe",
    description: (
      <>
        Drag these sliders to control the personality of your forged messages. More humor = funnier, more chaos = wilder. Find your sweet spot — or crank both to 100 and embrace the madness. Settings are saved automatically.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="persona"]',
    title: "Persona Masks",
    description: (
      <>
        Six distinct personas — Gremlin, Hype Beast, Analyst, One-Worder, Questioner, and Support. Each has its own voice and style. Mix and match active personas, or save your own custom presets for quick switching.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="directives-header"]',
    title: "Quick Directives",
    description: (
      <>
        Click these chips to instantly add flavor to your Forge. Add sarcasm, hype it up, roast gently — or create your own custom chips with the + button. They get appended to the AI's instructions for that forge batch.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="r34l"]',
    title: (
      <>
        <span className="text-emerald-400 font-bold">R34L</span> Human Typing
      </>
    ),
    description: (
      <>
        Toggle <span className="text-emerald-400 font-bold">R34L</span> to make your bot pick up the room's typing texture. R34L <span className="text-emerald-300">learns how this community actually writes</span> — casing, message length, punctuation, emote habits — and remembers it per streamer across visits. Your bot keeps its own personality and meaning; only surface style adapts. Tap the ⓘ next to the toggle any time to see exactly what it has learned.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="provider"]',
    title: "Choose Your AI",
    description: (
      <>
        Pick from Gemini, GPT-5.6 Luna, Claude Haiku 4.5, or OpenRouter. Each model brings different strengths — Gemini is fast, Claude is nuanced, GPT-5.6 Luna is cost-efficient. If a provider fails, <span className="text-orange-400 font-bold">MADchatter</span> automatically falls back to the next healthy one. Note: every provider requires a paid API key.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="settings"]',
    title: "Deep Settings",
    description: (
      <>
        Click the gear icon for the full settings panel: TTS voices, sound effects, desktop notifications, rate limiting, keyword trigger rules, session goals, and more. Fine-tune every aspect of your bot's behavior here.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="autoforge"]',
    title: "AutoForge™",
    description: (
      <>
        Flip this toggle to let <span className="text-orange-400 font-bold">MADchatter</span> go fully autonomous. AutoForge decides when to speak, what to say, and fires messages to chat on its own — with a full event report. Set confidence thresholds, dry-run mode, and rate limits for safety.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="autoforge-hud"]',
    title: "AutoForge HUD",
    description: (
      <>
        When AutoForge is active, this draggable HUD shows real-time decisions, confidence levels, and timing. Press <span className="text-orange-300 font-bold">H</span> to toggle it anytime. Use <span className="text-cyan-400 font-bold">Dry Run Mode</span> (in the HUD) to preview bot decisions without sending anything to chat — perfect for tuning thresholds and testing personas safely.
      </>
    ),
    position: "left",
    onActivate: () => {
      useAppStore.getState().setIsAutoForgeHUDOpen(true);
      window.dispatchEvent(new CustomEvent("tutorial-expand-hud"));
      const header = document.querySelector('[data-tutorial="autoforge-header"]') as HTMLElement | null;
      if (header) {
        header.style.color = "#facc15";
        header.style.textShadow = "0 0 8px rgba(250, 204, 21, 0.4)";
      }
    },
  },
  {
    selector: '[data-tutorial="action-timeline"]',
    title: "Action Timeline",
    description: (
      <>
        This animated dot timeline shows every AutoForge event — messages sent, mentions, activity spikes, deliberate silences, and errors. Each color is a category. Hover any dot for details. In multi-bot mode, all bots' events are aggregated here. Filter by category to see exactly what your bot(s) have been up to.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="multibot-button"]',
    title: (
      <>
        <span className="text-[#9146FF] font-bold">Multi-Bot</span> Mode
      </>
    ),
    description: (
      <>
        Click here to open the Multi-Bot panel. Add a second (or third) bot with its own Twitch/Kick account, persona, and memory. Each bot runs its own independent AutoForge loop and takes turns speaking through a <span className="text-[#9146FF] font-bold">speaker coordinator</span> — no two bots talk over each other. Use the per-bot <span className="text-orange-400 font-bold">Force</span> button to trigger a specific bot on demand.
      </>
    ),
    position: "bottom",
    onActivate: () => {
      // Open the multi-bot panel so the user can see it during the tour
      window.dispatchEvent(new CustomEvent("tutorial-open-multibot"));
    },
  },
  {
    selector: '[data-tutorial="multibot-panel"]',
    title: "Director Notes",
    description: (
      <>
        Inside the Multi-Bot panel, the <span className="text-purple-400 font-bold">Director Note</span> input lets you send <span className="text-purple-300 font-bold">private directives</span> to one bot or all bots. These notes are <span className="text-purple-300 font-bold">never sent to chat</span> — they're injected into the bot's next AutoForge decision as a high-priority directive. Use them for feedback, status updates, or things you want the bot to remember mid-stream. Below it, the <span className="text-orange-400 font-bold">ChatSender</span> sends real messages to chat as the selected bot.
      </>
    ),
    position: "left",
  },
  {
    selector: '[data-tutorial="statusbar"]',
    title: "Status Bar",
    description: (
      <>
        Your connection status, session stats, and sent message history live here. Click to expand and review everything <span className="text-orange-400 font-bold">MADchatter</span> has done this session — messages sent, forge count, uptime, and more. The colored dots show real-time sentiment trends.
      </>
    ),
    position: "top",
  },
  {
    selector: '[data-tutorial="cosmotech"]',
    title: (
      <>
        <span className="text-blue-400 font-bold">Cosmo</span><span className="text-purple-500 font-bold">Tech</span>™ Theme
      </>
    ),
    description: (
      <>
        Click the orbit icon to switch to the futuristic <span className="text-blue-400 font-bold">Cosmo</span><span className="text-purple-500 font-bold">Tech</span> theme — animated cosmic backgrounds, glowing accents, and a whole new vibe. Press T anytime to toggle. Pure aesthetics, same powerful features underneath.
      </>
    ),
    position: "bottom",
  },
  {
    selector: '[data-tutorial="command-palette"]',
    title: "You're Ready! 🎉",
    description: (
      <>
        Press <span className="text-orange-300 font-bold">Ctrl+K</span> for the command palette, <span className="text-orange-300 font-bold">?</span> for keyboard shortcuts, and <span className="text-orange-300 font-bold">F</span> to Forge. You now know every major feature — go make some chaos! You can replay this tutorial anytime from the command palette.<br /><span className="block text-center text-[15px] font-bold mt-1">Welcome to <span className="text-orange-400">MADchatter</span>!</span>
      </>
    ),
    position: "bottom",
  },
];
