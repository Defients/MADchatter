/**
 * useLocalBridge — React hook for the MADchatter Local Bridge.
 *
 * Manages:
 *  - connection probing (checking → connected/not_running/permission_required/...);
 *  - start/stop transcription sessions;
 *  - SSE event ingestion → existing appendAudioTranscript chokepoint;
 *  - status/error state for the UI;
 *  - cleanup on unmount / provider switch.
 *
 * Finalized transcript segments are routed through the existing
 * appendAudioTranscript action — the single chokepoint that feeds Room Model,
 * Perception Liveness, Spoken Callouts, and the audioTranscript string that
 * the AI pipeline reads. No separate local/cloud transcript architecture.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useAppStore } from "../store";
import { toast } from "sonner";
import {
  LocalBridgeClient,
  probeBridge,
  buildStreamUrl,
  bridgeErrorMessage,
  type BridgeConnectionState,
  type BridgeHealth,
  type BridgeEvent,
  type BridgeTranscriptionState,
  type BridgeModelStatus,
  type StartRequest,
  type LocalAudioSource,
  type BridgeDevice,
} from "../lib/localBridge";

export interface LocalBridgeHook {
  connectionState: BridgeConnectionState;
  health: BridgeHealth | null;
  transcriptionState: BridgeTranscriptionState | null;
  modelStatus: BridgeModelStatus | null;
  isListening: boolean;
  isStarting: boolean;
  error: string | null;
  errorCode: string | null;
  latencyMs: number | null;
  retryConnection: () => void;
  startListening: (overrides?: Partial<StartRequest>) => Promise<void>;
  stopListening: () => Promise<void>;
}

export function useLocalBridge(): LocalBridgeHook {
  const [connectionState, setConnectionState] = useState<BridgeConnectionState>("checking");
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [transcriptionState, setTranscriptionState] = useState<BridgeTranscriptionState | null>(null);
  const [modelStatus, setModelStatus] = useState<BridgeModelStatus | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // Store refs — read once, never re-subscribe.
  const enabled = useAppStore((s) => s.localBridgeEnabled);
  const baseUrl = useAppStore((s) => s.localBridgeBaseUrl);
  const token = useAppStore((s) => s.localBridgeToken);
  const model = useAppStore((s) => s.localBridgeModel);
  const device = useAppStore((s) => s.localBridgeDevice);
  const source = useAppStore((s) => s.localBridgeSource);
  const language = useAppStore((s) => s.localBridgeLanguage);
  const platform = useAppStore((s) => s.platform);
  const channelName = useAppStore((s) => s.streamMetadata.channelName);
  const appendAudioTranscript = useAppStore((s) => s.appendAudioTranscript);

  const clientRef = useRef<LocalBridgeClient | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Build/rebuild the client when baseUrl or token changes.
  useEffect(() => {
    clientRef.current = new LocalBridgeClient(baseUrl, token || null);
  }, [baseUrl, token]);

  // Probe the Bridge when enabled, baseUrl, or token changes.
  const probe = useCallback(async () => {
    if (!enabledRef.current) {
      setConnectionState("not_running");
      return;
    }
    setConnectionState("checking");
    setError(null);
    setErrorCode(null);
    const result = await probeBridge(baseUrl, token || null);
    setConnectionState(result.state);
    if (result.health) setHealth(result.health);
    if (result.error) {
      setError(result.error);
      if (result.state === "error") setErrorCode("INTERNAL_ERROR");
    }
  }, [baseUrl, token]);

  useEffect(() => {
    if (enabled) {
      probe();
    } else {
      setConnectionState("not_running");
      setHealth(null);
    }
  }, [enabled, probe]);

  // Auto-retry connection every 10s when not running and enabled.
  useEffect(() => {
    if (!enabled || connectionState === "connected" || connectionState === "checking") return;
    const timer = setInterval(() => {
      if (enabledRef.current) {
        probe();
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [enabled, connectionState, probe]);

  // SSE event handler.
  const handleEvent = useCallback((evt: BridgeEvent) => {
    switch (evt.type) {
      case "bridge.status":
        setTranscriptionState(evt.data);
        setIsListening(evt.data.state === "listening");
        if (evt.data.latencyMs != null) setLatencyMs(evt.data.latencyMs);
        if (evt.data.lastErrorCode) {
          setErrorCode(evt.data.lastErrorCode);
          setError(bridgeErrorMessage(evt.data.lastErrorCode, evt.data.lastError || undefined));
        }
        break;
      case "model.status":
        setModelStatus(evt.data);
        break;
      case "source.status":
        // Reconnecting / connecting — no direct UI action needed (bridge.status
        // carries the authoritative state).
        break;
      case "transcript.final": {
        // Format the segment to match the existing transcript line style:
        // [MM:SS] 'text' — same format Deepgram/Whisper use.
        const seg = evt.data;
        const elapsed = Date.now();
        const m = Math.floor((elapsed / 1000) % 3600 / 60).toString().padStart(2, "0");
        const s = (Math.floor(elapsed / 1000) % 60).toString().padStart(2, "0");
        const formatted = `[${m}:${s}] '${seg.text}'`;
        appendAudioTranscript(formatted);
        break;
      }
      case "transcript.partial":
        // v0.1 ships final segments only — partials are ignored for durable
        // ingestion. The UI could show a live preview, but partials never
        // enter memory or LLM context (prevents hallucinated text).
        break;
      case "transcription.error":
        setErrorCode(evt.data.code);
        setError(bridgeErrorMessage(evt.data.code, evt.data.message));
        toast.error(bridgeErrorMessage(evt.data.code, evt.data.message));
        setIsListening(false);
        setIsStarting(false);
        break;
      case "transcription.stopped":
        setIsListening(false);
        setIsStarting(false);
        setTranscriptionState(null);
        break;
    }
  }, [appendAudioTranscript]);

  // Open the SSE stream when connected.
  useEffect(() => {
    if (connectionState !== "connected" || !enabled) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }
    const client = clientRef.current;
    if (!client) return;
    // Close any existing stream before opening a new one.
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const es = client.openEventStream(handleEvent, () => {
      // EventSource auto-reconnects; we just note the error.
      // The connection probe will reclassify if the Bridge goes down.
    });
    eventSourceRef.current = es;
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [connectionState, enabled, handleEvent]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  const retryConnection = useCallback(() => {
    probe();
  }, [probe]);

  const startListening = useCallback(async (overrides?: Partial<StartRequest>) => {
    const client = clientRef.current;
    if (!client) return;
    if (connectionState !== "connected") {
      toast.error("Local Bridge is not connected.");
      return;
    }
    setIsStarting(true);
    setError(null);
    setErrorCode(null);
    try {
      const reqSource: LocalAudioSource = overrides?.source || source;
      const req: StartRequest = {
        source: reqSource,
        model: overrides?.model || model,
        device: (overrides?.device || device) as BridgeDevice,
        language: overrides?.language || language,
      };
      if (reqSource === "stream") {
        // Prefill from the active streamer URL if not overridden.
        const url = overrides?.url || buildStreamUrl(platform, channelName);
        if (!url) {
          toast.error("No active stream channel. Enter a Twitch/Kick URL or switch to System Audio.");
          setIsStarting(false);
          return;
        }
        req.url = url;
      } else if (reqSource === "system") {
        if (overrides?.deviceId) req.deviceId = overrides.deviceId;
      }
      await client.start(req);
      setIsListening(true);
      toast.success("Local transcription started.");
    } catch (e: unknown) {
      const err = e as Error & { code?: string };
      const code = err.code || "INTERNAL_ERROR";
      setErrorCode(code);
      setError(bridgeErrorMessage(code, err.message));
      toast.error(bridgeErrorMessage(code, err.message));
    } finally {
      setIsStarting(false);
    }
  }, [connectionState, source, model, device, language, platform, channelName]);

  const stopListening = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setIsStarting(false);
    try {
      await client.stop();
      setIsListening(false);
      setTranscriptionState(null);
      toast.success("Local transcription stopped.");
    } catch (e: unknown) {
      const err = e as Error & { code?: string };
      const code = err.code || "INTERNAL_ERROR";
      setErrorCode(code);
      setError(bridgeErrorMessage(code, err.message));
    }
  }, []);

  return {
    connectionState,
    health,
    transcriptionState,
    modelStatus,
    isListening,
    isStarting,
    error,
    errorCode,
    latencyMs,
    retryConnection,
    startListening,
    stopListening,
  };
}
