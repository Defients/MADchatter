import { useAppStore } from "../store";
import {
  mobileAudioCueAllowed,
  shouldSuppressLowerPriorityCue,
  type MobileAudioCue,
} from "./mobileAudioPolicy";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SfxEvent =
  | "forge_start"
  | "forge_complete"
  | "send_message"
  | "autoforge_action"
  | "refine_complete"
  | "error"
  | "konami"
  | "max_rage"
  | "welcome_dismiss"
  | "palette_open"
  | "palette_close"
  | "palette_select"
  | "autoforge_on"
  | "autoforge_off"
  | "hud_open"
  | "hud_close"
  | "report_open"
  | "report_close"
  | "theme_toggle"
  | "variant_close"
  | "copy"
  | "settings_save"
  | "memory_add"
  | "memory_remove"
  | "clear_context"
  | "connect"
  | "disconnect"
  | "history_toggle"
  | "fidget_spin"
  | "secret_word"
  | "secret_lab"
  | "panel_collapse"
  | "panel_expand"
  | "slider_commit"
  | "select_change"
  | "force_burst"
  | "mention_alert";

type Theme = "default" | "cosmotech";

interface SynthLayer {
  type: OscillatorType;
  freq: number | [number, number]; // fixed or [start, end] for sweep
  gain: number;
  attack: number;
  decay: number;
  sustain: number; // 0-1 relative to gain
  release: number;
  detune?: number; // cents
  delay?: number; // seconds before this layer starts
  filterFreq?: number; // lowpass filter cutoff for this layer
}

interface SynthConfig {
  layers: SynthLayer[];
  duration: number;
  reverb?: { decay: number; wet: number };
  delay?: { time: number; feedback: number; wet: number };
}

type SoundDefinition = { type: "synth"; synth: SynthConfig };

// ─── Audio Context (lazy init) ────────────────────────────────────────────────

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let currentSinkId: string | null = null;
let activePriorityCue: { cue: MobileAudioCue; until: number } | null = null;

export function reserveAudioPriority(cue: MobileAudioCue, durationMs: number): void {
  const now = Date.now();
  if (!activePriorityCue || activePriorityCue.until <= now ||
    !shouldSuppressLowerPriorityCue(cue, activePriorityCue, now)) {
    activePriorityCue = { cue, until: now + Math.max(0, durationMs) };
  }
}

function cueForSfx(event: SfxEvent): MobileAudioCue {
  if (event === "error" || event === "disconnect") return "error";
  if (event === "send_message" || event === "forge_complete" || event === "refine_complete") return "send_complete";
  if (event === "forge_start" || event === "autoforge_action" || event === "autoforge_on" || event === "autoforge_off") return "major_action";
  if (event === "slider_commit") return "slider_commit";
  if (event === "select_change" || event === "settings_save") return "setting_select";
  return "navigation";
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

export async function setSfxOutputSink(deviceId: string): Promise<void> {
  currentSinkId = deviceId;
  const c = getCtx();
  if (c && typeof (c as any).setSinkId === "function") {
    try {
      await (c as any).setSinkId(deviceId);
    } catch {
      // not supported, ignore
    }
  }
}

// ─── Synth Helpers ────────────────────────────────────────────────────────────

function playSynth(config: SynthConfig, volume: number): void {
  const c = getCtx();
  if (!c || !masterGain) return;

  const now = c.currentTime;
  const output = c.createGain();
  output.gain.value = volume;
  output.connect(masterGain);

  // Reverb (simple convolver-free approach: delayed gain decay)
  let reverbInput: GainNode = output;
  if (config.reverb) {
    const reverbGain = c.createGain();
    reverbGain.gain.value = config.reverb.wet;
    const delay = c.createDelay(2);
    delay.delayTime.value = 0.03;
    const feedback = c.createGain();
    feedback.gain.value = 0.4;
    const reverbDuration = config.reverb.decay;
    // Simple reverb: feedback delay with decay envelope
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(reverbGain);
    reverbGain.connect(output);
    reverbInput = c.createGain();
    reverbInput.connect(output);
    reverbInput.connect(delay);
    // Decay the feedback over time
    feedback.gain.setValueAtTime(0.4, now);
    feedback.gain.exponentialRampToValueAtTime(0.001, now + reverbDuration);
  }

  // Delay effect
  if (config.delay) {
    const delayNode = c.createDelay(1);
    delayNode.delayTime.value = config.delay.time;
    const feedback = c.createGain();
    feedback.gain.value = config.delay.feedback;
    const wetGain = c.createGain();
    wetGain.gain.value = config.delay.wet;
    delayNode.connect(feedback);
    feedback.connect(delayNode);
    delayNode.connect(wetGain);
    wetGain.connect(output);
    reverbInput.connect(delayNode);
  }

  for (const layer of config.layers) {
    const startAt = now + (layer.delay || 0);
    const osc = c.createOscillator();
    osc.type = layer.type;
    osc.detune.value = layer.detune || 0;

    // Frequency (fixed or sweep)
    if (typeof layer.freq === "number") {
      osc.frequency.setValueAtTime(layer.freq, startAt);
    } else {
      osc.frequency.setValueAtTime(layer.freq[0], startAt);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, layer.freq[1]),
        startAt + layer.attack + layer.decay,
      );
    }

    // Envelope
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, startAt);
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.001, layer.gain),
      startAt + layer.attack,
    );
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.001, layer.gain * layer.sustain),
      startAt + layer.attack + layer.decay,
    );
    const releaseStart = startAt + layer.attack + layer.decay + 0.01;
    env.gain.exponentialRampToValueAtTime(
      0.0001,
      releaseStart + layer.release,
    );

    // Per-layer filter
    let layerOutput: AudioNode = osc;
    if (layer.filterFreq) {
      const filter = c.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = layer.filterFreq;
      osc.connect(filter);
      layerOutput = filter;
    }

    layerOutput.connect(env);
    env.connect(reverbInput);

    osc.start(startAt);
    osc.stop(startAt + layer.attack + layer.decay + layer.release + 0.1);
  }
}

// ─── Sound Definitions ────────────────────────────────────────────────────────
// Each theme has its own synth config for every SfxEvent.
// Default = warm/organic/arcade. CosmoTech = clean/digital/sci-fi.

const DEFAULT_SOUNDS: Record<SfxEvent, SoundDefinition> = {
  // ── Tier 1: Major Actions ──
  forge_start: {
    type: "synth",
    synth: {
      duration: 0.8,
      layers: [
        { type: "sawtooth", freq: [80, 200], gain: 0.35, attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.4, filterFreq: 800 },
        { type: "square", freq: [120, 300], gain: 0.15, attack: 0.02, decay: 0.2, sustain: 0.1, release: 0.3, filterFreq: 600 },
        { type: "triangle", freq: 60, gain: 0.3, attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.5 },
      ],
    },
  },
  forge_complete: {
    type: "synth",
    synth: {
      duration: 0.6,
      reverb: { decay: 1.2, wet: 0.25 },
      layers: [
        { type: "triangle", freq: 660, gain: 0.25, attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.4 },
        { type: "triangle", freq: 880, gain: 0.2, attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.4, delay: 0.08 },
        { type: "triangle", freq: 1320, gain: 0.15, attack: 0.01, decay: 0.15, sustain: 0.2, release: 0.35, delay: 0.16 },
        { type: "sawtooth", freq: [2000, 4000], gain: 0.05, attack: 0.01, decay: 0.05, sustain: 0, release: 0.1, delay: 0.2 },
      ],
    },
  },
  send_message: {
    type: "synth",
    synth: {
      duration: 0.3,
      layers: [
        { type: "sawtooth", freq: [400, 1200], gain: 0.2, attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.15, filterFreq: 2000 },
        { type: "square", freq: [800, 1600], gain: 0.1, attack: 0.005, decay: 0.03, sustain: 0, release: 0.1 },
      ],
    },
  },
  autoforge_action: {
    type: "synth",
    synth: {
      duration: 0.4,
      layers: [
        { type: "square", freq: [200, 150], gain: 0.15, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.2 },
        { type: "sawtooth", freq: 100, gain: 0.2, attack: 0.005, decay: 0.08, sustain: 0.2, release: 0.25, filterFreq: 400 },
        { type: "triangle", freq: 300, gain: 0.1, attack: 0.01, decay: 0.05, sustain: 0.1, release: 0.15, delay: 0.05 },
      ],
    },
  },
  refine_complete: {
    type: "synth",
    synth: {
      duration: 0.5,
      reverb: { decay: 0.8, wet: 0.2 },
      layers: [
        { type: "triangle", freq: [800, 1200], gain: 0.15, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.3 },
        { type: "sine", freq: [1600, 2400], gain: 0.1, attack: 0.01, decay: 0.08, sustain: 0.2, release: 0.25, delay: 0.05 },
        { type: "sine", freq: [2400, 3200], gain: 0.06, attack: 0.01, decay: 0.06, sustain: 0.1, release: 0.2, delay: 0.1 },
      ],
    },
  },
  error: {
    type: "synth",
    synth: {
      duration: 0.5,
      layers: [
        { type: "sawtooth", freq: [200, 80], gain: 0.25, attack: 0.005, decay: 0.1, sustain: 0.2, release: 0.3, filterFreq: 500 },
        { type: "square", freq: [150, 60], gain: 0.15, attack: 0.005, decay: 0.1, sustain: 0.2, release: 0.3, delay: 0.05 },
        { type: "sawtooth", freq: [300, 100], gain: 0.1, attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.2, delay: 0.1, filterFreq: 300 },
      ],
    },
  },
  konami: {
    type: "synth",
    synth: {
      duration: 1.2,
      layers: [
        { type: "square", freq: 523, gain: 0.15, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.15 },
        { type: "square", freq: 659, gain: 0.15, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.15, delay: 0.15 },
        { type: "square", freq: 784, gain: 0.15, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.15, delay: 0.3 },
        { type: "square", freq: 1047, gain: 0.2, attack: 0.01, decay: 0.15, sustain: 0.4, release: 0.3, delay: 0.45 },
        { type: "square", freq: 784, gain: 0.12, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.2, delay: 0.7 },
        { type: "square", freq: 1047, gain: 0.18, attack: 0.01, decay: 0.15, sustain: 0.4, release: 0.4, delay: 0.9 },
      ],
    },
  },
  max_rage: {
    type: "synth",
    synth: {
      duration: 1.0,
      layers: [
        { type: "sawtooth", freq: [100, 300], gain: 0.3, attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.6, filterFreq: 1000 },
        { type: "sawtooth", freq: [300, 800], gain: 0.2, attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.5, delay: 0.1, filterFreq: 1500 },
        { type: "square", freq: [50, 150], gain: 0.25, attack: 0.005, decay: 0.1, sustain: 0.5, release: 0.7 },
        { type: "sawtooth", freq: [2000, 5000], gain: 0.08, attack: 0.005, decay: 0.05, sustain: 0.2, release: 0.3, delay: 0.2, filterFreq: 3000 },
      ],
    },
  },
  welcome_dismiss: {
    type: "synth",
    synth: {
      duration: 0.8,
      reverb: { decay: 1.5, wet: 0.3 },
      layers: [
        { type: "triangle", freq: [400, 600], gain: 0.2, attack: 0.05, decay: 0.2, sustain: 0.4, release: 0.5 },
        { type: "triangle", freq: [600, 800], gain: 0.15, attack: 0.05, decay: 0.2, sustain: 0.4, release: 0.5, delay: 0.1 },
        { type: "sine", freq: [800, 1200], gain: 0.1, attack: 0.05, decay: 0.2, sustain: 0.3, release: 0.4, delay: 0.2 },
      ],
    },
  },

  // ── Tier 2: UI Interactions ──
  palette_open: {
    type: "synth",
    synth: {
      duration: 0.25,
      layers: [
        { type: "triangle", freq: [400, 800], gain: 0.15, attack: 0.01, decay: 0.08, sustain: 0.1, release: 0.12, filterFreq: 2000 },
        { type: "sine", freq: [800, 1600], gain: 0.08, attack: 0.01, decay: 0.05, sustain: 0, release: 0.1 },
      ],
    },
  },
  palette_close: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "triangle", freq: [800, 400], gain: 0.12, attack: 0.01, decay: 0.06, sustain: 0.1, release: 0.1, filterFreq: 1500 },
      ],
    },
  },
  palette_select: {
    type: "synth",
    synth: {
      duration: 0.12,
      layers: [
        { type: "square", freq: 1000, gain: 0.1, attack: 0.005, decay: 0.03, sustain: 0, release: 0.06 },
        { type: "triangle", freq: 600, gain: 0.08, attack: 0.005, decay: 0.02, sustain: 0, release: 0.05 },
      ],
    },
  },
  autoforge_on: {
    type: "synth",
    synth: {
      duration: 0.5,
      layers: [
        { type: "sawtooth", freq: [200, 600], gain: 0.18, attack: 0.02, decay: 0.15, sustain: 0.3, release: 0.25, filterFreq: 1500 },
        { type: "triangle", freq: [400, 800], gain: 0.12, attack: 0.02, decay: 0.12, sustain: 0.3, release: 0.2, delay: 0.05 },
      ],
    },
  },
  autoforge_off: {
    type: "synth",
    synth: {
      duration: 0.4,
      layers: [
        { type: "sawtooth", freq: [600, 200], gain: 0.18, attack: 0.02, decay: 0.12, sustain: 0.3, release: 0.2, filterFreq: 1000 },
        { type: "triangle", freq: [800, 300], gain: 0.1, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.18, delay: 0.03 },
      ],
    },
  },
  hud_open: {
    type: "synth",
    synth: {
      duration: 0.25,
      layers: [
        { type: "triangle", freq: [300, 500], gain: 0.12, attack: 0.01, decay: 0.08, sustain: 0.2, release: 0.12 },
        { type: "sine", freq: 150, gain: 0.1, attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.15 },
      ],
    },
  },
  hud_close: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "triangle", freq: [500, 300], gain: 0.1, attack: 0.01, decay: 0.06, sustain: 0.1, release: 0.1 },
        { type: "sine", freq: 150, gain: 0.08, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.12 },
      ],
    },
  },
  report_open: {
    type: "synth",
    synth: {
      duration: 0.35,
      layers: [
        { type: "triangle", freq: [250, 450], gain: 0.12, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.15 },
        { type: "sawtooth", freq: [100, 200], gain: 0.08, attack: 0.01, decay: 0.08, sustain: 0.1, release: 0.15, filterFreq: 600 },
      ],
    },
  },
  report_close: {
    type: "synth",
    synth: {
      duration: 0.25,
      layers: [
        { type: "triangle", freq: [450, 250], gain: 0.1, attack: 0.01, decay: 0.08, sustain: 0.15, release: 0.12 },
      ],
    },
  },
  theme_toggle: {
    type: "synth",
    synth: {
      duration: 0.5,
      reverb: { decay: 0.8, wet: 0.2 },
      layers: [
        { type: "triangle", freq: [500, 800], gain: 0.12, attack: 0.02, decay: 0.15, sustain: 0.3, release: 0.25 },
        { type: "sine", freq: [1000, 1500], gain: 0.08, attack: 0.02, decay: 0.12, sustain: 0.2, release: 0.2, delay: 0.05 },
        { type: "triangle", freq: [800, 1200], gain: 0.06, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.2, delay: 0.1 },
      ],
    },
  },
  variant_close: {
    type: "synth",
    synth: {
      duration: 0.15,
      layers: [
        { type: "triangle", freq: [600, 200], gain: 0.1, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.08, filterFreq: 1500 },
        { type: "sine", freq: [1200, 400], gain: 0.05, attack: 0.005, decay: 0.03, sustain: 0, release: 0.06 },
      ],
    },
  },
  copy: {
    type: "synth",
    synth: {
      duration: 0.15,
      layers: [
        { type: "sawtooth", freq: [1500, 2500], gain: 0.08, attack: 0.005, decay: 0.03, sustain: 0, release: 0.08, filterFreq: 3000 },
        { type: "triangle", freq: 800, gain: 0.06, attack: 0.005, decay: 0.02, sustain: 0, release: 0.06, delay: 0.02 },
      ],
    },
  },
  settings_save: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "square", freq: 600, gain: 0.1, attack: 0.005, decay: 0.03, sustain: 0.2, release: 0.1 },
        { type: "triangle", freq: 900, gain: 0.08, attack: 0.005, decay: 0.03, sustain: 0.2, release: 0.1, delay: 0.04 },
      ],
    },
  },
  memory_add: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "triangle", freq: [400, 700], gain: 0.12, attack: 0.01, decay: 0.06, sustain: 0.2, release: 0.1 },
        { type: "sine", freq: 200, gain: 0.08, attack: 0.005, decay: 0.03, sustain: 0.1, release: 0.12 },
      ],
    },
  },
  memory_remove: {
    type: "synth",
    synth: {
      duration: 0.15,
      layers: [
        { type: "triangle", freq: [700, 300], gain: 0.1, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.08 },
        { type: "sine", freq: 200, gain: 0.06, attack: 0.005, decay: 0.03, sustain: 0.1, release: 0.08 },
      ],
    },
  },
  clear_context: {
    type: "synth",
    synth: {
      duration: 0.4,
      layers: [
        { type: "sawtooth", freq: [2000, 200], gain: 0.12, attack: 0.01, decay: 0.15, sustain: 0.1, release: 0.2, filterFreq: 2500 },
        { type: "triangle", freq: [1000, 100], gain: 0.08, attack: 0.01, decay: 0.12, sustain: 0.1, release: 0.18, delay: 0.05 },
      ],
    },
  },
  connect: {
    type: "synth",
    synth: {
      duration: 0.3,
      layers: [
        { type: "triangle", freq: [500, 700], gain: 0.12, attack: 0.02, decay: 0.1, sustain: 0.3, release: 0.15 },
        { type: "sine", freq: [1000, 1400], gain: 0.06, attack: 0.02, decay: 0.08, sustain: 0.2, release: 0.12, delay: 0.05 },
      ],
    },
  },
  disconnect: {
    type: "synth",
    synth: {
      duration: 0.3,
      layers: [
        { type: "triangle", freq: [700, 300], gain: 0.12, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.15 },
        { type: "sine", freq: [1400, 400], gain: 0.06, attack: 0.02, decay: 0.08, sustain: 0.1, release: 0.12, delay: 0.05 },
      ],
    },
  },
  history_toggle: {
    type: "synth",
    synth: {
      duration: 0.15,
      layers: [
        { type: "triangle", freq: [400, 600], gain: 0.1, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.08 },
      ],
    },
  },
  fidget_spin: {
    type: "synth",
    synth: {
      duration: 0.5,
      layers: [
        { type: "sawtooth", freq: [200, 600], gain: 0.1, attack: 0.05, decay: 0.2, sustain: 0.3, release: 0.2, filterFreq: 800 },
        { type: "triangle", freq: [400, 800], gain: 0.06, attack: 0.05, decay: 0.15, sustain: 0.2, release: 0.15, delay: 0.05 },
      ],
    },
  },
  secret_word: {
    type: "synth",
    synth: {
      duration: 0.5,
      reverb: { decay: 1.0, wet: 0.25 },
      layers: [
        { type: "triangle", freq: [600, 900], gain: 0.12, attack: 0.02, decay: 0.1, sustain: 0.3, release: 0.3 },
        { type: "sine", freq: [1200, 1800], gain: 0.08, attack: 0.02, decay: 0.08, sustain: 0.2, release: 0.25, delay: 0.05 },
        { type: "triangle", freq: [900, 1200], gain: 0.06, attack: 0.02, decay: 0.08, sustain: 0.2, release: 0.25, delay: 0.1 },
      ],
    },
  },
  secret_lab: {
    type: "synth",
    synth: {
      duration: 0.6,
      reverb: { decay: 1.2, wet: 0.3 },
      layers: [
        { type: "sawtooth", freq: [150, 250], gain: 0.15, attack: 0.03, decay: 0.15, sustain: 0.3, release: 0.3, filterFreq: 500 },
        { type: "triangle", freq: [500, 700], gain: 0.1, attack: 0.03, decay: 0.12, sustain: 0.3, release: 0.25, delay: 0.05 },
        { type: "sine", freq: [1000, 1500], gain: 0.06, attack: 0.03, decay: 0.1, sustain: 0.2, release: 0.2, delay: 0.1 },
      ],
    },
  },

  // ── Tier 3: Subtle UI ──
  panel_collapse: {
    type: "synth",
    synth: {
      duration: 0.1,
      layers: [
        { type: "triangle", freq: 400, gain: 0.06, attack: 0.005, decay: 0.02, sustain: 0, release: 0.05 },
      ],
    },
  },
  panel_expand: {
    type: "synth",
    synth: {
      duration: 0.1,
      layers: [
        { type: "triangle", freq: 550, gain: 0.06, attack: 0.005, decay: 0.02, sustain: 0, release: 0.05 },
      ],
    },
  },
  slider_commit: {
    type: "synth",
    synth: {
      duration: 0.08,
      layers: [
        { type: "square", freq: 800, gain: 0.04, attack: 0.002, decay: 0.01, sustain: 0, release: 0.04 },
      ],
    },
  },
  select_change: {
    type: "synth",
    synth: {
      duration: 0.1,
      layers: [
        { type: "triangle", freq: [500, 700], gain: 0.06, attack: 0.005, decay: 0.02, sustain: 0, release: 0.05 },
      ],
    },
  },
  force_burst: {
    type: "synth",
    synth: { duration: 0.1, layers: [] },
  },
  mention_alert: {
    type: "synth",
    synth: {
      duration: 0.8,
      reverb: { decay: 1.0, wet: 0.3 },
      layers: [
        { type: "triangle", freq: [880, 1320], gain: 0.18, attack: 0.01, decay: 0.12, sustain: 0.3, release: 0.4 },
        { type: "sine", freq: [1760, 2640], gain: 0.12, attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.35, delay: 0.06 },
        { type: "triangle", freq: [660, 990], gain: 0.1, attack: 0.01, decay: 0.1, sustain: 0.25, release: 0.3, delay: 0.03 },
        { type: "sine", freq: [1320, 1980], gain: 0.08, attack: 0.01, decay: 0.08, sustain: 0.2, release: 0.3, delay: 0.12 },
      ],
    },
  },
};

const COSMOTECH_SOUNDS: Record<SfxEvent, SoundDefinition> = {
  // ── Tier 1: Major Actions ──
  forge_start: {
    type: "synth",
    synth: {
      duration: 0.9,
      layers: [
        { type: "sine", freq: [100, 400], gain: 0.25, attack: 0.05, decay: 0.3, sustain: 0.3, release: 0.4, filterFreq: 2000 },
        { type: "square", freq: [200, 800], gain: 0.1, attack: 0.05, decay: 0.25, sustain: 0.2, release: 0.35, delay: 0.05, filterFreq: 3000 },
        { type: "sine", freq: [50, 150], gain: 0.2, attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.5 },
      ],
    },
  },
  forge_complete: {
    type: "synth",
    synth: {
      duration: 0.7,
      reverb: { decay: 1.5, wet: 0.3 },
      layers: [
        { type: "sine", freq: 880, gain: 0.2, attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.4 },
        { type: "sine", freq: 1320, gain: 0.15, attack: 0.01, decay: 0.15, sustain: 0.3, release: 0.4, delay: 0.06 },
        { type: "sine", freq: 1760, gain: 0.12, attack: 0.01, decay: 0.15, sustain: 0.25, release: 0.35, delay: 0.12 },
        { type: "sine", freq: 2640, gain: 0.08, attack: 0.01, decay: 0.1, sustain: 0.15, release: 0.3, delay: 0.18 },
      ],
    },
  },
  send_message: {
    type: "synth",
    synth: {
      duration: 0.25,
      layers: [
        { type: "sine", freq: [600, 1200], gain: 0.15, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.12 },
        { type: "sine", freq: [1200, 1800], gain: 0.1, attack: 0.005, decay: 0.03, sustain: 0, release: 0.08, delay: 0.03 },
      ],
    },
  },
  autoforge_action: {
    type: "synth",
    synth: {
      duration: 0.4,
      reverb: { decay: 0.6, wet: 0.2 },
      layers: [
        { type: "sine", freq: [300, 200], gain: 0.15, attack: 0.02, decay: 0.1, sustain: 0.3, release: 0.2 },
        { type: "sine", freq: [600, 400], gain: 0.1, attack: 0.02, decay: 0.08, sustain: 0.2, release: 0.18, delay: 0.04 },
        { type: "square", freq: 150, gain: 0.08, attack: 0.01, decay: 0.05, sustain: 0.2, release: 0.15 },
      ],
    },
  },
  refine_complete: {
    type: "synth",
    synth: {
      duration: 0.5,
      reverb: { decay: 1.0, wet: 0.25 },
      layers: [
        { type: "sine", freq: [1000, 1500], gain: 0.12, attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.3 },
        { type: "sine", freq: [1500, 2000], gain: 0.08, attack: 0.01, decay: 0.08, sustain: 0.2, release: 0.25, delay: 0.04 },
        { type: "sine", freq: [2000, 3000], gain: 0.05, attack: 0.01, decay: 0.06, sustain: 0.15, release: 0.2, delay: 0.08 },
      ],
    },
  },
  error: {
    type: "synth",
    synth: {
      duration: 0.5,
      layers: [
        { type: "square", freq: [220, 110], gain: 0.2, attack: 0.005, decay: 0.1, sustain: 0.2, release: 0.3, filterFreq: 800 },
        { type: "sawtooth", freq: [440, 220], gain: 0.12, attack: 0.005, decay: 0.08, sustain: 0.15, release: 0.25, delay: 0.03, filterFreq: 1200 },
        { type: "square", freq: [880, 440], gain: 0.06, attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.15, delay: 0.06, filterFreq: 2000 },
      ],
    },
  },
  konami: {
    type: "synth",
    synth: {
      duration: 1.4,
      reverb: { decay: 1.5, wet: 0.25 },
      layers: [
        { type: "sine", freq: 880, gain: 0.15, attack: 0.02, decay: 0.12, sustain: 0.3, release: 0.2 },
        { type: "sine", freq: 1100, gain: 0.15, attack: 0.02, decay: 0.12, sustain: 0.3, release: 0.2, delay: 0.18 },
        { type: "sine", freq: 1320, gain: 0.15, attack: 0.02, decay: 0.12, sustain: 0.3, release: 0.2, delay: 0.36 },
        { type: "sine", freq: 1760, gain: 0.2, attack: 0.02, decay: 0.15, sustain: 0.4, release: 0.4, delay: 0.54 },
        { type: "sine", freq: 1320, gain: 0.12, attack: 0.02, decay: 0.12, sustain: 0.3, release: 0.25, delay: 0.84 },
        { type: "sine", freq: 1760, gain: 0.18, attack: 0.02, decay: 0.15, sustain: 0.4, release: 0.5, delay: 1.08 },
      ],
    },
  },
  max_rage: {
    type: "synth",
    synth: {
      duration: 1.1,
      layers: [
        { type: "square", freq: [200, 600], gain: 0.2, attack: 0.02, decay: 0.2, sustain: 0.4, release: 0.6, filterFreq: 1500 },
        { type: "sawtooth", freq: [400, 1200], gain: 0.15, attack: 0.02, decay: 0.15, sustain: 0.3, release: 0.5, delay: 0.1, filterFreq: 2500 },
        { type: "square", freq: [100, 300], gain: 0.2, attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.7 },
        { type: "sawtooth", freq: [3000, 6000], gain: 0.06, attack: 0.01, decay: 0.05, sustain: 0.2, release: 0.3, delay: 0.2, filterFreq: 5000 },
      ],
    },
  },
  welcome_dismiss: {
    type: "synth",
    synth: {
      duration: 0.9,
      reverb: { decay: 2.0, wet: 0.35 },
      layers: [
        { type: "sine", freq: [400, 600], gain: 0.18, attack: 0.08, decay: 0.25, sustain: 0.4, release: 0.5 },
        { type: "sine", freq: [600, 900], gain: 0.12, attack: 0.08, decay: 0.2, sustain: 0.3, release: 0.45, delay: 0.08 },
        { type: "sine", freq: [900, 1200], gain: 0.08, attack: 0.08, decay: 0.2, sustain: 0.3, release: 0.4, delay: 0.16 },
        { type: "sine", freq: [1200, 1800], gain: 0.05, attack: 0.08, decay: 0.15, sustain: 0.2, release: 0.35, delay: 0.24 },
      ],
    },
  },

  // ── Tier 2: UI Interactions ──
  palette_open: {
    type: "synth",
    synth: {
      duration: 0.3,
      reverb: { decay: 0.4, wet: 0.15 },
      layers: [
        { type: "sine", freq: [600, 1200], gain: 0.12, attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.15 },
        { type: "sine", freq: [1200, 2400], gain: 0.06, attack: 0.01, decay: 0.06, sustain: 0, release: 0.1, delay: 0.02 },
      ],
    },
  },
  palette_close: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "sine", freq: [1200, 600], gain: 0.1, attack: 0.01, decay: 0.06, sustain: 0.1, release: 0.1 },
      ],
    },
  },
  palette_select: {
    type: "synth",
    synth: {
      duration: 0.12,
      layers: [
        { type: "sine", freq: 1200, gain: 0.08, attack: 0.005, decay: 0.03, sustain: 0, release: 0.06 },
        { type: "sine", freq: 1800, gain: 0.05, attack: 0.005, decay: 0.02, sustain: 0, release: 0.05, delay: 0.02 },
      ],
    },
  },
  autoforge_on: {
    type: "synth",
    synth: {
      duration: 0.6,
      reverb: { decay: 0.8, wet: 0.2 },
      layers: [
        { type: "sine", freq: [300, 900], gain: 0.15, attack: 0.03, decay: 0.2, sustain: 0.3, release: 0.3 },
        { type: "sine", freq: [600, 1200], gain: 0.1, attack: 0.03, decay: 0.15, sustain: 0.3, release: 0.25, delay: 0.05 },
        { type: "square", freq: 150, gain: 0.06, attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.2 },
      ],
    },
  },
  autoforge_off: {
    type: "synth",
    synth: {
      duration: 0.5,
      layers: [
        { type: "sine", freq: [900, 300], gain: 0.15, attack: 0.03, decay: 0.15, sustain: 0.3, release: 0.25 },
        { type: "sine", freq: [1200, 400], gain: 0.08, attack: 0.03, decay: 0.12, sustain: 0.2, release: 0.2, delay: 0.04 },
      ],
    },
  },
  hud_open: {
    type: "synth",
    synth: {
      duration: 0.3,
      reverb: { decay: 0.4, wet: 0.15 },
      layers: [
        { type: "sine", freq: [500, 800], gain: 0.1, attack: 0.01, decay: 0.08, sustain: 0.2, release: 0.15 },
        { type: "sine", freq: [1000, 1400], gain: 0.05, attack: 0.01, decay: 0.06, sustain: 0.1, release: 0.12, delay: 0.03 },
      ],
    },
  },
  hud_close: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "sine", freq: [800, 500], gain: 0.08, attack: 0.01, decay: 0.06, sustain: 0.1, release: 0.1 },
        { type: "sine", freq: [1400, 800], gain: 0.04, attack: 0.01, decay: 0.04, sustain: 0, release: 0.08, delay: 0.02 },
      ],
    },
  },
  report_open: {
    type: "synth",
    synth: {
      duration: 0.35,
      reverb: { decay: 0.5, wet: 0.15 },
      layers: [
        { type: "sine", freq: [400, 700], gain: 0.1, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.15 },
        { type: "sine", freq: [800, 1200], gain: 0.06, attack: 0.02, decay: 0.08, sustain: 0.15, release: 0.12, delay: 0.04 },
      ],
    },
  },
  report_close: {
    type: "synth",
    synth: {
      duration: 0.25,
      layers: [
        { type: "sine", freq: [700, 400], gain: 0.08, attack: 0.01, decay: 0.06, sustain: 0.15, release: 0.12 },
      ],
    },
  },
  theme_toggle: {
    type: "synth",
    synth: {
      duration: 0.6,
      reverb: { decay: 1.2, wet: 0.3 },
      layers: [
        { type: "sine", freq: [600, 1000], gain: 0.12, attack: 0.03, decay: 0.2, sustain: 0.3, release: 0.3 },
        { type: "sine", freq: [1000, 1600], gain: 0.08, attack: 0.03, decay: 0.15, sustain: 0.25, release: 0.25, delay: 0.05 },
        { type: "sine", freq: [1600, 2400], gain: 0.05, attack: 0.03, decay: 0.12, sustain: 0.2, release: 0.2, delay: 0.1 },
        { type: "sawtooth", freq: [200, 600], gain: 0.04, attack: 0.03, decay: 0.15, sustain: 0.1, release: 0.2, filterFreq: 800 },
      ],
    },
  },
  variant_close: {
    type: "synth",
    synth: {
      duration: 0.15,
      layers: [
        { type: "sine", freq: [1000, 400], gain: 0.08, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.08 },
        { type: "sine", freq: [2000, 800], gain: 0.04, attack: 0.005, decay: 0.03, sustain: 0, release: 0.06 },
      ],
    },
  },
  copy: {
    type: "synth",
    synth: {
      duration: 0.12,
      layers: [
        { type: "sine", freq: [1800, 2400], gain: 0.06, attack: 0.005, decay: 0.03, sustain: 0, release: 0.06 },
        { type: "sine", freq: 1200, gain: 0.04, attack: 0.005, decay: 0.02, sustain: 0, release: 0.05, delay: 0.02 },
      ],
    },
  },
  settings_save: {
    type: "synth",
    synth: {
      duration: 0.2,
      layers: [
        { type: "sine", freq: 800, gain: 0.08, attack: 0.005, decay: 0.03, sustain: 0.2, release: 0.1 },
        { type: "sine", freq: 1200, gain: 0.06, attack: 0.005, decay: 0.03, sustain: 0.2, release: 0.1, delay: 0.04 },
      ],
    },
  },
  memory_add: {
    type: "synth",
    synth: {
      duration: 0.2,
      reverb: { decay: 0.3, wet: 0.15 },
      layers: [
        { type: "sine", freq: [600, 900], gain: 0.1, attack: 0.01, decay: 0.06, sustain: 0.2, release: 0.1 },
        { type: "sine", freq: [900, 1200], gain: 0.05, attack: 0.01, decay: 0.04, sustain: 0.1, release: 0.08, delay: 0.02 },
      ],
    },
  },
  memory_remove: {
    type: "synth",
    synth: {
      duration: 0.15,
      layers: [
        { type: "sine", freq: [900, 500], gain: 0.08, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.08 },
      ],
    },
  },
  clear_context: {
    type: "synth",
    synth: {
      duration: 0.45,
      reverb: { decay: 0.6, wet: 0.15 },
      layers: [
        { type: "sine", freq: [3000, 300], gain: 0.1, attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.2 },
        { type: "sine", freq: [1500, 150], gain: 0.06, attack: 0.01, decay: 0.15, sustain: 0.1, release: 0.18, delay: 0.05 },
      ],
    },
  },
  connect: {
    type: "synth",
    synth: {
      duration: 0.3,
      reverb: { decay: 0.4, wet: 0.15 },
      layers: [
        { type: "sine", freq: [700, 1000], gain: 0.1, attack: 0.02, decay: 0.1, sustain: 0.3, release: 0.15 },
        { type: "sine", freq: [1400, 2000], gain: 0.05, attack: 0.02, decay: 0.08, sustain: 0.2, release: 0.12, delay: 0.04 },
      ],
    },
  },
  disconnect: {
    type: "synth",
    synth: {
      duration: 0.3,
      layers: [
        { type: "sine", freq: [1000, 400], gain: 0.1, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.15 },
        { type: "sine", freq: [2000, 600], gain: 0.05, attack: 0.02, decay: 0.08, sustain: 0.1, release: 0.12, delay: 0.04 },
      ],
    },
  },
  history_toggle: {
    type: "synth",
    synth: {
      duration: 0.12,
      layers: [
        { type: "sine", freq: [600, 900], gain: 0.08, attack: 0.005, decay: 0.04, sustain: 0.1, release: 0.06 },
      ],
    },
  },
  fidget_spin: {
    type: "synth",
    synth: {
      duration: 0.5,
      reverb: { decay: 0.5, wet: 0.15 },
      layers: [
        { type: "sine", freq: [300, 900], gain: 0.08, attack: 0.05, decay: 0.2, sustain: 0.3, release: 0.2 },
        { type: "sine", freq: [600, 1200], gain: 0.05, attack: 0.05, decay: 0.15, sustain: 0.2, release: 0.15, delay: 0.05 },
      ],
    },
  },
  secret_word: {
    type: "synth",
    synth: {
      duration: 0.6,
      reverb: { decay: 1.5, wet: 0.3 },
      layers: [
        { type: "sine", freq: [800, 1200], gain: 0.1, attack: 0.03, decay: 0.12, sustain: 0.3, release: 0.35 },
        { type: "sine", freq: [1200, 1800], gain: 0.06, attack: 0.03, decay: 0.1, sustain: 0.2, release: 0.3, delay: 0.05 },
        { type: "sine", freq: [1800, 2400], gain: 0.04, attack: 0.03, decay: 0.08, sustain: 0.15, release: 0.25, delay: 0.1 },
      ],
    },
  },
  secret_lab: {
    type: "synth",
    synth: {
      duration: 0.7,
      reverb: { decay: 1.8, wet: 0.35 },
      layers: [
        { type: "sine", freq: [200, 400], gain: 0.12, attack: 0.05, decay: 0.2, sustain: 0.3, release: 0.35 },
        { type: "sine", freq: [600, 900], gain: 0.08, attack: 0.05, decay: 0.15, sustain: 0.3, release: 0.3, delay: 0.05 },
        { type: "sine", freq: [1000, 1500], gain: 0.05, attack: 0.05, decay: 0.12, sustain: 0.2, release: 0.25, delay: 0.1 },
        { type: "sawtooth", freq: [100, 200], gain: 0.04, attack: 0.05, decay: 0.15, sustain: 0.1, release: 0.25, filterFreq: 500 },
      ],
    },
  },

  // ── Tier 3: Subtle UI ──
  panel_collapse: {
    type: "synth",
    synth: {
      duration: 0.1,
      layers: [
        { type: "sine", freq: 600, gain: 0.04, attack: 0.005, decay: 0.02, sustain: 0, release: 0.04 },
      ],
    },
  },
  panel_expand: {
    type: "synth",
    synth: {
      duration: 0.1,
      layers: [
        { type: "sine", freq: 800, gain: 0.04, attack: 0.005, decay: 0.02, sustain: 0, release: 0.04 },
      ],
    },
  },
  slider_commit: {
    type: "synth",
    synth: {
      duration: 0.06,
      layers: [
        { type: "sine", freq: 1200, gain: 0.03, attack: 0.002, decay: 0.01, sustain: 0, release: 0.03 },
      ],
    },
  },
  select_change: {
    type: "synth",
    synth: {
      duration: 0.08,
      layers: [
        { type: "sine", freq: [800, 1100], gain: 0.04, attack: 0.005, decay: 0.02, sustain: 0, release: 0.04 },
      ],
    },
  },
  force_burst: {
    type: "synth",
    synth: { duration: 0.1, layers: [] },
  },
  mention_alert: {
    type: "synth",
    synth: {
      duration: 0.9,
      reverb: { decay: 1.2, wet: 0.35 },
      layers: [
        { type: "sine", freq: [1000, 1500], gain: 0.15, attack: 0.02, decay: 0.15, sustain: 0.3, release: 0.4 },
        { type: "sine", freq: [1500, 2250], gain: 0.1, attack: 0.02, decay: 0.12, sustain: 0.25, release: 0.35, delay: 0.05 },
        { type: "sine", freq: [2000, 3000], gain: 0.06, attack: 0.02, decay: 0.1, sustain: 0.2, release: 0.3, delay: 0.1 },
        { type: "sine", freq: [750, 1125], gain: 0.08, attack: 0.02, decay: 0.12, sustain: 0.25, release: 0.35, delay: 0.03 },
      ],
    },
  },
};

// ─── Force Burst Escalation ───────────────────────────────────────────────────
// Tracks recent force clicks to escalate the sound intensity
const forceClickTimes: number[] = [];
const FORCE_ESCALATION_WINDOW_MS = 30_000; // 30 seconds

function getForceEscalationLevel(): number {
  const now = Date.now();
  // Prune old entries
  while (forceClickTimes.length > 0 && forceClickTimes[0] < now - FORCE_ESCALATION_WINDOW_MS) {
    forceClickTimes.shift();
  }
  return forceClickTimes.length; // 0 = first use, 1+ = repeated
}

function buildForceBurstSynth(level: number): SynthConfig {
  // Base sound: a punchy impact with rising energy
  const layers: SynthLayer[] = [
    { type: "sawtooth", freq: [80, 200], gain: 0.3, attack: 0.005, decay: 0.1, sustain: 0.2, release: 0.3, filterFreq: 800 },
    { type: "square", freq: [200, 400], gain: 0.15, attack: 0.005, decay: 0.08, sustain: 0.15, release: 0.25, delay: 0.02, filterFreq: 1200 },
    { type: "triangle", freq: 60, gain: 0.25, attack: 0.003, decay: 0.06, sustain: 0.3, release: 0.4 },
  ];

  // Escalation: add more aggressive layers and increase gain
  if (level >= 1) {
    // Level 1: add a sub-bass rumble
    layers.push({ type: "sawtooth", freq: [40, 80], gain: 0.2, attack: 0.005, decay: 0.15, sustain: 0.4, release: 0.5, filterFreq: 300 });
  }
  if (level >= 2) {
    // Level 2: add distorted high-frequency sweep
    layers.push({ type: "sawtooth", freq: [2000, 5000], gain: 0.08, attack: 0.005, decay: 0.05, sustain: 0.2, release: 0.3, delay: 0.03, filterFreq: 4000 });
    layers[0].gain = 0.38;
  }
  if (level >= 3) {
    // Level 3: add aggressive noise-like sweep and boost everything
    layers.push({ type: "square", freq: [100, 50], gain: 0.2, attack: 0.003, decay: 0.1, sustain: 0.5, release: 0.6 });
    layers.push({ type: "sawtooth", freq: [3000, 8000], gain: 0.06, attack: 0.003, decay: 0.04, sustain: 0.3, release: 0.4, delay: 0.05, filterFreq: 6000 });
    layers[0].gain = 0.45;
    layers[2].gain = 0.35;
  }
  if (level >= 5) {
    // Level 5+: maximum chaos — add detuned layers for dissonance
    layers.push({ type: "sawtooth", freq: [120, 60], gain: 0.3, attack: 0.002, decay: 0.08, sustain: 0.5, release: 0.7, detune: 50, filterFreq: 500 });
    layers.push({ type: "square", freq: [4000, 9000], gain: 0.05, attack: 0.002, decay: 0.03, sustain: 0.3, release: 0.5, delay: 0.04, filterFreq: 8000 });
  }

  // Cap escalation so reverb/gain don't grow unbounded (layers only go up to level 5)
  const escLevel = Math.min(level, 5);
  return {
    duration: 0.4 + escLevel * 0.1,
    reverb: { decay: 0.6 + escLevel * 0.2, wet: Math.min(0.15 + escLevel * 0.05, 1) },
    layers,
  };
}

const SOUND_MAPS: Record<Theme, Record<SfxEvent, SoundDefinition>> = {
  default: DEFAULT_SOUNDS,
  cosmotech: COSMOTECH_SOUNDS,
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function playSfx(event: SfxEvent, options?: { volume?: number }): void {
  if (typeof window === "undefined") return;

  const state = useAppStore.getState();
  const cue = cueForSfx(event);
  if (!mobileAudioCueAllowed(cue, state.sfxEnabled)) return;
  if (shouldSuppressLowerPriorityCue(cue, activePriorityCue)) return;

  const theme: Theme = state.theme === "cosmotech" ? "cosmotech" : state.theme === "corrupture" ? "cosmotech" : "default";
  const soundMap = SOUND_MAPS[theme];
  const def = soundMap[event];
  if (!def) return;

  const volume = (options?.volume ?? 1) * (state.sfxVolume ?? 0.3);

  if (def.type === "synth") {
    playSynth(def.synth, volume);
    reserveAudioPriority(cue, Math.max(80, def.synth.duration * 1000));
  }
}

/** Web Audio fallback for the always-on direct-mention media alert. */
export function playAttentionFallbackSfx(): void {
  if (typeof window === "undefined") return;
  const state = useAppStore.getState();
  const theme: Theme = state.theme === "cosmotech" || state.theme === "corrupture" ? "cosmotech" : "default";
  const definition = SOUND_MAPS[theme].mention_alert;
  reserveAudioPriority("attention_mention", definition.synth.duration * 1000);
  playSynth(definition.synth, 0.72);
}

export function playForceBurstSfx(): void {
  if (typeof window === "undefined") return;

  const state = useAppStore.getState();
  if (!state.sfxEnabled) return;

  // Read escalation level BEFORE pushing so the first click returns 0 (not 1)
  const level = getForceEscalationLevel();
  forceClickTimes.push(Date.now());
  const synth = buildForceBurstSynth(level);
  const volume = (state.sfxVolume ?? 0.3) * (1 + level * 0.08);

  playSynth(synth, Math.min(volume, 1.5));
}

export function initSfxAudioContext(): void {
  getCtx();
}

// ─── AutoForge countdown ticks (mobile) ─────────────────────────────────────
// One cohesive gesture, not three unrelated effects: the same soft filtered
// "tik" at a slightly rising pitch/gain per step. Deliberately outside the
// SfxEvent map — per-attempt dedup lives in autoCheckCountdown.ts and these
// are never user-triggered UI feedback. Gains stay whisper-quiet.

const AUTOCHECK_TICKS: Record<1 | 2 | 3, SynthConfig> = {
  3: {
    duration: 0.09,
    layers: [
      { type: "sine", freq: [2050, 1750], gain: 0.045, attack: 0.002, decay: 0.02, sustain: 0, release: 0.05, filterFreq: 3200 },
      { type: "triangle", freq: 1025, gain: 0.03, attack: 0.002, decay: 0.02, sustain: 0, release: 0.04 },
    ],
  },
  2: {
    duration: 0.09,
    layers: [
      { type: "sine", freq: [2300, 1950], gain: 0.05, attack: 0.002, decay: 0.02, sustain: 0, release: 0.05, filterFreq: 3400 },
      { type: "triangle", freq: 1150, gain: 0.035, attack: 0.002, decay: 0.02, sustain: 0, release: 0.04 },
    ],
  },
  1: {
    duration: 0.11,
    layers: [
      { type: "sine", freq: [2600, 2200], gain: 0.06, attack: 0.002, decay: 0.025, sustain: 0, release: 0.06, filterFreq: 3800 },
      { type: "triangle", freq: 1300, gain: 0.045, attack: 0.002, decay: 0.02, sustain: 0, release: 0.05 },
      // faint woody transient — the 1 tick reads slightly more tactile without
      // becoming a crescendo
      { type: "square", freq: [5200, 4100], gain: 0.012, attack: 0.001, decay: 0.008, sustain: 0, release: 0.03, delay: 0.004, filterFreq: 6000 },
    ],
  },
};

/** Soft 3→2→1 countdown tick for the mobile AutoForge HUD. Respects sfxEnabled/sfxVolume. */
export function playAutoCheckTick(step: 1 | 2 | 3): void {
  if (typeof window === "undefined") return;
  const state = useAppStore.getState();
  if (!state.sfxEnabled) return;
  const def = AUTOCHECK_TICKS[step];
  if (!def) return;
  playSynth(def, state.sfxVolume ?? 0.3);
}
