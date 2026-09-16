import React, { useState, useEffect, useRef } from "react";
import { ForgeConfig, TwitchUser } from "../types";
import {
  Terminal,
  Key,
  Check,
  AlertCircle,
  X,
  Sliders,
  Hash,
  Globe,
  Bot,
  Copy,
  Wand2,
  Plug,
  Loader2,
  RefreshCw,
  Zap,
  ScanEye,
  Sparkles,
} from "lucide-react";
import { cn } from "../lib/utils";
import { getKeys, saveKeys, getActiveProvider, setActiveProvider, getProviderWithKey, getApiKey, CUSTOM_OPENAI_PROVIDER, TRIAL_PROVIDER } from "../lib/keys";
import { fetchAvailableModels, testProviderConnection, suggestBaseUrlFromLabel, isPresetOrDefaultUrl, type ConnectionTestResult } from "../lib/customProvider";
import {
  getTrialWorkerUrl, setTrialWorkerUrl, getTrialTurnstileSiteKey, setTrialTurnstileSiteKey,
  isTrialSessionValid, clearTrialSession, setTrialSession,
  fetchTrialStatus, createTrialSession, loadTurnstileScript, renderTurnstile, removeTurnstile,
  TURNSTILE_TEST_SITE_KEY, type TrialStatus,
} from "../lib/trial";
import { getTwitchClientId, setTwitchClientId } from "../lib/twitch";
import { getKickClientId, setKickClientId } from "../lib/kick";
import { getJoystickClientId, setJoystickClientId, getJoystickClientSecret, setJoystickClientSecret, getJoystickBotUsername, setJoystickBotUsername } from "../lib/joystick";
import { playSfx } from "../lib/sfx";
import { ThemedTooltip } from "./ui/tooltip";
import { useAppStore } from "../store";
import { checkOllamaHealth, invalidateOllamaHealthCache, type OllamaHealthResult } from "../lib/ollamaHealth";

interface SettingsPanelProps {
  variant: "config" | "keys" | "full";
  config: ForgeConfig;
  setConfig: React.Dispatch<React.SetStateAction<ForgeConfig>>;
  user: TwitchUser | null;
  loginWithDevToken: (token: string, username: string) => void;
  addToast: (msg: string, type: "success" | "error") => void;
}

export function SettingsPanel({
  variant,
  config,
  setConfig,
  user,
  loginWithDevToken,
  addToast,
}: SettingsPanelProps) {
  const showKeys = variant === "keys" || variant === "full";
  const showConfig = variant === "config" || variant === "full";
  const synthesisEnabled = useAppStore((s) => s.roomModelSynthesisEnabled);
  const setSynthesisEnabled = useAppStore((s) => s.setRoomModelSynthesisEnabled);
  const episodicEnabled = useAppStore((s) => s.episodicMemoryEnabled);
  const setEpisodicEnabled = useAppStore((s) => s.setEpisodicMemoryEnabled);

  const [activeProvider, setActiveProviderState] = useState<
    "gemini" | "gemini-pro" | "gemini-env" | "openai" | "claude" | "openrouter" | "ollama" | "custom-openai" | "trial"
  >("gemini");
  const [keys, setKeys] = useState({
    geminiKey: "",
    chatGptKey: "",
    claudeKey: "",
    deepgramKey: "",
    openRouterKey: "",
    customBaseUrl: "",
    customModel: "",
    customOpenAIKey: "",
    customOpenAIBaseUrl: "",
    customOpenAIModel: "",
    customOpenAILabel: "",
  });
  const [savingKeys, setSavingKeys] = useState(false);
  const [keysSavedState, setKeysSavedState] = useState(false);

  // Custom OpenAI-compatible provider: model loading + connection testing state.
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<ConnectionTestResult | null>(null);

  // Independent vision provider state (v26). Read from the store so the UI
  // stays in sync with runtime changes. Vision config is a user preference
  // (not a credential), so it lives in the persisted store — not in keys.ts.
  const visionProvider = useAppStore((s) => s.visionProvider);
  const visionOllamaBaseUrl = useAppStore((s) => s.visionOllamaBaseUrl);
  const visionOllamaModel = useAppStore((s) => s.visionOllamaModel);
  const setVisionProvider = useAppStore((s) => s.setVisionProvider);
  const setVisionOllamaBaseUrl = useAppStore((s) => s.setVisionOllamaBaseUrl);
  const setVisionOllamaModel = useAppStore((s) => s.setVisionOllamaModel);
  const [visionHealth, setVisionHealth] = useState<OllamaHealthResult | null>(null);
  const [visionChecking, setVisionChecking] = useState(false);

  const [devUsername, setDevUsername] = useState("");
  const [devToken, setDevToken] = useState("");

  // Friend Trial state.
  const trialTick = useAppStore((s) => s.trialTick);
  const bumpTrialTick = useAppStore((s) => s.bumpTrialTick);
  const trialStatus = useAppStore((s) => s.trialStatus);
  const setTrialStatusState = useAppStore((s) => s.setTrialStatus);
  const [trialWorkerUrl, setTrialWorkerUrlState] = useState(getTrialWorkerUrl());
  const [trialSiteKey, setTrialSiteKeyState] = useState(getTrialTurnstileSiteKey());
  const [trialInviteCode, setTrialInviteCode] = useState("");
  const [trialActivating, setTrialActivating] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const trialSessionValid = isTrialSessionValid();

  const [twitchClientId, setTwitchClientIdState] = useState("");
  const [kickClientId, setKickClientIdState] = useState("");
  const [joystickClientId, setJoystickClientIdState] = useState("");
  const [joystickClientSecret, setJoystickClientSecretState] = useState("");
  const [joystickBotUsername, setJoystickBotUsernameState] = useState("");

  useEffect(() => {
    const savedProvider = getActiveProvider();
    if (
      savedProvider &&
      ["gemini", "gemini-pro", "gemini-env", "openai", "claude", "openrouter", "ollama", "custom-openai", "trial"].includes(savedProvider)
    ) {
      setActiveProviderState(savedProvider as any);
    }

    const storedKeys = getKeys();
    setKeys(storedKeys);
    if (storedKeys.deepgramKey) {
      localStorage.setItem("VITE_DEEPGRAM_API_KEY", storedKeys.deepgramKey);
    }

    if (!getApiKey(savedProvider)) {
      const providerWithKey = getProviderWithKey();
      if (providerWithKey) {
        setActiveProviderState(providerWithKey as any);
        setActiveProvider(providerWithKey);
      }
    }

    setTwitchClientIdState(getTwitchClientId());
    setKickClientIdState(getKickClientId());
    setJoystickClientIdState(getJoystickClientId());
    setJoystickClientSecretState(getJoystickClientSecret());
    setJoystickBotUsernameState(getJoystickBotUsername());
  }, [user]);

  const handleProviderSelect = (p: "gemini" | "openai" | "claude" | "openrouter" | "ollama" | "custom-openai" | "trial") => {
    setActiveProviderState(p);
    setActiveProvider(p);
    // Selecting Ollama pre-fills the local endpoint + a default model tag so the
    // user doesn't have to know the URL. They can still edit both fields after.
    if (p === "ollama") {
      setKeys((k) => ({
        ...k,
        customBaseUrl: k.customBaseUrl || "http://localhost:11434/v1",
        customModel: k.customModel || "qwen3.5:9b",
      }));
    }
    // Reset connection-test state when switching away from the custom provider.
    if (p !== "custom-openai") {
      setConnResult(null);
      setCustomModels([]);
    }
  };

  // ── Custom OpenAI-compatible: load models from GET /models ──────────────
  const handleLoadCustomModels = async () => {
    setLoadingModels(true);
    setConnResult(null);
    try {
      const result = await fetchAvailableModels({
        baseUrl: keys.customOpenAIBaseUrl,
        apiKey: keys.customOpenAIKey,
      });
      if (result.ok && result.models.length > 0) {
        setCustomModels(result.models);
        addToast(`Loaded ${result.models.length} models`, "success");
      } else {
        setCustomModels([]);
        addToast(result.message || "No models found — enter a model manually.", "error");
      }
    } finally {
      setLoadingModels(false);
    }
  };

  // ── Custom OpenAI-compatible: test connection ───────────────────────────
  const handleTestCustomConnection = async () => {
    setTestingConn(true);
    setConnResult(null);
    try {
      const result = await testProviderConnection({
        baseUrl: keys.customOpenAIBaseUrl,
        apiKey: keys.customOpenAIKey,
        model: keys.customOpenAIModel,
      });
      setConnResult(result);
      if (result.models.length > 0) setCustomModels(result.models);
      addToast(result.message, result.ok ? "success" : "error");
    } finally {
      setTestingConn(false);
    }
  };

  // Test the independent Ollama vision endpoint + model. This checks that the
  // endpoint is reachable and the model is listed — it does NOT verify image
  // analysis works (a text-only model can pass this check). The status line
  // distinguishes "ready" (model listed) from "model_unavailable" and
  // "endpoint_unreachable" so the user gets actionable feedback. A full image
  // analysis test happens on the first real capture.
  const handleTestVisionModel = async () => {
    const baseUrl = visionOllamaBaseUrl.trim();
    const model = visionOllamaModel.trim();
    if (!baseUrl || !model) {
      setVisionHealth(null);
      addToast("Set a base URL and model first", "error");
      return;
    }
    setVisionChecking(true);
    setVisionHealth(null);
    invalidateOllamaHealthCache();
    try {
      const result = await checkOllamaHealth(baseUrl, model, true);
      setVisionHealth(result);
      addToast(
        result.state === "ready" ? `Model "${model}" is available` : result.error || `Model "${model}" not found`,
        result.state === "ready" ? "success" : "error",
      );
    } finally {
      setVisionChecking(false);
    }
  };

  const handleKeyChange = (keyField: "geminiKey" | "chatGptKey" | "claudeKey" | "openRouterKey", value: string) => {
    setKeys((k) => ({ ...k, [keyField]: value }));
    // Auto-select provider when first key is entered and current provider has no key
    if (value.trim()) {
      const currentProvider = getActiveProvider();
      if (!getApiKey(currentProvider)) {
        const providerMap: Record<string, string> = {
          geminiKey: "gemini",
          chatGptKey: "openai",
          claudeKey: "claude",
          openRouterKey: "openrouter",
        };
        const newProvider = providerMap[keyField];
        if (newProvider && newProvider !== currentProvider) {
          setActiveProviderState(newProvider as any);
          setActiveProvider(newProvider);
        }
      }
    }
  };

  const saveKeysHandler = async () => {
    setSavingKeys(true);

    saveKeys({
      geminiKey: keys.geminiKey,
      chatGptKey: keys.chatGptKey,
      claudeKey: keys.claudeKey,
      deepgramKey: keys.deepgramKey,
      openRouterKey: keys.openRouterKey,
      customBaseUrl: keys.customBaseUrl,
      customModel: keys.customModel,
      customOpenAIKey: keys.customOpenAIKey,
      customOpenAIBaseUrl: keys.customOpenAIBaseUrl,
      customOpenAIModel: keys.customOpenAIModel,
      customOpenAILabel: keys.customOpenAILabel,
    });

    const currentActive = getActiveProvider();
    if (!getApiKey(currentActive)) {
      const providerWithKey = getProviderWithKey();
      if (providerWithKey) {
        setActiveProviderState(providerWithKey as any);
        setActiveProvider(providerWithKey);
      }
    }

    setTwitchClientId(twitchClientId);
    setKickClientId(kickClientId);
    setJoystickClientId(joystickClientId);
    setJoystickClientSecret(joystickClientSecret);
    setJoystickBotUsername(joystickBotUsername);

    setSavingKeys(false);
    setKeysSavedState(true);
    playSfx('settings_save');
    addToast("API Keys saved successfully.", "success");
    setTimeout(() => setKeysSavedState(false), 2000);
  };

  // ── Friend Trial activation ───────────────────────────────────────────────
  const handleTrialActivate = async () => {
    setTrialError(null);
    const workerUrl = trialWorkerUrl.trim().replace(/\/+$/, "");
    if (!workerUrl) {
      setTrialError("Set the Friend Trial Worker URL first.");
      return;
    }
    setTrialWorkerUrl(workerUrl);
    setTrialActivating(true);
    try {
      // Check trial availability.
      const status = await fetchTrialStatus(workerUrl);
      setTrialStatusState(status);
      if (!status.enabled) {
        setTrialError(status.reason === "ENDED" ? "Friend Trial has ended." : "Friend Trial is currently unavailable.");
        setTrialActivating(false);
        return;
      }
      // Render Turnstile and wait for token.
      const siteKey = trialSiteKey.trim() || TURNSTILE_TEST_SITE_KEY;
      setTrialTurnstileSiteKey(siteKey);
      loadTurnstileScript();
      // Wait for the script to load (it may already be loaded).
      let attempts = 0;
      while (!(window as any).turnstile && attempts < 50) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }
      if (!(window as any).turnstile || !turnstileRef.current) {
        setTrialError("Could not load human verification. Check your connection and try again.");
        setTrialActivating(false);
        return;
      }
      removeTurnstile(turnstileRef.current);
      const turnstileToken = await renderTurnstile(turnstileRef.current, siteKey);
      // Create session.
      const result = await createTrialSession(workerUrl, turnstileToken, status.requiresInviteCode ? trialInviteCode.trim() : undefined);
      if (!result.ok || !result.token || !result.expiresAt) {
        setTrialError(result.error || "Failed to start Friend Trial.");
        removeTurnstile(turnstileRef.current);
        setTrialActivating(false);
        return;
      }
      setTrialSession(result.token, result.expiresAt);
      setActiveProvider(TRIAL_PROVIDER);
      setActiveProviderState(TRIAL_PROVIDER as any);
      bumpTrialTick();
      addToast("Friend Trial active — no API key required.", "success");
      removeTurnstile(turnstileRef.current);
    } catch (e) {
      setTrialError((e as Error).message || "Failed to start Friend Trial.");
      if (turnstileRef.current) removeTurnstile(turnstileRef.current);
    } finally {
      setTrialActivating(false);
    }
  };

  const handleTrialDeactivate = () => {
    clearTrialSession();
    bumpTrialTick();
    // Fall back to a BYOK provider if one has a key.
    const providerWithKey = getProviderWithKey();
    if (providerWithKey && providerWithKey !== TRIAL_PROVIDER) {
      setActiveProviderState(providerWithKey as any);
      setActiveProvider(providerWithKey);
    }
    addToast("Friend Trial deactivated.", "success");
  };

  const handleTrialRefreshStatus = async () => {
    const workerUrl = trialWorkerUrl.trim().replace(/\/+$/, "");
    if (!workerUrl) return;
    try {
      const status = await fetchTrialStatus(workerUrl);
      setTrialStatusState(status);
    } catch {}
  };

  const handleDevTokenLogin = () => {
    if (!devUsername || !devToken) return;
    loginWithDevToken(devToken, devUsername);
  };

  return (
    <div className="flex flex-col min-h-0 max-h-[50vh] bg-[#121217] text-[#E0E0E6] gap-4 p-4">
      {showKeys && (
        <section className="flex flex-col min-h-0 flex-1 gap-4">
          <div className="flex gap-2 flex-wrap shrink-0">
            {(["openrouter", "ollama", "gemini", "openai", "claude", "custom-openai", "trial"] as const).map((p) => (
              <button
                key={p}
                onClick={() => handleProviderSelect(p)}
                className={cn(
                  "flex-1 min-w-[70px] py-1.5 text-[10px] font-bold uppercase rounded border transition-colors flex items-center justify-center gap-1.5 relative",
                  (activeProvider === p || (p === "gemini" && (activeProvider === "gemini-pro" || activeProvider === "gemini-env")))
                    ? "bg-[#FF6321]/20 border-[#FF6321]/30 text-[#FF6321]"
                    : p === "openrouter"
                      ? "bg-orange-500/10 border-orange-500/30 text-orange-300 hover:bg-orange-500/15"
                      : p === "ollama"
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/15"
                        : p === "custom-openai"
                          ? "bg-sky-500/10 border-sky-500/30 text-sky-300 hover:bg-sky-500/15"
                          : "bg-white/5 border-white/10 text-gray-500 opacity-50 hover:opacity-100",
                )}
              >
                <div
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    p === "openrouter"
                      ? (keys.openRouterKey ? "bg-green-500" : "bg-gray-700")
                      : p === "ollama"
                        // Ollama needs no key, but it does need a base URL and model
                        // to actually function. Show green only when both are set.
                        ? (keys.customBaseUrl && keys.customModel ? "bg-green-500" : "bg-gray-700")
                        : p === "custom-openai"
                          // Custom OpenAI-compatible: configured when base URL + model
                          // are set (key optional for local/no-auth endpoints).
                          ? (keys.customOpenAIBaseUrl && keys.customOpenAIModel ? "bg-green-500" : "bg-gray-700")
                          : p === "trial"
                            // Friend Trial: green when a valid session exists.
                            ? (trialSessionValid ? "bg-green-500" : "bg-gray-700")
                            : keys[
                                `${p === "openai" ? "chatGpt" : p}Key` as keyof typeof keys
                              ]
                              ? "bg-green-500"
                              : "bg-gray-700",
                  )}
                />
                {p === "openai" ? "GPT" : (p === "openrouter" ? "OpenRouter" : p === "ollama" ? "Ollama" : p === "custom-openai" ? "Custom" : p === "trial" ? "Friend Trial" : p)}
              </button>
            ))}
          </div>

          <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest block shrink-0">
            API Config
          </span>

          <div className="flex-1 overflow-y-auto pr-1 space-y-3 settings-scroll-area">
            {/* Ollama info banner — shown when Ollama is the active provider */}
            {activeProvider === "ollama" && (
              <div className="bg-emerald-500/[0.08] border border-emerald-500/25 rounded-lg p-2.5 space-y-1">
                <span className="text-[10px] font-bold text-emerald-300 flex items-center gap-1.5">
                  <Bot className="w-3 h-3 text-emerald-400" />
                  Ollama / Local — no API key required
                </span>
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  Set your <span className="text-emerald-300 font-semibold">Custom API Base URL</span> to your Ollama endpoint (default <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">http://localhost:11434/v1</code>) and <span className="text-emerald-300 font-semibold">Custom Model Name</span> to a pulled model tag (e.g. <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">qwen3.5:9b</code>). Start Ollama with <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">OLLAMA_ORIGINS=* ollama serve</code> so the browser can reach it.
                </p>
              </div>
            )}

            {/* Custom OpenAI-Compatible provider config — shown when selected */}
            {activeProvider === "custom-openai" && (
              <div className="bg-sky-500/[0.06] border border-sky-500/25 rounded-lg p-2.5 space-y-2.5">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-sky-300 flex items-center gap-1.5">
                    <Plug className="w-3 h-3 text-sky-400" />
                    Custom OpenAI-Compatible
                  </span>
                  <p className="text-[10px] text-gray-400 leading-relaxed">
                    Works with Groq, OpenRouter, Cerebras, Together, self-hosted gateways, and other OpenAI-style APIs. Base URL should usually end with <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">/v1</code>.
                  </p>
                </div>

                {/* Provider nickname (optional) */}
                <div className="space-y-1">
                  <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Provider Label (optional)</span>
                  <input
                    type="text"
                    value={keys.customOpenAILabel}
                    onChange={(e) => {
                      const next = e.target.value;
                      setKeys((k) => ({ ...k, customOpenAILabel: next }));
                      // Autofill Base URL when the label matches a known preset
                      // and the URL field is still empty or a preset default.
                      const suggested = suggestBaseUrlFromLabel(next);
                      if (suggested && isPresetOrDefaultUrl(keys.customOpenAIBaseUrl)) {
                        setKeys((k) => ({ ...k, customOpenAIBaseUrl: suggested }));
                      }
                    }}
                    className="w-full bg-black/30 border border-sky-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500/50 text-white placeholder-gray-700 font-mono"
                    placeholder="Groq, OpenRouter, My Proxy…"
                  />
                </div>

                {/* Base URL (required) */}
                <div className="space-y-1">
                  <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Base URL (required)</span>
                  <input
                    type="text"
                    value={keys.customOpenAIBaseUrl}
                    onChange={(e) => { setKeys((k) => ({ ...k, customOpenAIBaseUrl: e.target.value })); setConnResult(null); }}
                    className="w-full bg-black/30 border border-sky-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500/50 text-white placeholder-gray-700 font-mono"
                    placeholder="https://api.groq.com/openai/v1"
                  />
                </div>

                {/* API Key (optional for no-auth endpoints) */}
                <div className="space-y-1">
                  <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">API Key (optional)</span>
                  <input
                    type="password"
                    value={keys.customOpenAIKey}
                    onChange={(e) => { setKeys((k) => ({ ...k, customOpenAIKey: e.target.value })); setConnResult(null); }}
                    className="w-full bg-black/30 border border-sky-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500/50 text-white placeholder-gray-700 font-mono"
                    placeholder="Paste API key (leave blank for no-auth endpoints)"
                  />
                </div>

                {/* Model (required) — dropdown of loaded models or manual entry */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Model (required)</span>
                    <button
                      type="button"
                      onClick={handleLoadCustomModels}
                      disabled={loadingModels || !keys.customOpenAIBaseUrl.trim()}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/10 border border-sky-500/30 text-[9px] font-bold uppercase tracking-wider text-sky-300 hover:bg-sky-500/20 hover:border-sky-400/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {loadingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      Load Models
                    </button>
                  </div>
                  {customModels.length > 0 ? (
                    <select
                      value={keys.customOpenAIModel}
                      onChange={(e) => setKeys((k) => ({ ...k, customOpenAIModel: e.target.value }))}
                      className="w-full bg-black/30 border border-sky-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500/50 text-white font-mono cursor-pointer"
                    >
                      <option value="">Select a model…</option>
                      {customModels.map((m) => (
                        <option key={m} value={m} className="bg-[#1E1E2A] text-white">{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={keys.customOpenAIModel}
                      onChange={(e) => setKeys((k) => ({ ...k, customOpenAIModel: e.target.value }))}
                      className="w-full bg-black/30 border border-sky-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500/50 text-white placeholder-gray-700 font-mono"
                      placeholder="openai/gpt-oss-120b"
                    />
                  )}
                  <p className="text-[9px] text-gray-500 leading-relaxed">
                    Type a model name or load available models from the endpoint. Manual entry always works as a fallback.
                  </p>
                </div>

                {/* Test Connection */}
                <div className="space-y-1.5 pt-1 border-t border-sky-500/15">
                  <button
                    type="button"
                    onClick={handleTestCustomConnection}
                    disabled={testingConn || !keys.customOpenAIBaseUrl.trim()}
                    className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-sky-500/10 border border-sky-500/30 text-[10px] font-bold uppercase tracking-wider text-sky-300 hover:bg-sky-500/20 hover:border-sky-400/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {testingConn ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                    Test Connection
                  </button>
                  {connResult && (
                    <div className={cn(
                      "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed",
                      connResult.ok
                        ? "bg-green-500/10 border border-green-500/25 text-green-300"
                        : "bg-red-500/10 border border-red-500/25 text-red-300",
                    )}>
                      {connResult.ok
                        ? <Check className="w-3 h-3 mt-0.5 shrink-0" />
                        : <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />}
                      <span>{connResult.message}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ─── Friend Trial (Worker-held Groq key, no BYOK needed) ─────────── */}
            {activeProvider === "trial" && (
              <div className="bg-amber-500/[0.06] border border-amber-500/25 rounded-lg p-2.5 space-y-2.5">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-amber-300 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-amber-400" />
                    Friend Trial — API provided temporarily by MADchatter
                  </span>
                  <p className="text-[10px] text-gray-400 leading-relaxed">
                    No API key required. A small owner-funded Groq allowance powers a temporary trial. Human verification (Cloudflare Turnstile) is required to start. Your own provider keys are never touched.
                  </p>
                </div>

                {/* Worker URL */}
                <div className="space-y-1">
                  <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Worker URL</span>
                  <input
                    type="text"
                    value={trialWorkerUrl}
                    onChange={(e) => { setTrialWorkerUrlState(e.target.value); setTrialWorkerUrl(e.target.value); }}
                    className="w-full bg-black/30 border border-amber-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500/50 text-white placeholder-gray-700 font-mono"
                    placeholder="https://friend-trial.<account>.workers.dev"
                  />
                </div>

                {/* Turnstile site key */}
                <div className="space-y-1">
                  <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Turnstile Site Key (public)</span>
                  <input
                    type="text"
                    value={trialSiteKey}
                    onChange={(e) => { setTrialSiteKeyState(e.target.value); setTrialTurnstileSiteKey(e.target.value); }}
                    className="w-full bg-black/30 border border-amber-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500/50 text-white placeholder-gray-700 font-mono"
                    placeholder="0x4AAAAAAA... (public site key)"
                  />
                </div>

                {/* Trial status */}
                {trialStatus && (
                  <div className={cn(
                    "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed",
                    trialStatus.enabled
                      ? "bg-green-500/10 border border-green-500/25 text-green-300"
                      : "bg-red-500/10 border border-red-500/25 text-red-300",
                  )}>
                    {trialStatus.enabled
                      ? <Check className="w-3 h-3 mt-0.5 shrink-0" />
                      : <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />}
                    <span>
                      {trialStatus.enabled
                        ? `Trial active${trialStatus.endsAt ? ` until ${new Date(trialStatus.endsAt).toLocaleString()}` : ""}${trialStatus.requiresInviteCode ? " · invite code required" : ""}`
                        : trialStatus.reason === "ENDED"
                          ? "Trial has ended. Add your own API key to continue."
                          : "Trial is currently unavailable."}
                    </span>
                  </div>
                )}

                {/* Active session indicator */}
                {trialSessionValid && (
                  <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] bg-green-500/10 border border-green-500/25 text-green-300">
                    <Check className="w-3 h-3 shrink-0" />
                    <span className="flex-1">Trial Active — no API key required</span>
                    <button
                      type="button"
                      onClick={handleTrialDeactivate}
                      className="px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/25 text-red-300 hover:bg-red-500/25 text-[9px] font-bold uppercase"
                    >
                      Deactivate
                    </button>
                  </div>
                )}

                {/* Invite code (if required) */}
                {trialStatus?.requiresInviteCode && !trialSessionValid && (
                  <div className="space-y-1">
                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Invite Code</span>
                    <input
                      type="text"
                      value={trialInviteCode}
                      onChange={(e) => setTrialInviteCode(e.target.value)}
                      className="w-full bg-black/30 border border-amber-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500/50 text-white placeholder-gray-700 font-mono"
                      placeholder="Enter invite code"
                    />
                  </div>
                )}

                {/* Turnstile widget container */}
                <div ref={turnstileRef} className="min-h-[65px]" />

                {/* Activate / Refresh buttons */}
                <div className="flex gap-1.5 pt-1 border-t border-amber-500/15">
                  {!trialSessionValid && (
                    <button
                      type="button"
                      onClick={handleTrialActivate}
                      disabled={trialActivating || !trialWorkerUrl.trim()}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20 hover:border-amber-400/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {trialActivating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {trialActivating ? "Starting…" : "Start Friend Trial"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleTrialRefreshStatus}
                    className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:bg-white/10 transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Check
                  </button>
                </div>

                {trialError && (
                  <div className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed bg-red-500/10 border border-red-500/25 text-red-300">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{trialError}</span>
                  </div>
                )}
              </div>
            )}

            {/* ─── Independent Vision Provider (v26) ────────────────────────── */}
            <div className="bg-violet-500/[0.06] border border-violet-500/25 rounded-lg p-2.5 space-y-2.5">
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-violet-300 flex items-center gap-1.5">
                  <ScanEye className="w-3 h-3 text-violet-400" />
                  Vision Provider
                </span>
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  Route screenshot interpretation independently from text generation. Pick <span className="text-violet-300 font-semibold">Ollama</span> to analyze frames locally with an image-capable model while your text provider (e.g. Groq) handles the conversation. The screenshot is never sent to the text provider — only the textual observation is.
                </p>
              </div>

              {/* Mode selector */}
              <div className="flex gap-1.5">
                {(["text", "ollama"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setVisionProvider(m)}
                    className={cn(
                      "flex-1 px-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-colors",
                      visionProvider === m
                        ? "bg-violet-500/20 border-violet-400/50 text-violet-200"
                        : "bg-white/5 border-white/10 text-gray-500 hover:bg-white/10",
                    )}
                  >
                    {m === "text" ? "Use Text Provider" : "Ollama (Local)"}
                  </button>
                ))}
              </div>

              {/* Ollama vision config — shown when Ollama is selected */}
              {visionProvider === "ollama" && (
                <div className="space-y-2.5 pt-1 border-t border-violet-500/15">
                  <div className="space-y-1">
                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Ollama Base URL</span>
                    <input
                      type="text"
                      value={visionOllamaBaseUrl}
                      onChange={(e) => setVisionOllamaBaseUrl(e.target.value)}
                      className="w-full bg-black/30 border border-violet-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-violet-500/50 text-white placeholder-gray-700 font-mono"
                      placeholder="http://localhost:11434/v1"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Vision Model (image-capable)</span>
                    <input
                      type="text"
                      value={visionOllamaModel}
                      onChange={(e) => setVisionOllamaModel(e.target.value)}
                      className="w-full bg-black/30 border border-violet-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-violet-500/50 text-white placeholder-gray-700 font-mono"
                      placeholder="llama3.2-vision:11b"
                    />
                    <p className="text-[9px] text-gray-500 leading-relaxed">
                      Enter an image-capable model tag you've already pulled (<code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">ollama pull llama3.2-vision</code>). MADchatter does not download models or verify image support automatically — pick a vision model you know works.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={handleTestVisionModel}
                      disabled={visionChecking || !visionOllamaBaseUrl.trim() || !visionOllamaModel.trim()}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-violet-500/10 border border-violet-500/30 text-[10px] font-bold uppercase tracking-wider text-violet-300 hover:bg-violet-500/20 hover:border-violet-400/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {visionChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                      Check Model Availability
                    </button>
                    {visionHealth && (
                      <div className={cn(
                        "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed",
                        visionHealth.state === "ready"
                          ? "bg-green-500/10 border border-green-500/25 text-green-300"
                          : "bg-amber-500/10 border border-amber-500/25 text-amber-300",
                      )}>
                        {visionHealth.state === "ready"
                          ? <Check className="w-3 h-3 mt-0.5 shrink-0" />
                          : <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />}
                        <span>
                          {visionHealth.state === "ready"
                            ? `Model "${visionOllamaModel}" is listed. Image analysis is verified on the first capture.`
                            : visionHealth.error || "Model not found or endpoint unreachable."}
                        </span>
                      </div>
                    )}
                    {!visionHealth && visionOllamaBaseUrl.trim() && visionOllamaModel.trim() && (
                      <p className="text-[9px] text-gray-500 leading-relaxed">
                        Configured but not yet verified. Click "Check Model Availability" or trigger a capture to confirm.
                      </p>
                    )}
                    {!visionOllamaModel.trim() && (
                      <p className="text-[9px] text-amber-300/80 leading-relaxed">
                        Configuration incomplete — enter an image-capable model. Vision will fall back to the text provider until both fields are set.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {visionProvider === "text" && (
                <p className="text-[9px] text-gray-500 leading-relaxed">
                  Screenshots are analyzed by your active text provider (legacy behavior). Switch to Ollama to keep images local.
                </p>
              )}
            </div>

            {/* Twitch Client ID Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#9146FF]" />
                Twitch Client ID
              </span>
              <input
                type="text"
                value={twitchClientId}
                onChange={(e) => setTwitchClientIdState(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#9146FF]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter your Twitch Client ID..."
              />
            </div>

            {/* Kick Client ID Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#53fc18]" />
                Kick Client ID
              </span>
              <input
                type="text"
                value={kickClientId}
                onChange={(e) => setKickClientIdState(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#53fc18]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter your Kick Client ID..."
              />
            </div>

            {/* Joystick Client ID Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#FF6B35]" />
                Joystick Client ID
              </span>
              <input
                type="text"
                value={joystickClientId}
                onChange={(e) => setJoystickClientIdState(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6B35]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter your Joystick Client ID..."
              />
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#FF6B35]" />
                Joystick Client Secret
              </span>
              <input
                type="password"
                value={joystickClientSecret}
                onChange={(e) => setJoystickClientSecretState(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6B35]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter your Joystick Client Secret..."
              />
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Bot className="w-3 h-3 text-[#FF6B35]" />
                Joystick Bot Username
              </span>
              <input
                type="text"
                value={joystickBotUsername}
                onChange={(e) => setJoystickBotUsernameState(e.target.value)}
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6B35]/50 text-white placeholder-gray-700 font-mono"
                placeholder="e.g. a_bot"
              />
            </div>

            {/* OpenRouter Key Block — Featured */}
            <div className="bg-gradient-to-b from-orange-500/10 to-transparent border border-orange-500/30 rounded-lg p-2.5 space-y-1.5 relative overflow-hidden">
              <div className="absolute top-0 right-0 px-2 py-0.5 bg-gradient-to-l from-orange-500 to-red-500 text-white text-[8px] font-black uppercase tracking-wider rounded-bl-lg">
                Recommended
              </div>
              <span className="text-[10px] font-bold text-orange-300 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-orange-400" />
                OpenRouter Key
              </span>
              <input
                type="password"
                value={keys.openRouterKey}
                onChange={(e) =>
                  handleKeyChange("openRouterKey", e.target.value)
                }
                className="w-full bg-black/30 border border-orange-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-orange-500/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter OpenRouter Key..."
              />
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-bold text-orange-400 hover:text-orange-300 underline decoration-orange-500/40 hover:decoration-orange-400 transition-colors"
                >
                  Get key ↗
                </a>
                <span className="text-[10px] text-gray-500">
                  Use <code className="text-[9px] font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300 border border-white/10">google/gemini-3.8-flash</code>
                </span>
                <ThemedTooltip content="Copy model name">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText("google/gemini-3.8-flash");
                      addToast("Model name copied!", "success");
                    }}
                    className="text-gray-500 hover:text-orange-400 transition-colors"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </ThemedTooltip>
              </div>
            </div>

            {/* Gemini Key Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#FF6321]" />
                Gemini API Key
              </span>
              <input
                type="password"
                value={keys.geminiKey}
                onChange={(e) =>
                  handleKeyChange("geminiKey", e.target.value)
                }
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6321]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter Gemini API Key..."
              />
            </div>

            {/* OpenAI Key Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#FF6321]" />
                OpenAI Key
              </span>
              <input
                type="password"
                value={keys.chatGptKey}
                onChange={(e) =>
                  handleKeyChange("chatGptKey", e.target.value)
                }
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6321]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter custom OpenAI Key..."
              />
            </div>

            {/* Anthropic Key Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#FF6321]" />
                Anthropic Claude Key
              </span>
              <input
                type="password"
                value={keys.claudeKey}
                onChange={(e) =>
                  handleKeyChange("claudeKey", e.target.value)
                }
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#FF6321]/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter custom Anthropic Key..."
              />
            </div>

            {/* Custom OpenAI-Compatible API Key Block — always visible so the
                user can enter a Groq (or other OpenAI-compatible) key without
                first selecting the Custom provider in the grid above. */}
            <div className="bg-sky-500/[0.06] border border-sky-500/25 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-sky-300 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-sky-400" />
                Custom OpenAI API Key
              </span>
              <input
                type="password"
                value={keys.customOpenAIKey}
                onChange={(e) => {
                  setKeys((k) => ({ ...k, customOpenAIKey: e.target.value }));
                  setConnResult(null);
                }}
                className="w-full bg-black/30 border border-sky-500/20 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-sky-500/50 text-white placeholder-gray-700 font-mono"
                placeholder="Groq / OpenRouter / Cerebras / custom endpoint key…"
              />
              <p className="text-[9px] text-gray-500 leading-relaxed">
                For the <span className="text-sky-300 font-semibold">Custom</span> provider (Groq, Cerebras, Together, self-hosted gateways). Select "Custom" above and set the Base URL + Model to use it.
              </p>
            </div>

            {/* Custom API Base URL Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Globe className="w-3 h-3 text-emerald-500" />
                Custom API Base URL
              </span>
              <input
                type="text"
                value={keys.customBaseUrl}
                onChange={(e) =>
                  setKeys((k) => ({ ...k, customBaseUrl: e.target.value }))
                }
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-emerald-500/50 text-white placeholder-gray-700 font-mono"
                placeholder="https://openrouter.ai/api/v1 (or Ollama/Local)"
              />
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-[9px] text-gray-500 font-sans leading-relaxed flex-1 min-w-0">
                  Optional. Defaults to OpenRouter. Set to your local endpoint (e.g., <code>http://localhost:11434/v1</code> for Ollama) if desired.
                </p>
                <div className="flex items-center gap-1.5 shrink-0">
                  <ThemedTooltip content="Auto-fill with the Groq OpenAI-compatible endpoint">
                    <button
                      type="button"
                      onClick={() => {
                        setKeys((k) => ({ ...k, customBaseUrl: "https://api.groq.com/openai/v1" }));
                        addToast("Filled with Groq endpoint", "success");
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-sky-500/10 border border-sky-500/30 text-[9px] font-bold uppercase tracking-wider text-sky-300 hover:bg-sky-500/20 hover:border-sky-400/50 transition-colors"
                    >
                      <Wand2 className="w-3 h-3" />
                      Groq URL
                    </button>
                  </ThemedTooltip>
                  <ThemedTooltip content="Auto-fill with the default Ollama local endpoint">
                    <button
                      type="button"
                      onClick={() => {
                        setKeys((k) => ({ ...k, customBaseUrl: "http://localhost:11434/v1" }));
                        addToast("Filled with Ollama local endpoint", "success");
                      }}
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-400/50 transition-colors"
                    >
                      <Wand2 className="w-3 h-3" />
                      Ollama URL
                    </button>
                  </ThemedTooltip>
                </div>
              </div>
            </div>

            {/* Custom Model Name Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Bot className="w-3 h-3 text-purple-500" />
                Custom Model Name
              </span>
              <input
                type="text"
                value={keys.customModel}
                onChange={(e) =>
                  setKeys((k) => ({ ...k, customModel: e.target.value }))
                }
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-purple-500/50 text-white placeholder-gray-700 font-mono"
                placeholder="google/gemini-3.8-flash (or Ollama model)"
              />
              <p className="text-[9px] text-gray-500 font-sans leading-relaxed">
                Optional. Defaults to <code>google/gemini-3.8-flash</code> for OpenRouter.
              </p>
            </div>

            {/* Deepgram Key Block */}
            <div className="bg-white/5 border border-white/10 rounded-lg p-2.5 space-y-1.5">
              <span className="text-[10px] font-bold text-gray-400 flex items-center gap-1.5">
                <Key className="w-3 h-3 text-blue-500" />
                Deepgram Voice Key
              </span>
              <input
                type="password"
                value={keys.deepgramKey}
                onChange={(e) =>
                  setKeys((k) => ({ ...k, deepgramKey: e.target.value }))
                }
                className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-blue-500/50 text-white placeholder-gray-700 font-mono"
                placeholder="Enter custom Deepgram Key..."
              />
            </div>
          </div>
        </section>
      )}

      {showKeys && (
        <div className="shrink-0 pt-3 border-t border-white/5 space-y-3">
          <button
            onClick={saveKeysHandler}
            className="w-full h-9 flex items-center justify-center gap-2 bg-[#FF6321]/10 hover:bg-[#FF6321]/20 text-[#FF6321] text-[10px] font-bold uppercase tracking-widest rounded border border-[#FF6321]/30 transition-colors"
          >
            {keysSavedState ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-400" />
                <span className="text-green-400">Saved!</span>
              </>
            ) : (
              <span>Save Keys</span>
            )}
          </button>

          {!user && (
            <div className="space-y-2">
              <span className="text-[10px] font-black uppercase text-[#9146FF] tracking-widest block">
                Twitch Dev Bypass
              </span>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={devUsername}
                  onChange={(e) => setDevUsername(e.target.value)}
                  className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#9146FF]/50 text-white placeholder-gray-700"
                  placeholder="Username"
                />
                <input
                  type="password"
                  value={devToken}
                  onChange={(e) => setDevToken(e.target.value)}
                  className="w-full bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#9146FF]/50 text-white placeholder-gray-700 font-mono"
                  placeholder="oauth:..."
                />
              </div>
              <button
                onClick={handleDevTokenLogin}
                disabled={!devUsername || !devToken}
                className="w-full h-8 flex items-center justify-center bg-[#9146FF] hover:bg-[#772ce8] disabled:opacity-50 text-white text-[10px] font-bold uppercase rounded transition-colors"
              >
                Connect
              </button>
            </div>
          )}
        </div>
      )}

          <div className="mt-auto border-t border-white/5 pt-4">
            <fieldset className="space-y-3 text-xs text-gray-300">
              <legend className="mb-2 font-semibold text-white">Room intelligence</legend>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={episodicEnabled} onChange={(e) => setEpisodicEnabled(e.target.checked)} />
                Remember shared episodes
              </label>
              <p className="text-[11px] text-gray-400">Build and recall shared events. Turning this off keeps retained history.</p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={synthesisEnabled} onChange={(e) => setSynthesisEnabled(e.target.checked)} />
                AI enrichment for moments and episodes
              </label>
              <p className="text-[11px] text-gray-400">Optional summaries use your selected provider, at most once every ten minutes across both systems. Room awareness continues without them.</p>
            </fieldset>
          </div>

      {showConfig && (
        <>
          <section className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest block mb-2">
                Core Profile
              </span>
              <select
                value={config.primaryProfile}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, primaryProfile: e.target.value }))
                }
                className="w-full bg-[#1E1E2A] border border-[#FF6321]/40 rounded p-2 text-xs font-bold focus:outline-none focus:border-[#FF6321] focus:ring-1 focus:ring-[#FF6321]/50 text-white cursor-pointer"
              >
                <option value="Gremlin" className="bg-[#1E1E2A] text-white">
                  Gremlin Mode
                </option>
                <option value="Support" className="bg-[#1E1E2A] text-white">
                  Support Mode
                </option>
                <option value="Analyst" className="bg-[#1E1E2A] text-white">
                  Analyst Mode
                </option>
                <option value="Hype" className="bg-[#1E1E2A] text-white">
                  Hype Mode
                </option>
                <option value="Questioner" className="bg-[#1E1E2A] text-white">
                  Questioner Mode
                </option>
                <option value="Custom" className="bg-[#1E1E2A] text-white">
                  Custom Profile
                </option>
              </select>
            </div>

            <div>
              <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest block mb-2">
                Emote Density
              </span>
              <select
                value={config.emoteDensity}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    emoteDensity: e.target.value as any,
                  }))
                }
                className="w-full bg-[#1E1E2A] border border-[#FF6321]/40 rounded p-2 text-xs font-bold focus:outline-none focus:border-[#FF6321] focus:ring-1 focus:ring-[#FF6321]/50 text-white cursor-pointer"
              >
                <option value="none" className="bg-[#1E1E2A] text-white">
                  None (0 emotes)
                </option>
                <option value="minimal" className="bg-[#1E1E2A] text-white">
                  Minimal
                </option>
                <option value="moderate" className="bg-[#1E1E2A] text-white">
                  Moderate
                </option>
                <option value="heavy" className="bg-[#1E1E2A] text-white">
                  Heavy
                </option>
              </select>
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] font-black uppercase text-gray-500 tracking-widest">
                  Humor Level
                </label>
                <span className="text-[10px] font-mono text-[#FF6321]">
                  {config.humorLevel}%
                </span>
              </div>
              <div className="h-1 bg-black/40 rounded-full relative cursor-pointer group">
                <div
                  className="absolute h-full bg-[#FF6321] rounded-full shadow-[0_0_8px_#FF6321]"
                  style={{ width: `${config.humorLevel}%` }}
                ></div>
                <div
                  className="absolute w-3 h-3 bg-white rounded-full border-2 border-[#FF6321] -top-1 shadow-sm"
                  style={{ left: `calc(${config.humorLevel}% - 6px)` }}
                ></div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={config.humorLevel}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      humorLevel: parseInt(e.target.value),
                    }))
                  }
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] font-black uppercase text-gray-500 tracking-widest">
                  Chaos Energy
                </label>
                <span className="text-[10px] font-mono text-purple-500">
                  {config.chaosLevel}%
                </span>
              </div>
              <div className="h-1 bg-black/40 rounded-full relative cursor-pointer group">
                <div
                  className="absolute h-full bg-purple-500 rounded-full"
                  style={{ width: `${config.chaosLevel}%` }}
                ></div>
                <div
                  className="absolute w-3 h-3 bg-white rounded-full border-2 border-purple-500 -top-1 shadow-sm"
                  style={{ left: `calc(${config.chaosLevel}% - 6px)` }}
                ></div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={config.chaosLevel}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      chaosLevel: parseInt(e.target.value),
                    }))
                  }
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>
          </section>

          <section>
            <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest block mb-2">
              Output Preferences
            </span>
            <div className="grid grid-cols-2 gap-1 mb-3">
              {(["short", "adaptive"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() =>
                    setConfig((c) => ({ ...c, lengthPreference: l }))
                  }
                  className={cn(
                    "py-1.5 rounded text-[10px] font-bold uppercase transition-colors",
                    config.lengthPreference === l
                      ? "bg-white/10 border border-white/20 text-white"
                      : "bg-white/5 text-gray-500 border border-transparent",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded cursor-pointer group">
              <input
                type="checkbox"
                checked={config.voiceContextEnabled}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    voiceContextEnabled: e.target.checked,
                  }))
                }
                className="hidden"
              />
              <div
                className={cn(
                  "w-4 h-4 rounded flex items-center justify-center transition-colors",
                  config.voiceContextEnabled
                    ? "bg-blue-500"
                    : "bg-black/50 border border-blue-500/30",
                )}
              >
                {config.voiceContextEnabled && (
                  <svg
                    className="w-3 h-3 text-black"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-black uppercase leading-tight text-white">
                  Voice Context
                </span>
                <span className="text-[9px] opacity-60 text-gray-300">
                  Prioritize transcript signals
                </span>
              </div>
            </label>

            <div className="mt-4">
              <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest block mb-2">
                Directives
              </span>
              <textarea
                value={config.additionalInstructions}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    additionalInstructions: e.target.value,
                  }))
                }
                placeholder="Optional rules..."
                className="w-full h-16 bg-black/30 border border-white/10 rounded p-2 text-[10px] font-mono focus:outline-none focus:border-[#FF6321]/50 text-gray-300 resize-none"
              />
            </div>
          </section>


        </>
      )}
    </div>
  );
}
