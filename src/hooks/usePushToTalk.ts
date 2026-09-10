import { useRef, useState, useCallback, useEffect } from "react";
import { transcribeChunk, tryLoadWhisper, preloadWhisper } from "../lib/whisper";

// Shared mic permission cache — once granted, reused so no popup on subsequent uses
let sharedMicStream: MediaStream | null = null;

export async function ensureMicPermission(): Promise<MediaStream | null> {
  if (sharedMicStream && sharedMicStream.active) {
    return sharedMicStream;
  }
  if (sharedMicStream) {
    sharedMicStream.getTracks().forEach((t) => t.stop());
    sharedMicStream = null;
  }
  try {
    sharedMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return sharedMicStream;
  } catch {
    return null;
  }
}

export function hasMicPermission(): boolean {
  return sharedMicStream !== null && sharedMicStream.active;
}

export function usePushToTalk() {
  const [pttActive, setPttActive] = useState(false);
  const [pttLoading, setPttLoading] = useState(false);
  const [pttNeedsDownload, setPttNeedsDownload] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingRef = useRef(false);

  const startPtt = useCallback(async (): Promise<boolean> => {
    if (recordingRef.current) return false;

    try {
      // Use shared permission stream if available, otherwise request fresh
      let stream: MediaStream;
      if (sharedMicStream && sharedMicStream.active) {
        stream = new MediaStream(sharedMicStream.getTracks().map((t) => t.clone()));
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        sharedMicStream = stream;
      }
      audioStreamRef.current = stream;
      chunksRef.current = [];

      let mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "audio/ogg";
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(250);
      recordingRef.current = true;
      setPttActive(true);
      return true;
    } catch (e: any) {
      console.error("[PTT] Failed to start:", e);
      return false;
    }
  }, []);

  const stopPtt = useCallback(async (): Promise<string | null> => {
    if (!recordingRef.current) return null;
    recordingRef.current = false;
    setPttActive(false);

    return new Promise<string | null>((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        resolve(null);
        return;
      }

      recorder.onstop = async () => {
        // Clean up cloned tracks (not the shared stream)
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach((t) => t.stop());
          audioStreamRef.current = null;
        }
        mediaRecorderRef.current = null;

        if (chunksRef.current.length === 0) {
          resolve(null);
          return;
        }

        const mimeType = chunksRef.current[0].type || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];

        if (blob.size < 200) {
          resolve(null);
          return;
        }

        setPttLoading(true);
        try {
          const loaded = await tryLoadWhisper(5000);
          if (!loaded) {
            setPttNeedsDownload(true);
            resolve(null);
            return;
          }
          const text = await transcribeChunk(blob);
          resolve(text || null);
        } catch (e) {
          console.error("[PTT] Transcription failed:", e);
          resolve(null);
        } finally {
          setPttLoading(false);
        }
      };

      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        resolve(null);
      }
    });
  }, []);

  // Toggle mode: shift+click to start, shift+click again to stop and transcribe
  const togglePtt = useCallback(async (): Promise<string | null> => {
    if (recordingRef.current) {
      return stopPtt();
    } else {
      const ok = await startPtt();
      if (!ok) return null;
      return null;
    }
  }, [startPtt, stopPtt]);

  const confirmPttDownload = useCallback(async (): Promise<boolean> => {
    setPttNeedsDownload(false);
    setPttLoading(true);
    try {
      await preloadWhisper();
      setPttLoading(false);
      return true;
    } catch (e) {
      console.error("[PTT] Model download failed:", e);
      setPttLoading(false);
      return false;
    }
  }, []);

  const cancelPttDownload = useCallback(() => {
    setPttNeedsDownload(false);
  }, []);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current = false;
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach((t) => t.stop());
        }
      }
    };
  }, []);

  return {
    pttActive,
    pttLoading,
    pttNeedsDownload,
    startPtt,
    stopPtt,
    togglePtt,
    confirmPttDownload,
    cancelPttDownload,
  };
}
