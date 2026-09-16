/**
 * LocalBridgePanel — compact Local Bridge transcription controls.
 *
 * Renders inside the StreamOverlay (alongside the existing Capture/Microphone
 * buttons) when the user selects Local Bridge as their transcription provider.
 * Preserves MADchatter's established visual language: dark cards, uppercase
 * labels, lucide icons, sonner toasts, status indicators.
 */

import React, { useState, useCallback } from "react";
import { Radio, Cpu, HardDrive, Loader2, AlertTriangle, Wifi, WifiOff, Settings2, ChevronDown, ChevronUp } from "lucide-react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { useLocalBridge } from "../hooks/useLocalBridge";
import { buildStreamUrl, type BridgeDevice } from "../lib/localBridge";

const MODELS = ["tiny.en", "base.en", "small.en", "medium.en"];
const DEVICES: BridgeDevice[] = ["auto", "cuda", "cpu"];

export function LocalBridgePanel() {
  const enabled = useAppStore((s) => s.localBridgeEnabled);
  const setLocalBridgeEnabled = useAppStore((s) => s.setLocalBridgeEnabled);
  const baseUrl = useAppStore((s) => s.localBridgeBaseUrl);
  const setLocalBridgeBaseUrl = useAppStore((s) => s.setLocalBridgeBaseUrl);
  const token = useAppStore((s) => s.localBridgeToken);
  const setLocalBridgeToken = useAppStore((s) => s.setLocalBridgeToken);
  const model = useAppStore((s) => s.localBridgeModel);
  const setLocalBridgeModel = useAppStore((s) => s.setLocalBridgeModel);
  const device = useAppStore((s) => s.localBridgeDevice);
  const setLocalBridgeDevice = useAppStore((s) => s.setLocalBridgeDevice);
  const source = useAppStore((s) => s.localBridgeSource);
  const setLocalBridgeSource = useAppStore((s) => s.setLocalBridgeSource);
  const platform = useAppStore((s) => s.platform);
  const channelName = useAppStore((s) => s.streamMetadata.channelName);

  const bridge = useLocalBridge();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const connected = bridge.connectionState === "connected";
  const streamUrl = buildStreamUrl(platform, channelName);

  // When Local Bridge is disabled, show just the enable toggle.
  if (!enabled) {
    return (
      <div className="bg-black/40 border border-white/10 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-black uppercase text-gray-400 tracking-widest flex items-center gap-1.5">
            <Radio className="w-3 h-3 text-purple-400" />
            Local Bridge
          </span>
          <button
            type="button"
            onClick={() => setLocalBridgeEnabled(true)}
            className="text-[9px] font-bold uppercase text-purple-400 hover:text-purple-300 transition-colors"
          >
            Enable
          </button>
        </div>
        <p className="text-[9px] text-gray-500 leading-relaxed">
          Transcribe stream audio locally with faster-whisper. No per-minute fees, no cloud STT account.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-black/40 border border-white/10 rounded-lg p-3 space-y-3">
      {/* Header: Bridge status + disable */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase text-gray-400 tracking-widest flex items-center gap-1.5">
          <Radio className="w-3 h-3 text-purple-400" />
          Local Bridge
        </span>
        <div className="flex items-center gap-2">
          <ConnectionBadge state={bridge.connectionState} />
          <button
            type="button"
            onClick={() => {
              if (bridge.isListening) bridge.stopListening();
              setLocalBridgeEnabled(false);
            }}
            className="text-[9px] font-bold uppercase text-gray-500 hover:text-gray-400 transition-colors"
          >
            Disable
          </button>
        </div>
      </div>

      {/* Disconnected state */}
      {!connected && (
        <div className="space-y-2">
          <p className="text-[9px] text-gray-400 leading-relaxed">
            {bridge.error || (
              bridge.connectionState === "checking" ? "Checking for Local Bridge..." :
              bridge.connectionState === "not_running" ? "Local Bridge isn't running on this computer. Start it, then retry." :
              bridge.connectionState === "permission_required" ? "Browser blocked localhost access. Allow Local Network Access for this site." :
              bridge.connectionState === "version_mismatch" ? "Bridge version is incompatible. Update the Local Bridge." :
              "Could not connect to Local Bridge."
            )}
          </p>
          <button
            type="button"
            onClick={bridge.retryConnection}
            className="w-full h-8 flex items-center justify-center gap-1.5 rounded text-[10px] font-bold uppercase tracking-wider bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 border border-purple-500/30 transition-colors"
          >
            <Wifi className="w-3 h-3" />
            Retry Connection
          </button>
          <AdvancedSettings
            show={showAdvanced}
            setShow={setShowAdvanced}
            baseUrl={baseUrl}
            setLocalBridgeBaseUrl={setLocalBridgeBaseUrl}
            token={token}
            setLocalBridgeToken={setLocalBridgeToken}
          />
        </div>
      )}

      {/* Connected state: controls */}
      {connected && (
        <div className="space-y-2.5">
          {/* Source selector */}
          <div>
            <label className="text-[9px] font-bold uppercase text-gray-500 tracking-wider block mb-1">Source</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setLocalBridgeSource("stream")}
                className={cn(
                  "h-7 rounded text-[10px] font-bold uppercase tracking-wider transition-colors border",
                  source === "stream"
                    ? "bg-purple-500/25 text-purple-300 border-purple-500/50"
                    : "bg-black/30 text-gray-500 border-white/10 hover:border-white/20"
                )}
              >
                Direct Stream
              </button>
              <button
                type="button"
                onClick={() => setLocalBridgeSource("system")}
                className={cn(
                  "h-7 rounded text-[10px] font-bold uppercase tracking-wider transition-colors border",
                  source === "system"
                    ? "bg-purple-500/25 text-purple-300 border-purple-500/50"
                    : "bg-black/30 text-gray-500 border-white/10 hover:border-white/20"
                )}
              >
                System Audio
              </button>
            </div>
          </div>

          {/* Stream URL (stream source only) */}
          {source === "stream" && (
            <div>
              <label className="text-[9px] font-bold uppercase text-gray-500 tracking-wider block mb-1">Stream</label>
              <div className="text-[10px] text-gray-400 font-mono bg-black/30 border border-white/10 rounded px-2 py-1.5 truncate">
                {streamUrl || "No active channel"}
              </div>
            </div>
          )}

          {/* System audio warning (system source only) */}
          {source === "system" && (
            <p className="text-[9px] text-amber-400/80 leading-relaxed bg-amber-500/5 border border-amber-500/20 rounded px-2 py-1.5">
              System Audio captures everything playing through your output device — Discord, music, and game audio may also be transcribed.
            </p>
          )}

          {/* Model + Device row */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] font-bold uppercase text-gray-500 tracking-wider block mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => setLocalBridgeModel(e.target.value)}
                disabled={bridge.isListening}
                className="w-full h-7 bg-black/30 border border-white/10 rounded px-1.5 text-[10px] text-gray-300 focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[9px] font-bold uppercase text-gray-500 tracking-wider block mb-1">Compute</label>
              <select
                value={device}
                onChange={(e) => setLocalBridgeDevice(e.target.value as BridgeDevice)}
                disabled={bridge.isListening}
                className="w-full h-7 bg-black/30 border border-white/10 rounded px-1.5 text-[10px] text-gray-300 focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
              >
                {DEVICES.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Model loading status */}
          {bridge.modelStatus && bridge.modelStatus.state !== "ready" && bridge.modelStatus.state !== "idle" && (
            <div className="flex items-center gap-1.5 text-[9px] text-amber-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              {bridge.modelStatus.state === "downloading_model"
                ? `Downloading ${bridge.modelStatus.model || model}…${bridge.modelStatus.progress ? ` ${Math.round(bridge.modelStatus.progress)}%` : ""}`
                : bridge.modelStatus.state === "loading_model"
                ? `Loading ${bridge.modelStatus.model || model}…`
                : bridge.modelStatus.state === "error"
                ? `Model error: ${bridge.modelStatus.error || "unknown"}`
                : bridge.modelStatus.state}
            </div>
          )}

          {/* Error display */}
          {bridge.error && bridge.errorCode && (
            <div className="flex items-start gap-1.5 text-[9px] text-red-400 bg-red-500/5 border border-red-500/20 rounded px-2 py-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{bridge.error}</span>
            </div>
          )}

          {/* Start/Stop button */}
          {bridge.isListening ? (
            <button
              type="button"
              onClick={bridge.stopListening}
              className="w-full h-9 flex items-center justify-center gap-2 rounded text-[10px] font-bold uppercase tracking-wider bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
              Stop Listening
            </button>
          ) : (
            <button
              type="button"
              onClick={() => bridge.startListening()}
              disabled={bridge.isStarting || (source === "stream" && !streamUrl)}
              className="w-full h-9 flex items-center justify-center gap-2 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {bridge.isStarting ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting…</>
              ) : (
                <><Radio className="w-3.5 h-3.5" /> Start Listening</>
              )}
            </button>
          )}

          {/* Status line: latency + backend */}
          {bridge.isListening && bridge.health && (
            <div className="flex items-center justify-between text-[9px] text-gray-500 font-mono">
              <span>
                {bridge.latencyMs != null ? `Latency: ${(bridge.latencyMs / 1000).toFixed(1)}s` : "Listening…"}
              </span>
              <span className="flex items-center gap-1">
                {bridge.health.transcription.device === "cuda" ? (
                  <><Cpu className="w-2.5 h-2.5" /> CUDA</>
                ) : bridge.health.transcription.device === "cpu" ? (
                  <><HardDrive className="w-2.5 h-2.5" /> CPU</>
                ) : null}
                {" · "}
                {bridge.health.transcription.model || model}
              </span>
            </div>
          )}

          <AdvancedSettings
            show={showAdvanced}
            setShow={setShowAdvanced}
            baseUrl={baseUrl}
            setLocalBridgeBaseUrl={setLocalBridgeBaseUrl}
            token={token}
            setLocalBridgeToken={setLocalBridgeToken}
          />
        </div>
      )}
    </div>
  );
}

// ── Connection badge ─────────────────────────────────────────────────────

function ConnectionBadge({ state }: { state: string }) {
  const config = {
    checking: { icon: Loader2, color: "text-amber-400", label: "Checking", spin: true },
    connected: { icon: Wifi, color: "text-emerald-400", label: "Connected", spin: false },
    not_running: { icon: WifiOff, color: "text-red-400", label: "Not detected", spin: false },
    permission_required: { icon: AlertTriangle, color: "text-amber-400", label: "Blocked", spin: false },
    version_mismatch: { icon: AlertTriangle, color: "text-amber-400", label: "Incompatible", spin: false },
    error: { icon: AlertTriangle, color: "text-red-400", label: "Error", spin: false },
  }[state] || { icon: WifiOff, color: "text-gray-500", label: state, spin: false };

  const Icon = config.icon;
  return (
    <span className={cn("flex items-center gap-1 text-[9px] font-bold uppercase", config.color)}>
      <Icon className={cn("w-2.5 h-2.5", config.spin && "animate-spin")} />
      {config.label}
    </span>
  );
}

// ── Advanced settings (collapsible) ─────────────────────────────────────

function AdvancedSettings({
  show,
  setShow,
  baseUrl,
  setLocalBridgeBaseUrl,
  token,
  setLocalBridgeToken,
}: {
  show: boolean;
  setShow: (v: boolean) => void;
  baseUrl: string;
  setLocalBridgeBaseUrl: (url: string) => void;
  token: string;
  setLocalBridgeToken: (t: string) => void;
}) {
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="flex items-center gap-1 text-[9px] font-bold uppercase text-gray-500 hover:text-gray-400 transition-colors"
      >
        <Settings2 className="w-2.5 h-2.5" />
        Details
        {show ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
      </button>
      {show && (
        <div className="mt-2 space-y-2">
          <div>
            <label className="text-[9px] font-bold uppercase text-gray-500 tracking-wider block mb-1">Bridge URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setLocalBridgeBaseUrl(e.target.value)}
              className="w-full h-7 bg-black/30 border border-white/10 rounded px-2 text-[10px] font-mono text-gray-300 focus:outline-none focus:border-purple-500/50"
              placeholder="http://127.0.0.1:8765"
            />
          </div>
          <div>
            <label className="text-[9px] font-bold uppercase text-gray-500 tracking-wider block mb-1">Token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setLocalBridgeToken(e.target.value)}
              className="w-full h-7 bg-black/30 border border-white/10 rounded px-2 text-[10px] font-mono text-gray-300 focus:outline-none focus:border-purple-500/50"
              placeholder="Paste the token from the Bridge console"
            />
            <p className="text-[8px] text-gray-600 mt-0.5 leading-relaxed">
              Run the Bridge — it prints a token on first start. Paste it here.
            </p>
          </div>
          <p className="text-[8px] text-gray-600 leading-relaxed">
            Local Bridge performs speech recognition locally. MADchatter may include transcript text in AI requests per your configured provider.
          </p>
        </div>
      )}
    </div>
  );
}
