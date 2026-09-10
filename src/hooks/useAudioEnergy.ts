import { useEffect, useRef } from "react";
import { useAppStore } from "../store";

/**
 * C4: Audio energy awareness
 * Monitors the microphone audio stream (when active) and computes RMS/peak energy.
 * Updates the store with a labeled energy level: silent | quiet | normal | loud | spike
 * AutoForge and personality engine can use this to detect silence, music, or spikes.
 */

const SAMPLE_INTERVAL_MS = 1000; // Update once per second
const SPIKE_THRESHOLD = 0.5; // RMS above this = spike
const LOUD_THRESHOLD = 0.2;
const NORMAL_THRESHOLD = 0.05;
const QUIET_THRESHOLD = 0.01;

export function useAudioEnergy(stream: MediaStream | null) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevRmsRef = useRef<number>(0);

  useEffect(() => {
    if (!stream) return;
    // Only proceed if the stream has audio tracks
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    try {
      const ctx = new AudioContext();
      // Browsers often create AudioContext in a suspended state until a user gesture;
      // attempt to resume so the analyser produces real data instead of zeros.
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      sourceRef.current = source;

      const buffer = new Uint8Array(analyser.frequencyBinCount);

      const computeEnergy = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buffer);
        let sumSq = 0;
        let peak = 0;
        // buffer values are 0-255 centered at 128
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128; // normalize to -1..1
          const absV = Math.abs(v);
          sumSq += v * v;
          if (absV > peak) peak = absV;
        }
        const rms = Math.sqrt(sumSq / buffer.length);

        // Detect spike: sudden jump from low to high
        const isSpike = rms > SPIKE_THRESHOLD && prevRmsRef.current < NORMAL_THRESHOLD;
        prevRmsRef.current = rms;

        let label: "silent" | "quiet" | "normal" | "loud" | "spike";
        if (isSpike || rms > SPIKE_THRESHOLD) label = "spike";
        else if (rms > LOUD_THRESHOLD) label = "loud";
        else if (rms > NORMAL_THRESHOLD) label = "normal";
        else if (rms > QUIET_THRESHOLD) label = "quiet";
        else label = "silent";

        useAppStore.getState().setAudioEnergy({
          rms,
          peak,
          label,
          updatedAt: Date.now(),
        });
      };

      intervalRef.current = setInterval(computeEnergy, SAMPLE_INTERVAL_MS);
      computeEnergy(); // initial reading
    } catch (e) {
      console.warn("[AudioEnergy] Failed to initialize:", e);
      // Clear stale energy state so AutoForge doesn't reference invalid data
      useAppStore.getState().setAudioEnergy(null);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (sourceRef.current) {
        try { sourceRef.current.disconnect(); } catch {}
        sourceRef.current = null;
      }
      if (analyserRef.current) {
        analyserRef.current = null;
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch {}
        audioContextRef.current = null;
      }
      // Clear stale energy state so AutoForge doesn't reference invalid data after the stream ends
      useAppStore.getState().setAudioEnergy(null);
    };
  }, [stream]);
}
