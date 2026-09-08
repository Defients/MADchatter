import { useRef, useState, useCallback, useEffect } from "react";
import { transcribeChunk, tryLoadWhisper, preloadWhisper } from "../lib/whisper";
import { buildDefaultVoiceCommands, parseVoiceCommand, type VoiceCommand } from "../lib/voiceCommands";
import { useAppStore } from "../store";
import { toast } from "sonner";

const VAD_SILENCE_THRESHOLD = 0.012;
const VAD_SILENCE_FRAMES = 25; // ~0.5s at 50ms chunks
const VAD_MAX_RECORDING_SECONDS = 10;

export function useVoiceCommands() {
  const [voiceCommandsActive, setVoiceCommandsActive] = useState(false);
  const [voiceCommandsListening, setVoiceCommandsListening] = useState(false);
  const [voiceCommandsNeedsDownload, setVoiceCommandsNeedsDownload] = useState(false);
  const [lastHeardCommand, setLastHeardCommand] = useState<string | null>(null);

  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceFrameCountRef = useRef(0);
  const recordingStartRef = useRef(0);
  const isRecordingRef = useRef(false);
  const activeRef = useRef(false);
  const commandsRef = useRef<VoiceCommand[]>([]);

  const getStore = useCallback(() => useAppStore.getState(), []);

  // Listen for toast events from voice commands
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.type === "success") toast.success(detail.msg);
      else if (detail.type === "error") toast.error(detail.msg);
      else toast.info(detail.msg);
    };
    const onStopTTS = () => {
      import("../lib/tts").then(({ stopSpeaking }) => stopSpeaking());
    };
    window.addEventListener("voice-toast", onToast);
    window.addEventListener("voice-stop-tts", onStopTTS);
    return () => {
      window.removeEventListener("voice-toast", onToast);
      window.removeEventListener("voice-stop-tts", onStopTTS);
    };
  }, []);

  const processRecording = useCallback(async () => {
    if (chunksRef.current.length === 0) return;

    const mimeType = chunksRef.current[0].type || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];

    if (blob.size < 500) return;

    try {
      const text = await transcribeChunk(blob);
      if (!text || !text.trim()) return;

      console.log("[VoiceCmd] Heard:", text);
      setLastHeardCommand(text.trim());

      const match = parseVoiceCommand(text, commandsRef.current);
      if (match) {
        console.log("[VoiceCmd] Matched command:", match.command.description);
        toast.success(`Voice: ${match.command.description}`, { description: `"${text.trim()}"` });
        await match.command.action();
      } else {
        toast.info(`Heard: "${text.trim()}" (no command matched)`);
      }
    } catch (e) {
      console.error("[VoiceCmd] Transcription failed:", e);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setVoiceCommandsListening(false);

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = () => {
        processRecording();
      };
      recorder.stop();
    }
  }, [processRecording]);

  const startRecording = useCallback(() => {
    if (isRecordingRef.current) return;
    if (!audioStreamRef.current) return;

    isRecordingRef.current = true;
    setVoiceCommandsListening(true);
    chunksRef.current = [];
    silenceFrameCountRef.current = 0;
    recordingStartRef.current = Date.now();

    let mimeType = "audio/webm";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "audio/ogg";
    }

    try {
      const recorder = new MediaRecorder(audioStreamRef.current, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(100);
    } catch (e) {
      console.error("[VoiceCmd] Failed to start recording:", e);
      isRecordingRef.current = false;
      setVoiceCommandsListening(false);
    }
  }, []);

  const startVAD = useCallback(() => {
    if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);

    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    vadIntervalRef.current = setInterval(() => {
      if (!activeRef.current || !analyserRef.current) return;

      // Check if currently recording
      if (isRecordingRef.current) {
        // Check for silence to stop
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length / 255;

        if (avg < VAD_SILENCE_THRESHOLD) {
          silenceFrameCountRef.current++;
          if (silenceFrameCountRef.current >= VAD_SILENCE_FRAMES) {
            stopRecording();
          }
        } else {
          silenceFrameCountRef.current = 0;
        }

        // Max recording time failsafe
        if (Date.now() - recordingStartRef.current > VAD_MAX_RECORDING_SECONDS * 1000) {
          stopRecording();
        }
      } else {
        // Check for speech to start
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length / 255;

        if (avg > VAD_SILENCE_THRESHOLD * 1.5) {
          startRecording();
        }
      }
    }, 50);
  }, [startRecording, stopRecording]);

  const startVoiceCommands = useCallback(async (): Promise<boolean> => {
    if (activeRef.current) return true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Load whisper
      const loaded = await tryLoadWhisper(5000);
      if (!loaded) {
        setVoiceCommandsNeedsDownload(true);
        // Still start VAD, will prompt for download on first transcription
      }

      // Build commands
      commandsRef.current = buildDefaultVoiceCommands(getStore);

      activeRef.current = true;
      setVoiceCommandsActive(true);
      startVAD();
      return true;
    } catch (e: any) {
      console.error("[VoiceCmd] Failed to start:", e);
      return false;
    }
  }, [getStore, startVAD]);

  const stopVoiceCommands = useCallback(() => {
    activeRef.current = false;
    setVoiceCommandsActive(false);
    setVoiceCommandsListening(false);
    isRecordingRef.current = false;

    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  const confirmVoiceCommandsDownload = useCallback(async (): Promise<boolean> => {
    setVoiceCommandsNeedsDownload(false);
    try {
      await preloadWhisper();
      return true;
    } catch (e) {
      console.error("[VoiceCmd] Model download failed:", e);
      return false;
    }
  }, []);

  const cancelVoiceCommandsDownload = useCallback(() => {
    setVoiceCommandsNeedsDownload(false);
  }, []);

  useEffect(() => {
    return () => {
      stopVoiceCommands();
    };
  }, [stopVoiceCommands]);

  return {
    voiceCommandsActive,
    voiceCommandsListening,
    voiceCommandsNeedsDownload,
    lastHeardCommand,
    startVoiceCommands,
    stopVoiceCommands,
    confirmVoiceCommandsDownload,
    cancelVoiceCommandsDownload,
  };
}
