import React, { useState, useEffect } from "react";
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
} from "lucide-react";
import { cn } from "../lib/utils";
import { getKeys, saveKeys, getActiveProvider, setActiveProvider, getProviderWithKey, getApiKey } from "../lib/keys";
import { getTwitchClientId, setTwitchClientId } from "../lib/twitch";
import { getKickClientId, setKickClientId } from "../lib/kick";
import { getJoystickClientId, setJoystickClientId, getJoystickClientSecret, setJoystickClientSecret, getJoystickBotUsername, setJoystickBotUsername } from "../lib/joystick";
import { playSfx } from "../lib/sfx";

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

  const [activeProvider, setActiveProviderState] = useState<
    "gemini" | "gemini-pro" | "gemini-env" | "openai" | "claude" | "openrouter" | "ollama"
  >("gemini");
  const [keys, setKeys] = useState({
    geminiKey: "",
    chatGptKey: "",
    claudeKey: "",
    deepgramKey: "",
    openRouterKey: "",
    customBaseUrl: "",
    customModel: "",
  });
  const [savingKeys, setSavingKeys] = useState(false);
  const [keysSavedState, setKeysSavedState] = useState(false);

  const [devUsername, setDevUsername] = useState("");
  const [devToken, setDevToken] = useState("");

  const [twitchClientId, setTwitchClientIdState] = useState("");
  const [kickClientId, setKickClientIdState] = useState("");
  const [joystickClientId, setJoystickClientIdState] = useState("");
  const [joystickClientSecret, setJoystickClientSecretState] = useState("");
  const [joystickBotUsername, setJoystickBotUsernameState] = useState("");

  useEffect(() => {
    const savedProvider = getActiveProvider();
    if (
      savedProvider &&
      ["gemini", "gemini-pro", "gemini-env", "openai", "claude", "openrouter", "ollama"].includes(savedProvider)
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

  const handleProviderSelect = (p: "gemini" | "openai" | "claude" | "openrouter" | "ollama") => {
    setActiveProviderState(p);
    setActiveProvider(p);
    // Selecting Ollama pre-fills the local endpoint + a default model tag so the
    // user doesn't have to know the URL. They can still edit both fields after.
    if (p === "ollama") {
      setKeys((k) => ({
        ...k,
        customBaseUrl: k.customBaseUrl || "http://localhost:11434/v1",
        customModel: k.customModel || "llama3.1:8b",
      }));
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

  const handleDevTokenLogin = () => {
    if (!devUsername || !devToken) return;
    loginWithDevToken(devToken, devUsername);
  };

  return (
    <div className="flex flex-col min-h-0 max-h-[50vh] bg-[#121217] text-[#E0E0E6] gap-4 p-4">
      {showKeys && (
        <section className="flex flex-col min-h-0 flex-1 gap-4">
          <div className="flex gap-2 flex-wrap shrink-0">
            {(["openrouter", "ollama", "gemini", "openai", "claude"] as const).map((p) => (
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
                        : keys[
                            `${p === "openai" ? "chatGpt" : p}Key` as keyof typeof keys
                          ]
                            ? "bg-green-500"
                            : "bg-gray-700",
                  )}
                />
                {p === "openai" ? "GPT" : (p === "openrouter" ? "OpenRouter" : p === "ollama" ? "Ollama" : p)}
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
                  Set your <span className="text-emerald-300 font-semibold">Custom API Base URL</span> to your Ollama endpoint (default <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">http://localhost:11434/v1</code>) and <span className="text-emerald-300 font-semibold">Custom Model Name</span> to a pulled model tag (e.g. <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">llama3.1:8b</code>). Start Ollama with <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-gray-300">OLLAMA_ORIGINS=* ollama serve</code> so the browser can reach it.
                </p>
              </div>
            )}

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
                <button
                  onClick={() => {
                    navigator.clipboard.writeText("google/gemini-3.8-flash");
                    addToast("Model name copied!", "success");
                  }}
                  className="text-gray-500 hover:text-orange-400 transition-colors"
                  title="Copy model name"
                >
                  <Copy className="w-3 h-3" />
                </button>
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
                <button
                  type="button"
                  onClick={() => {
                    setKeys((k) => ({ ...k, customBaseUrl: "http://localhost:11434/v1" }));
                    addToast("Filled with Ollama local endpoint", "success");
                  }}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-400/50 transition-colors"
                  title="Auto-fill with the default Ollama local endpoint"
                >
                  <Wand2 className="w-3 h-3" />
                  Ollama URL
                </button>
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

          <div className="mt-auto border-t border-white/5 pt-4">
            <div className="flex items-center gap-2 text-[9px] font-mono text-gray-600">
              <div className="w-2 h-2 rounded-full bg-green-500"></div>
              API: gemini-3.8-flash [STABLE]
            </div>
          </div>
        </>
      )}
    </div>
  );
}
