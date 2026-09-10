import { useState, useRef, useCallback, useEffect } from 'react';
import { transcribeChunk, tryLoadWhisper, preloadWhisper } from '../lib/whisper';

export function useDeepgramTranscription() {
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<'deepgram' | 'whisper' | null>(null);
  const [whisperPrompt, setWhisperPrompt] = useState(false);
  const [whisperDownloading, setWhisperDownloading] = useState(false);

  const audioStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const deepgramConnectionRef = useRef<WebSocket | null>(null);
  const startTimeRef = useRef<number>(0);
  const onTranscriptUpdateRef = useRef<((segment: string) => void) | null>(null);
  const whisperActiveRef = useRef(false);
  const voiceEnabledRef = useRef(false);
  const whisperProcessingRef = useRef(false);
  const whisperQueueRef = useRef<Blob[]>([]);
  const whisperIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const whisperPendingRef = useRef<{ source: 'system' | 'microphone'; onTranscriptUpdate: (segment: string) => void } | null>(null);
  const whisperEmbedPendingRef = useRef<{ stream: MediaStream; onTranscriptUpdate: (segment: string) => void } | null>(null);

  const stopDeepgram = useCallback(() => {
    whisperActiveRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop());
    }
    if (deepgramConnectionRef.current) {
      deepgramConnectionRef.current.close();
    }
    
    mediaRecorderRef.current = null;
    audioStreamRef.current = null;
    deepgramConnectionRef.current = null;
    whisperProcessingRef.current = false;
    whisperQueueRef.current = [];
    if (whisperIntervalRef.current) {
      clearInterval(whisperIntervalRef.current);
      whisperIntervalRef.current = null;
    }
    whisperPendingRef.current = null;
    whisperEmbedPendingRef.current = null;
    voiceEnabledRef.current = false;
    setVoiceEnabled(false);
    setIsConnecting(false);
    setVoiceMode(null);
    setWhisperPrompt(false);
    setWhisperDownloading(false);
  }, []);

  const startDeepgram = useCallback(async (apiKey: string, source: 'system' | 'microphone', onTranscriptUpdate: (segment: string) => void) => {
    setIsConnecting(true);
    setError(null);
    onTranscriptUpdateRef.current = onTranscriptUpdate;

    try {
      let stream: MediaStream;
      if (source === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(track => track.stop());
      }
      
      if (stream.getAudioTracks().length === 0) {
        throw new Error('No audio track selected.');
      }
      
      audioStreamRef.current = stream;
      connectDeepgram(apiKey, stream);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Permission denied to capture audio.');
      } else {
        setError(err.message || 'Failed to start Deepgram');
      }
      stopDeepgram();
    }
  }, [stopDeepgram]);

  const startEmbedCapture = useCallback(async (apiKey: string, stream: MediaStream, onTranscriptUpdate: (segment: string) => void) => {
    setIsConnecting(true);
    setError(null);
    onTranscriptUpdateRef.current = onTranscriptUpdate;

    try {
      if (stream.getAudioTracks().length === 0) {
        throw new Error('No audio track in stream.');
      }
      audioStreamRef.current = stream;
      connectDeepgram(apiKey, stream);
    } catch (err: any) {
      setError(err.message || 'Failed to start embed capture');
      stopDeepgram();
    }
  }, [stopDeepgram]);

  const connectDeepgram = (apiKey: string, stream: MediaStream) => {
    const wsUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&punctuate=true&interim_results=true&endpointing=500';
    const ws = new WebSocket(wsUrl, ['token', apiKey]);
    deepgramConnectionRef.current = ws;

    ws.onopen = () => {
      startTimeRef.current = Date.now();
      voiceEnabledRef.current = true;
      setVoiceEnabled(true);
      setIsConnecting(false);
      
      try {
        let mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/ogg';
        }
        
        const recorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = recorder;

        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(event.data);
          }
        });

        recorder.start(250);
      } catch (e: any) {
        setError('Failed to start audio recording: ' + e.message);
        stopDeepgram();
      }
    };

    ws.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data as string);
        if (data.is_final || data.speech_final) {
          const transcript = data.channel.alternatives[0].transcript;
          if (transcript.trim().length > 0) {
            const elapsedSeconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
            const m = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
            const s = (elapsedSeconds % 60).toString().padStart(2, '0');
            const formattedSegment = `[${m}:${s}] '${transcript}'`;
            onTranscriptUpdateRef.current?.(formattedSegment);
          }
        }
      } catch (e) {
        console.error("Deepgram parsing error:", e);
      }
    };

    ws.onerror = () => {
      setError('WebSocket error connecting to Deepgram');
      stopDeepgram();
    };
    
    ws.onclose = () => {
      if (voiceEnabledRef.current) {
        stopDeepgram();
      }
    };
  };

  useEffect(() => {
    return () => {
      stopDeepgram();
    };
  }, [stopDeepgram]);

  const processWhisperBlob = useCallback(async (blob: Blob) => {
    if (whisperProcessingRef.current) {
      whisperQueueRef.current.push(blob);
      return;
    }
    whisperProcessingRef.current = true;
    try {
      const transcript = await transcribeChunk(blob);
      if (transcript && whisperActiveRef.current) {
        const elapsedSeconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const m = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
        const s = (elapsedSeconds % 60).toString().padStart(2, '0');
        const formattedSegment = `[${m}:${s}] '${transcript}'`;
        onTranscriptUpdateRef.current?.(formattedSegment);
      }
    } catch (e: any) {
      console.error('Whisper transcription error:', e);
    } finally {
      whisperProcessingRef.current = false;
      if (whisperQueueRef.current.length > 0 && whisperActiveRef.current) {
        processWhisperBlob(whisperQueueRef.current.shift()!);
      }
    }
  }, []);

  const startWhisperCycle = useCallback((stream: MediaStream) => {
    if (!whisperActiveRef.current) return;

    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/ogg';
    }

    try {
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      const cycleChunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          cycleChunks.push(event.data);
        }
      };

      recorder.onerror = (e: any) => {
        console.error('[Whisper] MediaRecorder error:', e?.error?.message || e);
      };

      recorder.onstop = () => {
        if (cycleChunks.length > 0 && whisperActiveRef.current) {
          const combinedBlob = new Blob(cycleChunks, { type: mimeType });
          processWhisperBlob(combinedBlob);
        }
        if (whisperActiveRef.current) {
          startWhisperCycle(stream);
        }
      };

      recorder.start(1000);
    } catch (e: any) {
      console.error('[Whisper] Failed to start MediaRecorder:', e?.message);
      if (whisperActiveRef.current) {
        setTimeout(() => startWhisperCycle(stream), 2000);
      }
    }
  }, [processWhisperBlob]);

  const beginWhisperRecording = useCallback(async (source: 'system' | 'microphone') => {
    try {
      let stream: MediaStream;
      if (source === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        stream.getVideoTracks().forEach(track => track.stop());
      }

      if (stream.getAudioTracks().length === 0) {
        throw new Error('No audio track selected.');
      }

      audioStreamRef.current = stream;
      whisperActiveRef.current = true;
      whisperQueueRef.current = [];
      startTimeRef.current = Date.now();
      voiceEnabledRef.current = true;
      setVoiceEnabled(true);
      setVoiceMode('whisper');
      setIsConnecting(false);
      setWhisperDownloading(false);

      startWhisperCycle(stream);
      whisperIntervalRef.current = setInterval(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 15000);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Permission denied to capture audio.');
      } else {
        setError(err.message || 'Failed to start Whisper transcription');
      }
      stopDeepgram();
    }
  }, [stopDeepgram, startWhisperCycle]);

  const startWhisper = useCallback(async (source: 'system' | 'microphone', onTranscriptUpdate: (segment: string) => void) => {
    setIsConnecting(true);
    setError(null);
    onTranscriptUpdateRef.current = onTranscriptUpdate;

    const loaded = await tryLoadWhisper();
    if (!loaded) {
      whisperPendingRef.current = { source, onTranscriptUpdate };
      setWhisperPrompt(true);
      setIsConnecting(false);
      return;
    }

    await beginWhisperRecording(source);
  }, [stopDeepgram, beginWhisperRecording]);

  const beginEmbedWhisperRecording = useCallback(async (stream: MediaStream) => {
    if (stream.getAudioTracks().length === 0) {
      throw new Error('No audio track in stream.');
    }
    audioStreamRef.current = stream;
    whisperActiveRef.current = true;
    whisperQueueRef.current = [];
    startTimeRef.current = Date.now();
    voiceEnabledRef.current = true;
    setVoiceEnabled(true);
    setVoiceMode('whisper');
    setIsConnecting(false);
    setWhisperDownloading(false);

    startWhisperCycle(stream);
    whisperIntervalRef.current = setInterval(() => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    }, 15000);
  }, [startWhisperCycle]);

  const confirmWhisperDownload = useCallback(async () => {
    const pending = whisperPendingRef.current;
    const embedPending = whisperEmbedPendingRef.current;
    if (!pending && !embedPending) return;
    setWhisperPrompt(false);
    setWhisperDownloading(true);
    setIsConnecting(true);
    try {
      await preloadWhisper();
      if (embedPending) {
        await beginEmbedWhisperRecording(embedPending.stream);
      } else if (pending) {
        await beginWhisperRecording(pending.source);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to download Whisper model');
      stopDeepgram();
    }
  }, [stopDeepgram, beginWhisperRecording, beginEmbedWhisperRecording]);

  const cancelWhisperDownload = useCallback(() => {
    whisperPendingRef.current = null;
    whisperEmbedPendingRef.current = null;
    setWhisperPrompt(false);
    setWhisperDownloading(false);
    setIsConnecting(false);
    setVoiceEnabled(false);
    setVoiceMode(null);
  }, []);

  const startEmbedWhisper = useCallback(async (stream: MediaStream, onTranscriptUpdate: (segment: string) => void): Promise<boolean> => {
    setIsConnecting(true);
    setError(null);
    onTranscriptUpdateRef.current = onTranscriptUpdate;

    try {
      const loaded = await tryLoadWhisper();
      if (!loaded) {
        whisperEmbedPendingRef.current = { stream, onTranscriptUpdate };
        setWhisperPrompt(true);
        setIsConnecting(false);
        return true;
      }

      await beginEmbedWhisperRecording(stream);
      return false;
    } catch (err: any) {
      setError(err.message || 'Failed to start Whisper transcription');
      stopDeepgram();
      return false;
    }
  }, [stopDeepgram, beginEmbedWhisperRecording]);

  return { voiceEnabled, isConnecting, error, voiceMode, whisperPrompt, whisperDownloading, startDeepgram, startEmbedCapture, startWhisper, startEmbedWhisper, confirmWhisperDownload, cancelWhisperDownload, stopDeepgram };
}
