/**
 * Independent vision provider resolver.
 *
 * MADchatter's text generation and screenshot interpretation used to share one
 * provider. This module centralizes the *effective* vision configuration so a
 * user can run, e.g., Groq for text while a local Ollama instance interprets
 * screenshots — without the screenshot ever reaching the cloud text provider.
 *
 * Conceptual modes:
 *  - "text"  : vision is routed through the currently selected text provider
 *              (backward-compatible default; preserves all legacy behavior).
 *  - "ollama": vision is routed through a separately configured local Ollama
 *              endpoint + image-capable model. Text generation is unaffected.
 *
 * The resolver is the single chokepoint every vision call site uses. It never
 * mutates text-provider configuration and never falls back to a cloud provider
 * for image analysis when independent Ollama vision is selected.
 */
import { useAppStore } from "../store";
import { getActiveProvider, getApiKey, getKeys, openAiCompatEndpoint } from "./keys";

/** User-selectable vision routing mode. */
export type VisionMode = "text" | "ollama";

/** Default Ollama endpoint for independent vision. Matches the text-provider
 *  Ollama default so a user who already runs Ollama for text can point vision
 *  at the same server without re-typing. */
export const DEFAULT_VISION_OLLAMA_BASE_URL = "http://localhost:11434/v1";

/** Resolved vision configuration — the effective settings a vision request
 *  should use, regardless of which text provider is active. */
export interface VisionConfig {
  /** Effective mode after applying configuration completeness. When the user
   *  picks "ollama" but hasn't set a base URL or model, this degrades to
   *  "text" so vision still works through the text provider rather than
   *  silently failing. The UI surfaces the incomplete configuration. */
  mode: VisionMode;
  /** The provider id the vision request should dispatch through. Either
   *  "ollama" (independent) or the active text provider id. */
  provider: string;
  /** Base URL for the OpenAI-compatible vision request. Undefined for
   *  providers that use the SDK default (plain OpenAI / Gemini / Claude). */
  baseUrl?: string;
  /** Model id for the vision request. */
  model?: string;
  /** API key (or sentinel) for the vision provider. Null when unconfigured. */
  apiKey: string | null;
  /** True when the user's *preferred* mode is "ollama" (before completeness
   *  degradation). Use this to surface "configuration incomplete" in the UI. */
  prefersOllama: boolean;
  /** True when independent Ollama vision is fully configured and active —
   *  i.e. the screenshot must NOT be attached to text-provider requests. */
  independent: boolean;
  /** True when the independent Ollama endpoint + model are both set. */
  ollamaConfigured: boolean;
}

/** Read the user's preferred vision mode from the store (default "text"). */
export function getVisionMode(): VisionMode {
  const mode = useAppStore.getState().visionProvider;
  return mode === "ollama" ? "ollama" : "text";
}

/** Read the independent Ollama vision endpoint base URL. */
export function getVisionOllamaBaseUrl(): string {
  return useAppStore.getState().visionOllamaBaseUrl || DEFAULT_VISION_OLLAMA_BASE_URL;
}

/** Read the independent Ollama vision model id. */
export function getVisionOllamaModel(): string {
  return useAppStore.getState().visionOllamaModel || "";
}

/** True when the user selected Ollama vision AND set both endpoint + model. */
export function isOllamaVisionConfigured(): boolean {
  return getVisionMode() === "ollama" && !!getVisionOllamaBaseUrl().trim() && !!getVisionOllamaModel().trim();
}

/** True when independent Ollama vision is fully configured and active.
 *  When this returns true, screenshots must NOT be attached to text-provider
 *  requests — the textual observation from Ollama is the only visual signal
 *  the text provider should receive. */
export function isIndependentVisionActive(): boolean {
  return isOllamaVisionConfigured();
}

/**
 * Resolve the effective vision configuration for a screenshot analysis call.
 *
 * - When independent Ollama vision is configured: returns the Ollama endpoint
 *   + model + dummy key. The active text provider is never consulted.
 * - Otherwise: returns the active text provider's configuration so vision
 *   flows through it exactly as before this module existed.
 *
 * This function never throws. Callers handle a null `apiKey` by surfacing an
 * actionable "vision not configured" status.
 */
export function resolveVisionConfig(): VisionConfig {
  const prefersOllama = getVisionMode() === "ollama";
  const ollamaBaseUrl = getVisionOllamaBaseUrl().trim();
  const ollamaModel = getVisionOllamaModel().trim();
  const ollamaConfigured = prefersOllama && !!ollamaBaseUrl && !!ollamaModel;

  if (ollamaConfigured) {
    return {
      mode: "ollama",
      provider: "ollama",
      baseUrl: ollamaBaseUrl,
      model: ollamaModel,
      apiKey: "ollama-local",
      prefersOllama: true,
      independent: true,
      ollamaConfigured: true,
    };
  }

  // Degrade to the text provider. This covers both "text" mode and the
  // incomplete-Ollama case (user picked Ollama but hasn't filled in the
  // endpoint/model yet). The UI surfaces the incomplete configuration; the
  // runtime keeps vision working through the text provider rather than
  // silently dropping it.
  const textProvider = getActiveProvider();
  const textApiKey = getApiKey(textProvider);
  let baseUrl: string | undefined;
  let model: string | undefined;
  // OpenAI-compatible text providers carry an explicit base URL + model.
  // Gemini / Claude / plain OpenAI use SDK defaults (baseUrl undefined).
  const keys = getKeys();
  try {
    const endpoint = openAiCompatEndpoint(textProvider, keys);
    baseUrl = endpoint.baseUrl;
    model = endpoint.model;
  } catch {
    // openAiCompatEndpoint throws for unknown providers; leave undefined.
  }
  return {
    mode: "text",
    provider: textProvider,
    baseUrl,
    model,
    apiKey: textApiKey,
    prefersOllama,
    independent: false,
    ollamaConfigured,
  };
}

/** The provider id a vision request should dispatch through. */
export function resolveVisionProvider(): string {
  return resolveVisionConfig().provider;
}

/** The API key (or sentinel) for the vision provider. Null when unconfigured. */
export function resolveVisionApiKey(): string | null {
  return resolveVisionConfig().apiKey;
}

/**
 * Resolve the OpenAI-compatible base URL + model for an independent Ollama
 * vision request. Returns null when independent vision is not active.
 */
export function resolveIndependentOllamaEndpoint(): { baseUrl: string; model: string } | null {
  if (!isIndependentVisionActive()) return null;
  return { baseUrl: getVisionOllamaBaseUrl().trim(), model: getVisionOllamaModel().trim() };
}

/** Runtime revision that bumps whenever the vision configuration changes.
 *  Vision capture captures this to discard results produced by superseded
 *  settings (e.g. endpoint/model/provider change mid-flight). Runtime-only —
 *  never persisted. */
export function getVisionConfigRevision(): number {
  return useAppStore.getState().visionConfigRevision;
}
