import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, getKeys } from "./keys";
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
} from "./prompts";
import {
  getHealthyFallbackChain,
  recordProviderFailure,
  recordProviderSuccess,
  isProviderAvailable,
} from "./providerFallback";

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
}

export async function generateChat(params: GenerateChatParams): Promise<any> {
  const rawProvider = params.activeProvider || "gemini";
  const provider = normalizeProvider(rawProvider);
  const apiKey = getApiKey(rawProvider);
  if (!apiKey) throw new Error(`No API key configured for ${rawProvider}. Add it in Settings.`);

  const keys = getKeys();
  const session = getTwitchSession();

  let currentVisualContext = params.visualContext;
  if (params.screenshot && (!params.visualContext || params.visualContext.length < 50)) {
    try {
      currentVisualContext = await generateVisionContext(rawProvider, apiKey, params.screenshot);
    } catch (e) {
      console.warn("Auto-vision failed, continuing without it", e);
    }
  }

  const effort = params.config?.effortLevel || "medium";
  let effortDirective = "";
  let maxTokensToUse = 1536;
  let temp = 0.7;

  if (effort === "low") {
    maxTokensToUse = 512;
    temp = 0.5;
    effortDirective = "\nEFFORT LEVEL REQUIRED: MINIMAL. Generate fast, extremely snappy, and lightweight suggestions. Keep analysis brief and concise. Minimize computation.";
  } else if (effort === "high") {
    maxTokensToUse = 3072;
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
You are logged in as "${params.botUsername || "Unknown"}". This is your Twitch/Kick handle — when someone mentions this name in chat, they are talking to YOU, not the streamer. The streamer is "${params.streamMetadata?.channelName || "Unknown"}. Do not confuse yourself with the streamer.

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
- Humor Level: ${params.config.humorLevel}/100
- Chaos Level: ${params.config.chaosLevel}/100
- Length: ${params.config.lengthPreference && params.config.lengthPreference !== "none" ? params.config.lengthPreference : "Unconstrained (No length mask. Let the word/sentence count vary naturally based on what's contextually appropriate)"}
- Emote Density: ${params.config.emoteDensity}
- Toxicity Filter: ${params.config.toxicityFilter || "standard"}
- Voice Context Enabled: ${params.config.voiceContextEnabled}
- Generation Mode: ${params.config.generationMode}
- Additional Instructions: ${params.config.additionalInstructions || "None"}
${effortDirective}
${params.count ? `\nEXACT OUTPUT COUNT: You must generate exactly ${params.count} suggestion${params.count > 1 ? "s" : ""}. Do not generate more or fewer than ${params.count}.` : ""}`;

  const systemPrompt = FORGE_SYSTEM_PROMPT + (params.r34lEnabled ? R34L_TYPING_PROMPT : "") + (params.memoryContext ? MEMORY_AWARENESS_PROMPT : "") + (params.sentimentContext ? SENTIMENT_AWARENESS_PROMPT : "");
  let generatedJsonStr = "";
  let usage: any = undefined;

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const parts: any[] = [{ text: userMessageContent }];
    if (params.screenshot) {
      const mimeType = params.screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
      const base64Data = params.screenshot.replace(/^data:image\/\w+;base64,/, "");
      parts.push({ inlineData: { data: base64Data, mimeType } });
    }
    const model = rawProvider === "gemini-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: responseSchema as any,
        temperature: temp,
        maxOutputTokens: maxTokensToUse,
      },
    });
    generatedJsonStr = response.text || "{}";
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
  } else if (provider === "openai" || provider === "openrouter") {
    const baseUrl = provider === "openrouter" ? keys.customBaseUrl || "https://openrouter.ai/api/v1" : undefined;
    const model = provider === "openrouter" ? keys.customModel || "google/gemini-2.5-flash" : "gpt-4o";
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const content: any[] = [{ type: "text", text: userMessageContent }];
    if (params.screenshot) {
      content.push({ type: "image_url", image_url: { url: params.screenshot } });
    }
    const response = await ai.chat.completions.create({
      model,
      temperature: temp,
      max_tokens: maxTokensToUse,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    });
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
    const response = await ai.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: maxTokensToUse,
      temperature: temp,
      system: systemPrompt + "\n\nYou must output ONLY valid JSON matching the schema format.",
      messages: [{ role: "user", content }],
    });
    generatedJsonStr = (response.content[0] as any).text;
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
  }

  const parsedResponse = JSON.parse(cleanJsonStr(generatedJsonStr));

  if (currentVisualContext && currentVisualContext !== params.visualContext) {
    parsedResponse.visualContext = currentVisualContext;
  }
  if (usage) {
    parsedResponse.tokenUsage = usage;
  }

  return parsedResponse;
}

export async function generateVisionContext(
  rawProvider: string,
  apiKey: string,
  screenshot: string,
  previousContext?: string | null
): Promise<string> {
  const provider = normalizeProvider(rawProvider);
  const keys = getKeys();
  const prompt = previousContext
    ? `You are watching a live stream. Your previous observation was: "${previousContext}". Here is a new screenshot. Describe what has CHANGED since your last observation — new events, state changes, movement, text changes. If nothing meaningful changed, say "No significant change." Keep it concise.`
    : "Describe this live stream screenshot in detail: game state, on-screen text/elements, streamer activity/expression, and overall energy/vibe. Keep it concise but specific.";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
    const model = rawProvider === "gemini-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    const response = await ai.models.generateContent({
      model,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { data: base64Data, mimeType } },
        ],
      }],
    });
    return response.text || "";
  } else if (provider === "openai" || provider === "openrouter") {
    const baseUrl = provider === "openrouter" ? keys.customBaseUrl || "https://openrouter.ai/api/v1" : undefined;
    const model = provider === "openrouter" ? keys.customModel || "google/gemini-2.5-flash" : "gpt-4o";
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const response = await ai.chat.completions.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: screenshot } },
        ],
      }],
    });
    return response.choices[0].message.content || "";
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || "image/jpeg";
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
    const response = await ai.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType as any, data: base64Data } },
          { type: "text", text: prompt },
        ],
      }],
    });
    return (response.content[0] as any).text;
  }
  throw new Error("Invalid provider");
}

export async function visionRequest(screenshot: string, activeProvider: string, previousContext?: string | null): Promise<{ visualContext: string }> {
  const apiKey = getApiKey(activeProvider);
  if (!apiKey) throw new Error(`No API key configured for ${activeProvider}. Add it in Settings.`);
  const visualContext = await generateVisionContext(activeProvider, apiKey, screenshot, previousContext);
  return { visualContext };
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

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const model = rawProvider === "gemini-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    const response = await ai.models.generateContent({
      model,
      contents: userMessageContent,
      config: {
        systemInstruction: REFINE_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: refineResponseSchema as any,
        temperature: 0.8,
      },
    });
    generatedJsonStr = response.text || "{}";
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
  } else if (provider === "openai" || provider === "openrouter") {
    const baseUrl = provider === "openrouter" ? keys.customBaseUrl || "https://openrouter.ai/api/v1" : undefined;
    const model = provider === "openrouter" ? keys.customModel || "google/gemini-2.5-flash" : "gpt-4o";
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const response = await ai.chat.completions.create({
      model,
      temperature: 0.8,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: REFINE_SYSTEM_PROMPT },
        { role: "user", content: userMessageContent },
      ],
    });
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
    const response = await ai.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      temperature: 0.8,
      system: REFINE_SYSTEM_PROMPT + "\n\nYou must output ONLY valid JSON matching the schema format.",
      messages: [{ role: "user", content: userMessageContent }],
    });
    generatedJsonStr = (response.content[0] as any).text;
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
  }

  const parsed = JSON.parse(cleanJsonStr(generatedJsonStr));
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
}

export interface AutoForgeBriefingParams {
  events: AutoForgeEvent[];
  streamMetadata: StreamMetadata;
  activeProvider: string;
  config: ForgeConfig;
}

export async function generateAutoForgeBriefing(params: AutoForgeBriefingParams): Promise<string> {
  const rawProvider = params.activeProvider || "gemini";
  const provider = normalizeProvider(rawProvider);
  const apiKey = getApiKey(rawProvider);
  if (!apiKey) throw new Error(`No API key configured for ${rawProvider}. Add it in Settings.`);

  const keys = getKeys();

  const eventsText = params.events.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString();
    return `[${time}] [${e.type.toUpperCase()}] [${e.severity.toUpperCase()}] ${e.summary}`;
  }).join("\n");

  const userMessageContent = `You are AutoForge's after-action reporter. The user has returned to their stream and wants a natural-language briefing of what happened while they were away.

STREAM: ${params.streamMetadata?.channelName || "Unknown"} — ${params.streamMetadata?.category || "Unknown"}
TITLE: ${params.streamMetadata?.title || "Unknown"}

EVENT LOG (${params.events.length} events):
${eventsText}

Write a concise, engaging briefing (3-6 paragraphs) that covers:
1. Overall summary of what happened (time range, general vibe)
2. Notable interactions and mentions (who said what, how the bot responded)
3. Key moments (spikes, big reactions, funny exchanges)
4. Any errors or issues worth noting
5. A brief "current state" assessment

Write it like a friend catching you up — casual but informative. Don't just list events; synthesize them into a narrative.`;

  const systemPrompt = "You are a concise, engaging narrator. Write a natural-language briefing of AutoForge events. Be specific about what happened, who was involved, and what the bot did. Keep it readable and human — not robotic or listy. Output plain text, no JSON.";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const model = rawProvider === "gemini-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userMessageContent }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    });
    return response.text || "Unable to generate briefing.";
  } else if (provider === "openai" || provider === "openrouter") {
    const baseUrl = provider === "openrouter" ? keys.customBaseUrl || "https://openrouter.ai/api/v1" : undefined;
    const model = provider === "openrouter" ? keys.customModel || "google/gemini-2.5-flash" : "gpt-4o";
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const response = await ai.chat.completions.create({
      model,
      temperature: 0.7,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessageContent },
      ],
    });
    return response.choices[0].message.content || "Unable to generate briefing.";
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await ai.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 1024,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessageContent }],
    });
    return (response.content[0] as any).text || "Unable to generate briefing.";
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
You are logged in as "${params.botUsername || "Unknown"}". This is your Twitch/Kick handle — when someone mentions this name in chat, they are talking to YOU, not the streamer. The streamer is "${params.streamMetadata?.channelName || "Unknown"}. Do not confuse yourself with the streamer.

LIVE SIGNALS:
Time since last action: ${timeSinceLastAction} minutes
Current chat activity level (0-4): ${params.currentChatActivity || 0}
Chat velocity (new lines/min since last check): ${params.chatVelocity || 0}
Activity spike detected: ${params.activitySpike ? "YES — sudden burst of chat activity" : "No"}
You are mentioned/targeted in chat: ${params.isMentioned ? "YES — someone is talking to or about you" : "No"}
${params.isMentioned && params.mentionedLines?.length ? `MENTIONING YOU:\n${params.mentionedLines.join("\n")}` : ""}

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

ACTIVE CONFIGURATION:
- Humor Level: ${params.config.humorLevel}/100
- Chaos Level: ${params.config.chaosLevel}/100
${params.force ? "\nFORCE MODE: The user has manually forced this action. You MUST generate and send a message. Do NOT choose 'deliberate_silence'. Pick the most contextually appropriate action (full_forge, short_reaction, emote_only, or quick_followup) and provide an action_payload.\n" : ""}
${params.antiRepetitionContext ? `\n\n${params.antiRepetitionContext}` : ""}
DECIDE NOW.`;

  const systemPrompt = AUTOFORGE_SYSTEM_PROMPT + (params.r34lEnabled ? R34L_TYPING_PROMPT : "") + (params.memoryContext ? AUTOFORGE_MEMORY_PROMPT : "") + (params.antiRepetitionContext ? ANTI_REPETITION_PROMPT : "") + (params.sentimentContext ? SENTIMENT_AWARENESS_PROMPT : "");

  let lastError: Error | null = null;
  let usedFallback = false;

  for (const currentProvider of fallbackChain) {
    const provider = normalizeProvider(currentProvider);
    const apiKey = getApiKey(currentProvider);
    if (!apiKey) continue;

    try {
      let generatedJsonStr = "";

      if (provider === "gemini") {
        const ai = new GoogleGenAI({ apiKey });
        const model = currentProvider === "gemini-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: userMessageContent }] }],
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: "application/json",
            responseSchema: autoforgeResponseSchema as any,
            temperature: 0.8,
          },
        });
        generatedJsonStr = response.text || "{}";
      } else if (provider === "openai" || provider === "openrouter") {
        const baseUrl = provider === "openrouter" ? keys.customBaseUrl || "https://openrouter.ai/api/v1" : undefined;
        const model = provider === "openrouter" ? keys.customModel || "google/gemini-2.5-flash" : "gpt-4o";
        const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
        const response = await ai.chat.completions.create({
          model,
          temperature: 0.8,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessageContent },
          ],
        });
        generatedJsonStr = response.choices[0].message.content || "{}";
      } else if (provider === "claude") {
        const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
        const response = await ai.messages.create({
          model: "claude-3-7-sonnet-20250219",
          max_tokens: 1024,
          temperature: 0.8,
          system: systemPrompt + "\n\nYou must output ONLY valid JSON matching the schema format.",
          messages: [{ role: "user", content: userMessageContent }],
        });
        generatedJsonStr = (response.content[0] as any).text;
      }

      recordProviderSuccess(currentProvider);
      const result = JSON.parse(cleanJsonStr(generatedJsonStr));
      if (usedFallback && currentProvider !== rawProvider) {
        result.used_fallback_provider = currentProvider;
      }
      return result;
    } catch (e: any) {
      recordProviderFailure(currentProvider);
      lastError = e;
      usedFallback = true;
      console.warn(`[AutoForge] Provider ${currentProvider} failed: ${e.message}. Trying fallback...`);
      continue;
    }
  }

  throw lastError || new Error("All AI providers failed or are unavailable.");
}
