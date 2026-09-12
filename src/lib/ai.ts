import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, getKeys, openAiCompatEndpoint } from "./keys";
import { getTwitchSession } from "./twitch";
import { AutoForgeEvent, ForgeConfig, ForgeSuggestion } from "../types";
import {
  FORGE_SYSTEM_PROMPT,
  R34L_TYPING_PROMPT,
  REFINE_SYSTEM_PROMPT,
  AUTOFORGE_SYSTEM_PROMPT,
  MEMORY_AWARENESS_PROMPT,
  AUTOFORGE_MEMORY_PROMPT,
  ANTI_REPETITION_PROMPT,
  SENTIMENT_AWARENESS_PROMPT,
  buildBotIdentityPrompt,
  FIRST_MESSAGE_DIRECTIVE,
  SUPERCHARGE_DIRECTIVE,
} from "./prompts";
import { analyzeChatStyle, formatChatStyleProfile } from "./chatStyle";
import {
  getHealthyFallbackChain,
  recordProviderFailure,
  recordProviderSuccess,
  isProviderAvailable,
  recordFallback,
} from "./providerFallback";
import {
  aiScheduler,
  buildProviderRequestOptions,
  getOperationTokenBudget,
  getOperationTimeout,
  isSchedulerCancellation,
  isQueueTimeout,
  type AIRequestPriority,
} from "./aiScheduler";

// ─── AI Request Timeout & Cancellation ────────────────────────────────────────
// The scheduler owns AbortControllers and enforces real cancellation on timeout
// or preemption. `withAiTimeout` is kept for backward compatibility (memoryEngine
// imports it) but now delegates to the scheduler for cancellation.
const AI_REQUEST_TIMEOUT_MS = 45_000;

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within
 * `timeoutMs`, rejects with a timeout error.
 *
 * @deprecated Use `aiScheduler.execute()` for real cancellation support.
 * This helper is retained for backward compatibility but does NOT cancel
 * the underlying request.
 */
export function withAiTimeout<T>(promise: Promise<T>, timeoutMs: number = AI_REQUEST_TIMEOUT_MS, operation: string = "AI request"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * R34L adaptive profile segment. When R34L is on and the recent chat log has
 * enough signal, build a "CHAT STYLE PROFILE" block that steers the model
 * toward mirroring the room's actual typing texture. Returns "" when R34L is
 * off or chat is thin (the fixed R34L_TYPING_PROMPT baseline applies instead).
 */
function r34lProfileSegment(
  recentChatLog: string | undefined,
  availableEmotes: string[] | undefined,
  r34lEnabled?: boolean,
): string {
  if (!r34lEnabled || !recentChatLog) return "";
  const profile = analyzeChatStyle(recentChatLog, availableEmotes);
  return profile ? formatChatStyleProfile(profile) : "";
}

export interface StreamMetadata {
  channelName: string;
  title: string;
  category: string;
  viewerCount: number;
}

export interface AutoForgeDecision {
  decision: string;
  confidence: number;
  reason: string;
  suggested_trigger?: string;
  estimated_next_action_minutes: number;
  action_payload?: string;
  followup_delay_ms?: number;
  applied_chaos_level?: number;
  applied_humor_level?: number;
  referenced_memory_ids?: string[];
  referenced_joke_ids?: string[];
  timestamp?: number;
  activityLevel?: number;
  // Multi-bot enrichment (stamped by useAutoForgeBot before storing, not by the
  // model). Used by the AutoForge HUD to explain why a given bot was chosen.
  personaFit?: number; // 0–1
  isMentioned?: boolean;
  // Stamped by autoforgeDecide() after a successful provider fallback.
  used_fallback_provider?: string;
  // Stamped by autoforgeDecide() when token usage is available.
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const responseSchema = {
  type: "OBJECT",
  properties: {
    analysis: {
      type: "OBJECT",
      properties: {
        current_moment: { type: "STRING" },
        chat_energy: { type: "STRING" },
        key_opportunities: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["current_moment", "chat_energy", "key_opportunities"],
    },
    suggestions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          variant_id: { type: "INTEGER" },
          profile: { type: "STRING" },
          message: { type: "STRING" },
          tone: { type: "STRING" },
          why_it_fits: { type: "STRING" },
          suggested_emotes: { type: "STRING", nullable: true },
          confidence: { type: "NUMBER" },
        },
        required: ["variant_id", "profile", "message", "tone", "why_it_fits", "confidence"],
      },
    },
  },
  required: ["analysis", "suggestions"],
};

const refineResponseSchema = {
  type: "OBJECT",
  properties: {
    message: { type: "STRING" },
    why_it_fits: { type: "STRING" },
  },
  required: ["message", "why_it_fits"],
};

const autoforgeResponseSchema = {
  type: "OBJECT",
  properties: {
    decision: { type: "STRING" },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
    suggested_trigger: { type: "STRING" },
    estimated_next_action_minutes: { type: "NUMBER" },
    action_payload: { type: "STRING" },
    followup_delay_ms: { type: "NUMBER" },
    applied_chaos_level: { type: "NUMBER" },
    applied_humor_level: { type: "NUMBER" },
    referenced_memory_ids: { type: "ARRAY", items: { type: "STRING" } },
    referenced_joke_ids: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["decision", "confidence", "reason", "estimated_next_action_minutes"],
};

function normalizeProvider(rawProvider: string): string {
  if (rawProvider === "gemini-pro" || rawProvider === "gemini-env") return "gemini";
  if (rawProvider === "anthropic") return "claude";
  return rawProvider;
}

function cleanJsonStr(str: string): string {
  let clean = str.trim();
  if (!clean) return "{}";
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  if (!clean) return "{}";
  return clean;
}

/**
 * Best-effort repair for a JSON string that was truncated mid-output by the
 * model's max-token cap. Closes any open string, then balances open
 * arrays/objects. Returns the repaired string (which may still fail to parse
 * if the truncation point is too pathological). Used only as a fallback when
 * JSON.parse fails, so the user gets suggestions instead of a hard error.
 */
function repairTruncatedJson(str: string): string {
  let s = str.trim();
  if (!s) return "{}";
  // Strip a trailing code-fence opener if present.
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  // Fix leading commas after { or [ (e.g. "{,}" → "{}") — some models emit
  // these when they intended to write a property but produced nothing.
  s = s.replace(/([{,]\s*,)+/g, "$1").replace(/([{[]\s*,)+/g, "$1");
  // Track open structures, respecting string state and escapes.
  let inString = false;
  let escape = false;
  const stack: Array<"{" | "["> = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("{");
    else if (ch === "[") stack.push("[");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  // Close an unterminated string first.
  let repaired = s;
  if (inString) repaired += '"';
  // Remove a trailing comma/colon that would make the closing brace invalid.
  repaired = repaired.replace(/[\s,]+$/, "");
  // Balance remaining open structures.
  while (stack.length > 0) {
    const open = stack.pop();
    repaired += open === "{" ? "}" : "]";
  }
  return repaired;
}

export interface GenerateChatParams {
  streamMetadata: StreamMetadata;
  visualContext?: string;
  screenshot?: string;
  recentChatLog?: string;
  audioTranscript?: string;
  longTermContext?: string;
  config: ForgeConfig;
  activeProvider: string;
  count?: number;
  r34lEnabled?: boolean;
  botUsername?: string;
  memoryContext?: string;
  sentimentContext?: string;
  availableEmotes?: string[];
  /** Emote names tagged with provider+scope (e.g. "monkaS (7tv-channel)").
   *  When provided, the prompt uses this list with provider/scope tags so the
   *  AI knows which emotes are channel-specific (favor) vs global (use sparingly).
   *  Falls back to `availableEmotes` (plain names) when not provided. */
  availableEmotesTagged?: string[];
  botIdentityMode?: "admit" | "custom";
  botIdentityStory?: string;
  /** Scheduler priority override. Defaults to "critical" (manual Forge).
   *  Smart Replies and AutoForge full_forge should pass "autonomous" or "background". */
  priority?: AIRequestPriority;
  /** First Message Mode: when true, appends the temporary "arrival" directive
   *  to the system prompt so this bot's next message feels like a natural
   *  entrance. Additive only — never alters the bot's persona. */
  firstMessageMode?: boolean;
}

/**
 * Smart effort resolver — when `effortLevel === "smart"`, inspect the available
 * context signals and dynamically pick low/medium/high for this call.
 *
 * Heuristics (each signal contributes a 0–1 sub-score):
 *   - Chat log length     (~40%): <10 msgs = low, 10–50 = medium, >50 = high
 *   - Auto memories       (~25%): 0–2 = low, 3–10 = medium, >10 = high
 *   - Visual snapshot      (~15%): present = high, absent = low
 *   - Audio transcript     (~10%): >200 chars = high, else low
 *   - Long-term context    (~10%): >100 chars = high, else low
 *
 * Final score: <0.35 → low, 0.35–0.7 → medium, >0.7 → high
 */
export function resolveSmartEffort(params: GenerateChatParams): "low" | "medium" | "high" {
  // Chat log richness
  const chatLog = params.recentChatLog || "";
  // Count rough message boundaries (lines starting with a timestamp or username)
  const chatLines = chatLog ? chatLog.split("\n").filter((l) => l.trim().length > 0).length : 0;
  const chatScore = chatLines < 10 ? 0.0 : chatLines <= 50 ? 0.5 : 1.0;

  // Memory context richness — memoryContext is a pre-formatted string, so
  // use its length as a proxy for how many memories were injected.
  const memStr = params.memoryContext || "";
  const memScore = memStr.length < 100 ? 0.0 : memStr.length <= 500 ? 0.5 : 1.0;

  // Visual snapshot
  const visScore = params.screenshot || (params.visualContext && params.visualContext.length > 20) ? 1.0 : 0.0;

  // Audio transcript
  const audStr = params.audioTranscript || "";
  const audScore = audStr.length > 200 ? 1.0 : 0.0;

  // Long-term context
  const ltcStr = params.longTermContext || "";
  const ltcScore = ltcStr.length > 100 ? 1.0 : 0.0;

  const score =
    chatScore * 0.40 +
    memScore  * 0.25 +
    visScore  * 0.15 +
    audScore  * 0.10 +
    ltcScore  * 0.10;

  let resolved: "low" | "medium" | "high";
  if (score < 0.35) resolved = "low";
  else if (score <= 0.7) resolved = "medium";
  else resolved = "high";

  console.log(`[Smart Effort] score=${score.toFixed(2)} → ${resolved} (chat=${chatScore}, mem=${memScore}, vis=${visScore}, aud=${audScore}, ltc=${ltcScore})`);
  return resolved;
}

export async function generateChat(params: GenerateChatParams): Promise<any> {
  const rawProvider = params.activeProvider || "gemini";
  const provider = normalizeProvider(rawProvider);
  const apiKey = getApiKey(rawProvider);
  if (!apiKey) throw new Error(`No API key configured for ${rawProvider}. Add it in Settings.`);

  const keys = getKeys();
  // Identity context: prefer the explicitly passed botUsername (multi-bot mode
  // passes the per-bot identity). Only fall back to the global session when no
  // botUsername was provided (legacy single-bot callers).
  const session = params.botUsername ? null : getTwitchSession();

  let currentVisualContext = params.visualContext;
  let usage: any = undefined;
  if (params.screenshot && (!params.visualContext || params.visualContext.length < 50)) {
    try {
      const visionResult = await generateVisionContext(rawProvider, apiKey, params.screenshot);
      currentVisualContext = visionResult.text;
      // Fold vision tokens into the forge total (user triggered Forge)
      if (visionResult.tokenUsage) {
        usage = visionResult.tokenUsage;
      }
    } catch (e) {
      console.warn("Auto-vision failed, continuing without it", e);
    }
  }

  let effort = params.config?.effortLevel || "medium";
  // Smart mode: dynamically resolve to low/medium/high based on context richness
  if (effort === "smart") {
    effort = resolveSmartEffort(params);
  }
  let effortDirective = "";
  const maxTokensToUse = getOperationTokenBudget("forge", effort, params.count);
  let temp = 0.7;

  if (effort === "low") {
    temp = 0.5;
    effortDirective = "\nEFFORT LEVEL REQUIRED: MINIMAL. Generate fast, extremely snappy, and lightweight suggestions. Keep analysis brief and concise. Minimize computation.";
  } else if (effort === "high") {
    temp = 0.9;
    effortDirective = "\nEFFORT LEVEL REQUIRED: MAXIMUM. Dive extremely deep. Perform comprehensive, ultra-detailed analysis of the stream context, latest events, and audio. Craft suggestions with advanced wordplay, perfect contextual inside jokes, and high emotional/strategic value.";
  } else {
    effortDirective = "\nEFFORT LEVEL REQUIRED: BALANCED. Provide thoughtful, well-aligned suggestions with solid context utilization.";
  }

  const userMessageContent = `
STREAM METADATA:
Channel: ${params.streamMetadata?.channelName || "Unknown"}
Category: ${params.streamMetadata?.category || "Unknown"}
Viewers: ${params.streamMetadata?.viewerCount || 0}
Title: ${params.streamMetadata?.title || "Unknown"}

YOUR IDENTITY:
You are logged in as "${params.botUsername || "Unknown"}". This is your Twitch/Kick handle — when someone mentions this name in chat, they are talking to YOU, not the streamer. The streamer is "${params.streamMetadata?.channelName || "Unknown"}". Do not confuse yourself with the streamer.

VISUAL CONTEXT:
${currentVisualContext || "None provided"}

RECENT CHAT LOG:
${params.recentChatLog || "None provided"}

STREAMER AUDIO TRANSCRIPT:
${params.audioTranscript || "None provided"}

LONG-TERM CONTEXT:
${params.longTermContext || "None provided"}
${params.memoryContext ? `\n${params.memoryContext}` : ""}
${params.sentimentContext ? `\n${params.sentimentContext}` : ""}

ACTIVE CONFIGURATION:
- Primary Profile: ${params.config.primaryProfile && params.config.primaryProfile !== "none" ? params.config.primaryProfile : "None (Unmasked/Raw. No selected profile mask. Act as an authentic, natural co-pilot that adapts dynamically to the organic stream vibe without forcing a stylized persona.)"}
- Active Profiles: ${params.config.activeProfiles && params.config.activeProfiles.length > 0 ? params.config.activeProfiles.join(", ") : "None"}
- Humor Level: ${params.config.humorLevel}/100
- Chaos Level: ${params.config.chaosLevel}/100
- Length: ${params.config.lengthPreference && params.config.lengthPreference !== "none" && params.config.lengthPreference !== "adaptive" ? params.config.lengthPreference : "Adaptive (No length mask. Let the word/sentence count vary naturally based on what's contextually appropriate)"}
- Emote Density: ${params.config.emoteDensity}
- Toxicity Filter: ${params.config.toxicityFilter || "standard"}
- Voice Context Enabled: ${params.config.voiceContextEnabled}
- Generation Mode: ${params.config.generationMode}
- Additional Instructions: ${params.config.additionalInstructions || "None"}
- Custom Directives: ${params.config.customDirectives || "None"}
${params.availableEmotes && params.availableEmotes.length > 0 ? `\nAVAILABLE EMOTES (use these names exactly): ${params.availableEmotes.join(", ")}` : ""}
${effortDirective}
${params.count ? `\nEXACT OUTPUT COUNT: You must generate exactly ${params.count} suggestion${params.count > 1 ? "s" : ""}. Do not generate more or fewer than ${params.count}.` : ""}`;

  const systemPrompt = FORGE_SYSTEM_PROMPT + (params.r34lEnabled ? R34L_TYPING_PROMPT + r34lProfileSegment(params.recentChatLog, params.availableEmotes, params.r34lEnabled) : "") + (params.memoryContext ? MEMORY_AWARENESS_PROMPT : "") + (params.sentimentContext ? SENTIMENT_AWARENESS_PROMPT : "") + buildBotIdentityPrompt(params.botIdentityMode || "admit", params.botIdentityStory || "") + (params.firstMessageMode ? FIRST_MESSAGE_DIRECTIVE : "");
  let generatedJsonStr = "";

  const forgeTimeout = getOperationTimeout("forge", provider);
  const forgePriority: AIRequestPriority = params.priority ?? "critical";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const parts: any[] = [{ text: userMessageContent }];
    if (params.screenshot) {
      const mimeType = params.screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
      const base64Data = params.screenshot.replace(/^data:image\/\w+;base64,/, "");
      parts.push({ inlineData: { data: base64Data, mimeType } });
    }
    const model = rawProvider === "gemini-pro" ? "gemini-3.7-flash" : "gemini-3.8-flash";
    const response = await aiScheduler.execute(
      (signal) => ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: responseSchema as any,
          temperature: temp,
          maxOutputTokens: maxTokensToUse,
          abortSignal: signal,
        },
      }),
      { operation: `generateChat/${provider}`, provider, model, priority: forgePriority, timeoutMs: forgeTimeout, channel: params.streamMetadata?.channelName, botId: params.botUsername },
    );
    generatedJsonStr = response.text || "{}";
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
  } else if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
    const { baseUrl, model } = openAiCompatEndpoint(provider, keys);
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const content: any[] = [{ type: "text", text: userMessageContent }];
    if (params.screenshot) {
      content.push({ type: "image_url", image_url: { url: params.screenshot } });
    }
    const ollamaOpts = buildProviderRequestOptions(provider);
    const response = await aiScheduler.execute(
      (signal) => ai.chat.completions.create({
        model,
        temperature: temp,
        max_tokens: maxTokensToUse,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
        ...ollamaOpts,
      }, { signal }),
      { operation: `generateChat/${provider}`, provider, model, priority: forgePriority, timeoutMs: forgeTimeout, channel: params.streamMetadata?.channelName, botId: params.botUsername },
    );
    generatedJsonStr = response.choices[0].message.content || "{}";
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      };
    }
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content: any[] = [];
    if (params.screenshot) {
      const mimeType = params.screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
      const base64Data = params.screenshot.replace(/^data:image\/\w+;base64,/, "");
      content.push({ type: "image", source: { type: "base64", media_type: mimeType as any, data: base64Data } });
    }
    content.push({ type: "text", text: userMessageContent });
    const response = await aiScheduler.execute(
      (signal) => ai.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokensToUse,
        temperature: temp,
        system: systemPrompt + "\n\nYou must output ONLY valid JSON matching the schema format.",
        messages: [{ role: "user", content }],
      }, { signal }),
      { operation: `generateChat/${provider}`, provider, model: "claude-haiku-4-5-20251001", priority: forgePriority, timeoutMs: forgeTimeout, channel: params.streamMetadata?.channelName, botId: params.botUsername },
    );
    generatedJsonStr = (response.content.find((c: any) => c.type === "text") as any)?.text || "";
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
  }

  let parsedResponse: any;
  try {
    parsedResponse = JSON.parse(cleanJsonStr(generatedJsonStr));
  } catch (e) {
    // Truncation fallback: the model hit its max-token cap mid-JSON. Attempt
    // to close the unterminated string + balance open structures so we can
    // still surface whatever suggestions the model did emit.
    const repaired = repairTruncatedJson(generatedJsonStr || "");
    try {
      parsedResponse = JSON.parse(repaired);
      console.warn("[generateChat] Model JSON was truncated — salvaged via repair. Original error:", (e as Error).message);
    } catch (e2) {
      console.warn("[generateChat] Failed to parse model JSON.", e, "\nRaw output:", generatedJsonStr?.slice(0, 500));
      throw new Error("Model returned malformed JSON — the provider may be overloaded or the response was truncated. Try again or lower the effort level.");
    }
  }

  if (!parsedResponse || typeof parsedResponse !== "object") {
    throw new Error("Model returned an invalid response (not a JSON object). Try again.");
  }

  // E: Surface empty suggestions as a real error so callers don't toast "success" with nothing to show.
  const rawSuggestions = Array.isArray(parsedResponse.suggestions) ? parsedResponse.suggestions : [];
  const validSuggestions = rawSuggestions.filter((s: any) => s && typeof s.message === "string" && s.message.trim().length > 0);
  if (validSuggestions.length === 0) {
    throw new Error("Model returned no usable suggestions. Try again or lower the effort level.");
  }
  parsedResponse.suggestions = validSuggestions;

  if (currentVisualContext && currentVisualContext !== params.visualContext) {
    parsedResponse.visualContext = currentVisualContext;
  }
  if (usage) {
    parsedResponse.tokenUsage = usage;
  }
  // Expose the resolved effort level so callers can record it in effort_given
  parsedResponse.resolvedEffort = effort;

  return parsedResponse;
}

/**
 * A7: Local variant ranking — scores and ranks generated variants to pick the "best" one.
 * Scoring: confidence * 0.4 + lengthFit * 0.2 + antiRepetition * 0.2 + emoteDensityFit * 0.1 + profileMatch * 0.1
 */
export function rankVariants(
  variants: ForgeSuggestion[],
  context: {
    config: ForgeConfig;
    recentSentMessages?: string[];
  },
): ForgeSuggestion[] {
  if (!variants || variants.length === 0) return variants;

  const { config, recentSentMessages = [] } = context;
  const lengthPref = config.lengthPreference;
  const emoteDensity = config.emoteDensity;
  const primaryProfile = config.primaryProfile;

  // Build a set of recently used n-grams for anti-repetition
  const recentLower = recentSentMessages.map(m => m.toLowerCase());
  const recentText = recentLower.join(" ");

  const scored = variants.map(v => {
    const msg = v.message || "";
    const msgLen = msg.length;

    // 1. Confidence (0-1) → 0.4 weight
    const conf = typeof v.confidence === "number" && !isNaN(v.confidence) ? v.confidence : 0.5;

    // 2. Length fit (0-1) → 0.2 weight
    let lengthFit = 0.5;
    if (lengthPref === "short") {
      lengthFit = msgLen <= 110 ? 1 : Math.max(0, 1 - (msgLen - 110) / 100);
    } else if (lengthPref === "medium") {
      lengthFit = msgLen >= 50 && msgLen <= 200 ? 1 : 0.5;
    } else if (lengthPref === "long") {
      lengthFit = msgLen >= 100 ? 1 : Math.max(0, msgLen / 100);
    } else {
      lengthFit = 0.7; // adaptive/unconstrained
    }

    // 3. Anti-repetition (0-1) → 0.2 weight
    let antiRep = 1;
    const msgLower = msg.toLowerCase();
    // Check if this message is too similar to any recently sent message
    for (const sent of recentLower) {
      if (sent === msgLower) { antiRep = 0; break; }
      // Check opening word overlap
      const msgFirst = msgLower.split(/\s+/)[0] || "";
      const sentFirst = sent.split(/\s+/)[0] || "";
      if (msgFirst && sentFirst && msgFirst === sentFirst) {
        antiRep = Math.min(antiRep, 0.5);
      }
      // Check 3-gram overlap
      const msg3grams = new Set<string>();
      const words = msgLower.split(/\s+/);
      for (let i = 0; i < words.length - 2; i++) {
        msg3grams.add(words.slice(i, i + 3).join(" "));
      }
      const sentWords = sent.split(/\s+/);
      let overlap = 0;
      for (let i = 0; i < sentWords.length - 2; i++) {
        if (msg3grams.has(sentWords.slice(i, i + 3).join(" "))) overlap++;
      }
      if (overlap > 0) antiRep = Math.min(antiRep, Math.max(0, 1 - overlap * 0.2));
    }

    // 4. Emote density fit (0-1) → 0.1 weight
    const emoteCount = (msg.match(/^[A-Z]{2,}/gm) || []).length + // ALLCAPS words as emote proxy
      (msg.match(/\b(POG|LUL|KEKW|Kreygasm|PogChamp|OMEGALUL|Pepega|Sadge|catJAM|monkaS|pepeD|pepeLaugh|EZ|Clap|Pog|pog|based|real)\b/gi) || []).length;
    let emoteFit = 0.5;
    if (emoteDensity === "minimal" || emoteDensity === "none") {
      emoteFit = emoteCount === 0 ? 1 : Math.max(0, 1 - emoteCount * 0.3);
    } else if (emoteDensity === "moderate") {
      emoteFit = emoteCount <= 2 ? 1 : Math.max(0, 1 - (emoteCount - 2) * 0.2);
    } else if (emoteDensity === "heavy") {
      emoteFit = emoteCount >= 1 ? 1 : 0.3;
    }

    // 5. Profile match (0-1) → 0.1 weight
    const profileMatch = v.profile === primaryProfile ? 1 : 0.5;

    const score = conf * 0.4 + lengthFit * 0.2 + antiRep * 0.2 + emoteFit * 0.1 + profileMatch * 0.1;
    return { variant: v, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Mark the top variant as best
  const ranked = scored.map((s, i) => ({
    ...s.variant,
    best: i === 0,
  }));

  return ranked;
}

export async function generateVisionContext(
  rawProvider: string,
  apiKey: string,
  screenshot: string,
  previousContext?: string | null
): Promise<{ text: string; tokenUsage?: TokenUsage }> {
  const provider = normalizeProvider(rawProvider);
  const keys = getKeys();
  // C1: Structured visual context extraction — ask for clearly labeled sections
  const structuredBase = `Analyze this live stream screenshot and respond with a STRUCTURED description using these labeled sections (omit any that don't apply):

SCENE: <what's on screen — game, category, overlay, IRL, etc.>
ACTION: <what's happening right now — gameplay event, conversation, reaction, etc.>
TEXT: <any readable on-screen text, chat highlights, alerts, scores>
ENERGY: <overall vibe — calm, hyped, tense, wholesome, chaotic>
CHANGES: <only if comparing to a previous observation — what's new/different>

Keep each section to one short line. Omit empty sections. Be specific and concise.`;
  const prompt = previousContext
    ? `You are watching a live stream. Your previous observation was:\n${previousContext}\n\nHere is a new screenshot. ${structuredBase.replace("CHANGES: <only if comparing to a previous observation — what's new/different>", "CHANGES: <what has changed since the previous observation — new events, state changes, movement, text changes. If nothing meaningful changed, say 'No significant change.'>")}`
    : structuredBase;

  let usage: TokenUsage | undefined;
  const visionTimeout = getOperationTimeout("vision", provider);
  // On Ollama's single inference slot, vision at `interactive` would preempt
  // every `autonomous` AutoForge decide — and vision fires on every frame
  // change (~10-15s), each taking 13-17s. That starves AutoForge and AutoMemory.
  // Lower vision to `autonomous` on Ollama so it competes fairly for the next
  // free slot instead of always preempting. Cloud providers run concurrently,
  // so they keep `interactive` (vision preempts nothing — it just starts).
  const visionPriority: AIRequestPriority = provider === "ollama" ? "autonomous" : "interactive";
  const visionMaxTokens = getOperationTokenBudget("vision");

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
    const model = rawProvider === "gemini-pro" ? "gemini-3.7-flash" : "gemini-3.8-flash";
    const response = await aiScheduler.execute(
      (signal) => ai.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data: base64Data, mimeType } },
          ],
        }],
        config: {
          maxOutputTokens: visionMaxTokens,
          abortSignal: signal,
        },
      }),
      { operation: `generateVisionContext/${provider}`, provider, model, priority: visionPriority, timeoutMs: visionTimeout },
    );
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
    return { text: response.text || "", tokenUsage: usage };
  } else if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
    const { baseUrl, model } = openAiCompatEndpoint(provider, keys);
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const ollamaOpts = buildProviderRequestOptions(provider);
    const response = await aiScheduler.execute(
      (signal) => ai.chat.completions.create({
        model,
        max_tokens: visionMaxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: screenshot } },
          ],
        }],
        ...ollamaOpts,
      }, { signal }),
      { operation: `generateVisionContext/${provider}`, provider, model, priority: visionPriority, timeoutMs: visionTimeout },
    );
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      };
    }
    return { text: response.choices[0].message.content || "", tokenUsage: usage };
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
    const response = await aiScheduler.execute(
      (signal) => ai.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: visionMaxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType as any, data: base64Data } },
            { type: "text", text: prompt },
          ],
        }],
      }, { signal }),
      { operation: `generateVisionContext/${provider}`, provider, model: "claude-haiku-4-5-20251001", priority: visionPriority, timeoutMs: visionTimeout },
    );
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
    return { text: (response.content[0] as any).text || "", tokenUsage: usage };
  }
  throw new Error("Invalid provider");
}

export async function visionRequest(screenshot: string, activeProvider: string, previousContext?: string | null): Promise<{ visualContext: string; tokenUsage?: TokenUsage }> {
  const apiKey = getApiKey(activeProvider);
  if (!apiKey) throw new Error(`No API key configured for ${activeProvider}. Add it in Settings.`);
  const result = await generateVisionContext(activeProvider, apiKey, screenshot, previousContext);
  return { visualContext: result.text, tokenUsage: result.tokenUsage };
}

export interface RefineParams {
  suggestion: ForgeSuggestion;
  refinementType: string;
  customInstruction?: string;
  streamMetadata: StreamMetadata;
  activeProvider: string;
}

export async function refineSuggestion(params: RefineParams): Promise<{ message: string; why_it_fits: string; tokenUsage?: TokenUsage }> {
  const rawProvider = params.activeProvider || "gemini";
  const provider = normalizeProvider(rawProvider);
  const apiKey = getApiKey(rawProvider);
  if (!apiKey) throw new Error(`No API key configured for ${rawProvider}. Add it in Settings.`);

  const keys = getKeys();

  const userMessageContent = `
ORIGINAL SUGGESTION:
Message: "${params.suggestion.message}"
Profile: "${params.suggestion.profile}"
Tone: "${params.suggestion.tone}"

STREAM METADATA:
Channel: ${params.streamMetadata?.channelName || "Unknown"}
Category: ${params.streamMetadata?.category || "Unknown"}
Title: ${params.streamMetadata?.title || "Unknown"}

REFINEMENT INSTRUCTION:
Type: ${params.refinementType}
Custom Instruction: ${params.customInstruction || "None"}
`;

  let generatedJsonStr = "";
  let usage: any = undefined;
  const refineTimeout = getOperationTimeout("refine", provider);
  const refinePriority: AIRequestPriority = "interactive";
  const refineMaxTokens = getOperationTokenBudget("refine");

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const model = rawProvider === "gemini-pro" ? "gemini-3.7-flash" : "gemini-3.8-flash";
    const response = await aiScheduler.execute(
      (signal) => ai.models.generateContent({
        model,
        contents: userMessageContent,
        config: {
          systemInstruction: REFINE_SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseSchema: refineResponseSchema as any,
          temperature: 0.8,
          maxOutputTokens: refineMaxTokens,
          abortSignal: signal,
        },
      }),
      { operation: `refineSuggestion/${provider}`, provider, model, priority: refinePriority, timeoutMs: refineTimeout },
    );
    generatedJsonStr = response.text || "{}";
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
  } else if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
    const { baseUrl, model } = openAiCompatEndpoint(provider, keys);
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const ollamaOpts = buildProviderRequestOptions(provider);
    const response = await aiScheduler.execute(
      (signal) => ai.chat.completions.create({
        model,
        temperature: 0.8,
        max_tokens: refineMaxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: REFINE_SYSTEM_PROMPT },
          { role: "user", content: userMessageContent },
        ],
        ...ollamaOpts,
      }, { signal }),
      { operation: `refineSuggestion/${provider}`, provider, model, priority: refinePriority, timeoutMs: refineTimeout },
    );
    generatedJsonStr = response.choices[0].message.content || "{}";
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      };
    }
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await aiScheduler.execute(
      (signal) => ai.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: refineMaxTokens,
        temperature: 0.8,
        system: REFINE_SYSTEM_PROMPT + "\n\nYou must output ONLY valid JSON matching the schema format.",
        messages: [{ role: "user", content: userMessageContent }],
      }, { signal }),
      { operation: `refineSuggestion/${provider}`, provider, model: "claude-haiku-4-5-20251001", priority: refinePriority, timeoutMs: refineTimeout },
    );
    generatedJsonStr = (response.content[0] as any).text;
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleanJsonStr(generatedJsonStr));
  } catch (e) {
    console.warn("[refineSuggestion] Failed to parse model JSON, returning original suggestion", e);
    parsed = { ...params.suggestion };
  }
  // Sanitize: coerce string-expected fields to strings so an object value
  // never reaches a React render site (error #31).
  if (parsed.message != null && typeof parsed.message !== "string") {
    parsed.message = typeof parsed.message === "object"
      ? (parsed.message.message ?? parsed.message.message_content ?? JSON.stringify(parsed.message))
      : String(parsed.message);
  }
  if (parsed.why_it_fits != null && typeof parsed.why_it_fits !== "string") {
    parsed.why_it_fits = String(parsed.why_it_fits);
  }
  if (usage) parsed.tokenUsage = usage;
  return parsed;
}

export interface AutoForgeParams {
  streamMetadata: StreamMetadata;
  visualContext?: string;
  recentChatLog?: string;
  audioTranscript?: string;
  longTermContext?: string;
  config: ForgeConfig;
  activeProvider: string;
  lastActionMs?: number | null;
  currentChatActivity?: number;
  chatVelocity?: number;
  activitySpike?: boolean;
  isMentioned?: boolean;
  mentionedLines?: string[];
  contextTokenLimit?: number;
  r34lEnabled?: boolean;
  botUsername?: string;
  force?: boolean;
  memoryContext?: string;
  antiRepetitionContext?: string;
  sentimentContext?: string;
  availableEmotes?: string[];
  /** Emote names tagged with provider+scope (e.g. "monkaS (7tv-channel)").
   *  When provided, the prompt uses this list with provider/scope tags so the
   *  AI knows which emotes are channel-specific (favor) vs global (use sparingly).
   *  Falls back to `availableEmotes` (plain names) when not provided. */
  availableEmotesTagged?: string[];
  botIdentityMode?: "admit" | "custom";
  botIdentityStory?: string;
  audioEnergyLabel?: "silent" | "quiet" | "normal" | "loud" | "spike";
  streamEvents?: string[];
  /** First Message Mode: when true, appends the temporary "arrival" directive
   *  so the bot's next action (short_reaction / emote_only / quick_followup)
   *  or full_forge generation leans toward a natural entrance. Additive only. */
  firstMessageMode?: boolean;
  /** Supercharge Mode (Easter egg): when true, appends a directive telling the
   *  bot to converse with the other bots in the channel — reference them by
   *  name, react to their messages, build on their bits. Additive only. */
  superchargeMode?: boolean;
  /** Supercharge Mode: the list of other active bot usernames in the channel,
   *  so the bot knows who its conversation partners are. */
  fellowBotUsernames?: string[];
  /** Conversation thread context — active reply chains to the bot's messages.
   *  Injected into the decision prompt so the bot knows when it's being
   *  replied to and can maintain coherent multi-turn exchanges. */
  threadContext?: string;
}

export interface AutoForgeBriefingParams {
  events: AutoForgeEvent[];
  streamMetadata: StreamMetadata;
  activeProvider: string;
  config: ForgeConfig;
}

export async function generateAutoForgeBriefing(params: AutoForgeBriefingParams): Promise<{ text: string; tokenUsage?: TokenUsage }> {
  const rawProvider = params.activeProvider || "gemini";
  const provider = normalizeProvider(rawProvider);
  const apiKey = getApiKey(rawProvider);
  if (!apiKey) throw new Error(`No API key configured for ${rawProvider}. Add it in Settings.`);

  const keys = getKeys();

  // Bound the event log: local models can't afford an unbounded prompt.
  // Cap to the most recent 150 events / ~10k chars so Ollama finishes within
  // its timeout instead of choking on a multi-hour event history.
  const boundedEvents = params.events.slice(-150);
  let eventsText = boundedEvents.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString();
    return `[${time}] [${e.type.toUpperCase()}] [${e.severity.toUpperCase()}] ${e.summary}`;
  }).join("\n");
  if (eventsText.length > 10_000) {
    eventsText = eventsText.slice(-10_000);
    eventsText = eventsText.slice(eventsText.indexOf("\n") + 1); // drop partial first line
  }
  const omittedCount = params.events.length - boundedEvents.length;

  const userMessageContent = `You are AutoForge's after-action reporter. The user has returned to their stream and wants a natural-language briefing of what happened while they were away.

STREAM: ${params.streamMetadata?.channelName || "Unknown"} — ${params.streamMetadata?.category || "Unknown"}
TITLE: ${params.streamMetadata?.title || "Unknown"}

EVENT LOG (${params.events.length} events${omittedCount > 0 ? `, showing most recent ${boundedEvents.length}` : ""}):
${eventsText}

Write a concise, engaging briefing (3-6 paragraphs) that covers:
1. Overall summary of what happened (time range, general vibe)
2. Notable interactions and mentions (who said what, how the bot responded)
3. Key moments (spikes, big reactions, funny exchanges)
4. Any errors or issues worth noting
5. A brief "current state" assessment

Write it like a friend catching you up — casual but informative. Don't just list events; synthesize them into a narrative.`;

  const systemPrompt = "You are a concise, engaging narrator. Write a natural-language briefing of AutoForge events. Be specific about what happened, who was involved, and what the bot did. Keep it readable and human — not robotic or listy. Output plain text, no JSON.";

  let usage: TokenUsage | undefined;
  const briefingTimeout = getOperationTimeout("autoforge_briefing", provider);
  const briefingPriority: AIRequestPriority = "interactive";
  const briefingMaxTokens = getOperationTokenBudget("autoforge_briefing");

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const model = rawProvider === "gemini-pro" ? "gemini-3.7-flash" : "gemini-3.8-flash";
    const response = await aiScheduler.execute(
      (signal) => ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: userMessageContent }] }],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          maxOutputTokens: briefingMaxTokens,
          abortSignal: signal,
        },
      }),
      { operation: `generateAutoForgeBriefing/${provider}`, provider, model, priority: briefingPriority, timeoutMs: briefingTimeout },
    );
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
    return { text: response.text || "Unable to generate briefing.", tokenUsage: usage };
  } else if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
    const { baseUrl, model } = openAiCompatEndpoint(provider, keys);
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const ollamaOpts = buildProviderRequestOptions(provider);
    const response = await aiScheduler.execute(
      (signal) => ai.chat.completions.create({
        model,
        temperature: 0.7,
        max_tokens: briefingMaxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessageContent },
        ],
        ...ollamaOpts,
      }, { signal }),
      { operation: `generateAutoForgeBriefing/${provider}`, provider, model, priority: briefingPriority, timeoutMs: briefingTimeout },
    );
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      };
    }
    return { text: response.choices?.[0]?.message?.content || "Unable to generate briefing.", tokenUsage: usage };
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await aiScheduler.execute(
      (signal) => ai.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: briefingMaxTokens,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessageContent }],
      }, { signal }),
      { operation: `generateAutoForgeBriefing/${provider}`, provider, model: "claude-haiku-4-5-20251001", priority: briefingPriority, timeoutMs: briefingTimeout },
    );
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
    return { text: (response.content[0] as any).text || "Unable to generate briefing.", tokenUsage: usage };
  }
  throw new Error("Invalid provider");
}

export async function autoforgeDecide(params: AutoForgeParams): Promise<AutoForgeDecision> {
  const rawProvider = params.activeProvider || "gemini";
  const fallbackChain = getHealthyFallbackChain(rawProvider);
  if (fallbackChain.length === 0) {
    throw new Error(`No API key configured for ${rawProvider}. Add it in Settings.`);
  }

  const keys = getKeys();
  const timeSinceLastAction = params.lastActionMs ? Math.round((Date.now() - params.lastActionMs) / 1000 / 60) : 999;

  const tokenBudget = params.contextTokenLimit ?? 4000;
  const charBudget = tokenBudget * 4;
  const truncate = (text: string, budget: number) => {
    if (!text || text.length <= budget) return text;
    return text.slice(-budget);
  };
  const truncatedChat = truncate(params.recentChatLog, Math.floor(charBudget * 0.4));
  const truncatedAudio = truncate(params.audioTranscript, Math.floor(charBudget * 0.25));
  const truncatedVisual = truncate(params.visualContext, Math.floor(charBudget * 0.2));
  const truncatedLongTerm = truncate(params.longTermContext, Math.floor(charBudget * 0.15));

  const userMessageContent = `
STREAM METADATA:
Channel: ${params.streamMetadata?.channelName || "Unknown"}
Category: ${params.streamMetadata?.category || "Unknown"}
Viewers: ${params.streamMetadata?.viewerCount || 0}
Title: ${params.streamMetadata?.title || "Unknown"}

YOUR IDENTITY:
You are logged in as "${params.botUsername || "Unknown"}". This is your Twitch/Kick handle — when someone mentions this name in chat, they are talking to YOU, not the streamer. The streamer is "${params.streamMetadata?.channelName || "Unknown"}". Do not confuse yourself with the streamer.
${params.superchargeMode && params.fellowBotUsernames && params.fellowBotUsernames.length > 0 ? `\nFELLOW BOT ACCOUNTS (your conversation partners right now): ${params.fellowBotUsernames.join(", ")}. Treat their messages in chat as if they were any other chatter — react to them, reference them by name, build bits with them.\n` : ""}
LIVE SIGNALS:
Time since last action: ${timeSinceLastAction} minutes
Current chat activity level (0-4): ${params.currentChatActivity || 0}
Chat velocity (new lines/min since last check): ${params.chatVelocity || 0}
Activity spike detected: ${params.activitySpike ? "YES — sudden burst of chat activity" : "No"}
You are mentioned/targeted in chat: ${params.isMentioned ? "YES — someone is talking to or about you" : "No"}
${params.isMentioned && params.mentionedLines?.length ? `MENTIONING YOU:\n${params.mentionedLines.join("\n")}` : ""}
${params.audioEnergyLabel ? `Audio energy level: ${params.audioEnergyLabel}${params.audioEnergyLabel === "spike" ? " — sudden loud burst detected" : params.audioEnergyLabel === "silent" ? " — streamer may be silent or away" : params.audioEnergyLabel === "loud" ? " — high energy moment" : ""}` : ""}
${params.streamEvents && params.streamEvents.length > 0 ? `RECENT STREAM EVENTS:\n${params.streamEvents.join("\n")}` : ""}

VISUAL CONTEXT:
${truncatedVisual || "None provided"}

RECENT CHAT LOG:
${truncatedChat || "None provided"}

STREAMER AUDIO TRANSCRIPT:
${truncatedAudio || "None provided"}

LONG-TERM CONTEXT:
${truncatedLongTerm || "None provided"}
${params.memoryContext ? `\n${params.memoryContext}` : ""}
${params.sentimentContext ? `\n${params.sentimentContext}` : ""}
${params.threadContext ? `\n${params.threadContext}` : ""}

ACTIVE CONFIGURATION:
- Primary Profile: ${params.config.primaryProfile && params.config.primaryProfile !== "none" ? params.config.primaryProfile : "None"}
- Active Profiles: ${params.config.activeProfiles && params.config.activeProfiles.length > 0 ? params.config.activeProfiles.join(", ") : "None"}
- Humor Level: ${params.config.humorLevel}/100
- Chaos Level: ${params.config.chaosLevel}/100
- Custom Directives: ${params.config.customDirectives || "None"}
- Additional Instructions: ${params.config.additionalInstructions || "None"}
${params.availableEmotes && params.availableEmotes.length > 0 ? `\nAVAILABLE EMOTES (use these names exactly): ${params.availableEmotes.join(", ")}` : ""}
${params.force ? "\nFORCE MODE: The user has manually forced this action. You MUST generate and send a message. Do NOT choose 'deliberate_silence'. Pick the most contextually appropriate action (full_forge, short_reaction, emote_only, or quick_followup) and provide an action_payload.\n" : ""}
${params.antiRepetitionContext ? `\n\n${params.antiRepetitionContext}` : ""}
DECIDE NOW.`;

  const systemPrompt = AUTOFORGE_SYSTEM_PROMPT + (params.r34lEnabled ? R34L_TYPING_PROMPT + r34lProfileSegment(params.recentChatLog, params.availableEmotes, params.r34lEnabled) : "") + (params.memoryContext ? AUTOFORGE_MEMORY_PROMPT : "") + (params.antiRepetitionContext ? ANTI_REPETITION_PROMPT : "") + (params.sentimentContext ? SENTIMENT_AWARENESS_PROMPT : "") + buildBotIdentityPrompt(params.botIdentityMode || "admit", params.botIdentityStory || "") + (params.firstMessageMode ? FIRST_MESSAGE_DIRECTIVE : "") + (params.superchargeMode ? SUPERCHARGE_DIRECTIVE : "");

  let lastError: Error | null = null;
  let usedFallback = false;
  const decideTimeout = getOperationTimeout("autoforge_decide", normalizeProvider(rawProvider));
  const decidePriority: AIRequestPriority = "autonomous";
  const decideMaxTokens = getOperationTokenBudget("autoforge_decide");

  for (const currentProvider of fallbackChain) {
    const provider = normalizeProvider(currentProvider);
    const apiKey = getApiKey(currentProvider);
    if (!apiKey) continue;

    try {
      let generatedJsonStr = "";
      let usage: TokenUsage | undefined;

      if (provider === "gemini") {
        const ai = new GoogleGenAI({ apiKey });
        const model = currentProvider === "gemini-pro" ? "gemini-3.7-flash" : "gemini-3.8-flash";
        const response = await aiScheduler.execute(
          (signal) => ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: userMessageContent }] }],
            config: {
              systemInstruction: systemPrompt,
              responseMimeType: "application/json",
              responseSchema: autoforgeResponseSchema as any,
              temperature: 0.8,
              maxOutputTokens: decideMaxTokens,
              abortSignal: signal,
            },
          }),
          { operation: `autoforgeDecide/${provider}`, provider: currentProvider, model, priority: decidePriority, timeoutMs: decideTimeout, botId: params.botUsername, channel: params.streamMetadata?.channelName },
        );
        generatedJsonStr = response.text || "{}";
        if (response.usageMetadata) {
          usage = {
            prompt_tokens: response.usageMetadata.promptTokenCount,
            completion_tokens: response.usageMetadata.candidatesTokenCount,
            total_tokens: response.usageMetadata.totalTokenCount,
          };
        }
      } else if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
        const { baseUrl, model } = openAiCompatEndpoint(provider, keys);
        const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
        const ollamaOpts = buildProviderRequestOptions(provider);
        const response = await aiScheduler.execute(
          (signal) => ai.chat.completions.create({
            model,
            temperature: 0.8,
            max_tokens: decideMaxTokens,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessageContent },
            ],
            ...ollamaOpts,
          }, { signal }),
          { operation: `autoforgeDecide/${provider}`, provider: currentProvider, model, priority: decidePriority, timeoutMs: decideTimeout, botId: params.botUsername, channel: params.streamMetadata?.channelName },
        );
        generatedJsonStr = response.choices[0].message.content || "{}";
        if (response.usage) {
          usage = {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          };
        }
      } else if (provider === "claude") {
        const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
        const response = await aiScheduler.execute(
          (signal) => ai.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: decideMaxTokens,
            temperature: 0.8,
            system: systemPrompt + "\n\nYou must output ONLY valid JSON matching the schema format.",
            messages: [{ role: "user", content: userMessageContent }],
          }, { signal }),
          { operation: `autoforgeDecide/${provider}`, provider: currentProvider, model: "claude-haiku-4-5-20251001", priority: decidePriority, timeoutMs: decideTimeout, botId: params.botUsername, channel: params.streamMetadata?.channelName },
        );
        generatedJsonStr = (response.content[0] as any).text;
        if (response.usage) {
          usage = {
            prompt_tokens: response.usage.input_tokens,
            completion_tokens: response.usage.output_tokens,
            total_tokens: response.usage.input_tokens + response.usage.output_tokens,
          };
        }
      }

      // Record success only after we have valid JSON — a malformed response
      // should not mark the provider as healthy
      let result: any;
      try {
        result = JSON.parse(cleanJsonStr(generatedJsonStr));
      } catch (e) {
        // Truncation/malformation fallback: attempt to repair the JSON so
        // we can still surface the decision. Without this, a single bad
        // response crashes the entire bot cycle.
        const repaired = repairTruncatedJson(generatedJsonStr || "");
        try {
          result = JSON.parse(repaired);
          console.warn("[autoforgeDecide] Model JSON was malformed — salvaged via repair. Original error:", (e as Error).message);
        } catch (e2) {
          console.warn("[autoforgeDecide] Failed to parse model JSON.", e, "\nRaw output:", generatedJsonStr?.slice(0, 500));
          throw new Error("Model returned malformed JSON — the provider may be overloaded or the response was truncated.");
        }
      }
      // Sanitize: some models (especially smaller Ollama ones) return
      // action_payload as a nested object {decision, message_content} or use
      // `message_content` as the key name instead of `action_payload`. Both
      // would flow through to the HUD and crash React with error #31
      // ("Objects are not valid as a React child") when rendered as a child.
      // Coerce all string-expected fields and alias message_content → action_payload.
      if (result.action_payload == null && typeof result.message_content === "string") {
        result.action_payload = result.message_content;
      }
      if (result.action_payload != null && typeof result.action_payload !== "string") {
        result.action_payload = typeof result.action_payload === "object"
          ? (result.action_payload.message_content ?? result.action_payload.message ?? JSON.stringify(result.action_payload))
          : String(result.action_payload);
      }
      if (result.reason != null && typeof result.reason !== "string") {
        result.reason = String(result.reason);
      }
      if (result.decision != null && typeof result.decision !== "string") {
        result.decision = String(result.decision);
      }
      if (result.suggested_trigger != null && typeof result.suggested_trigger !== "string") {
        result.suggested_trigger = String(result.suggested_trigger);
      }
      recordProviderSuccess(currentProvider);
      if (usedFallback && currentProvider !== rawProvider) {
        result.used_fallback_provider = currentProvider;
      }
      if (usage) {
        result.tokenUsage = usage;
      }
      return result;
    } catch (e: any) {
      // Preemption/cancellation is terminal for this decide cycle — the
      // scheduler yielded our inference slot on purpose (e.g. a higher-
      // priority interactive request arrived). Do NOT reroute the work to a
      // fallback provider; that would defeat the yield. Rethrow so the caller
      // can reschedule quietly.
      if (isSchedulerCancellation(e)) throw e;
      // Queue timeout: the request waited too long for the Ollama slot (too
      // many bots queued). This is a capacity issue, NOT a provider failure —
      // don't poison provider health or trigger cooldown. Rethrow so the
      // caller can reschedule quietly (same as preemption).
      if (isQueueTimeout(e)) throw e;
      // JSON parse errors: the provider successfully returned a response, but
      // the model produced malformed JSON. This is a model quality issue, NOT
      // a provider connectivity/health issue — don't poison provider health
      // or trigger cooldown. Rethrow so the caller can reschedule.
      if (e instanceof SyntaxError) throw e;
      recordProviderFailure(currentProvider);
      lastError = e;
      usedFallback = true;
      console.warn(`[AutoForge] Provider ${currentProvider} failed: ${e.message}`);
      // D3: Record fallback for analytics
      const nextProvider = fallbackChain[fallbackChain.indexOf(currentProvider) + 1];
      if (nextProvider) {
        recordFallback(currentProvider, nextProvider, e.message || "Provider error");
      }
      continue;
    }
  }

  throw lastError || new Error("All AI providers failed or are unavailable.");
}
