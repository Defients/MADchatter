let pipelinePromise: Promise<any> | null = null;
let pipelineError: string | null = null;
let pipelineModel: string | null = null;

// Progress reporting — module-level callback so the UI can subscribe to
// download progress without threading a callback through every call site.
type ProgressInfo = { file: string; progress: number };
let progressCallback: ((info: ProgressInfo) => void) | null = null;

export function setWhisperProgressCallback(cb: ((info: ProgressInfo) => void) | null) {
  progressCallback = cb;
}

function makeProgressCallback(modelLabel: string) {
  return (info: any) => {
    if (info.status === 'progress' && info.loaded != null && info.total != null && info.total > 0) {
      const pct = Math.round((info.loaded / info.total) * 100);
      console.log(`Whisper (${modelLabel}) download: ${info.file} — ${pct}%`);
      progressCallback?.({ file: info.file || '', progress: pct });
    } else if (info.status === 'done' || info.status === 'ready') {
      progressCallback?.({ file: info.file || '', progress: 100 });
    }
  };
}

const MODEL_WEBGPU = 'onnx-community/whisper-base.en';
const MODEL_WASM = 'onnx-community/whisper-tiny.en';

async function getPipeline() {
  if (pipelineError) {
    console.warn('[Whisper] Clearing previous error and retrying:', pipelineError);
    pipelineError = null;
  }
  if (!pipelinePromise) {
    // Try the larger, more accurate base.en model on WebGPU first. Fall back to
    // the tiny.en model on WASM for devices without WebGPU (base.en is too
    // slow in pure WASM).
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      pipelinePromise = pipeline('automatic-speech-recognition', MODEL_WEBGPU, {
        dtype: {
          encoder_model: 'fp32',
          decoder_model_merged: 'q4',
        },
        device: 'webgpu',
        progress_callback: makeProgressCallback('base.en/WebGPU'),
      });
      await pipelinePromise;
      pipelineModel = MODEL_WEBGPU;
    } catch (e: any) {
      console.error('[Whisper] base.en on WebGPU failed, falling back to tiny.en on WASM:', e?.message);
      pipelinePromise = null;
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.allowLocalModels = false;
        pipelinePromise = pipeline('automatic-speech-recognition', MODEL_WASM, {
          dtype: {
            encoder_model: 'fp32',
            decoder_model_merged: 'q4',
          },
          progress_callback: makeProgressCallback('tiny.en/WASM'),
        });
        await pipelinePromise;
        pipelineModel = MODEL_WASM;
      } catch (e2: any) {
        pipelineError = e2?.message || 'Failed to load Whisper model';
        pipelinePromise = null;
        throw new Error(pipelineError);
      }
    }
  }
  return pipelinePromise;
}

export async function preloadWhisper(): Promise<void> {
  await getPipeline();
}

export async function isWhisperLoaded(): Promise<boolean> {
  return pipelinePromise !== null && !pipelineError;
}

export async function tryLoadWhisper(timeoutMs = 5000): Promise<boolean> {
  if (pipelinePromise) {
    try {
      await pipelinePromise;
      return true;
    } catch {
      return false;
    }
  }
  const loadPromise = getPipeline();
  try {
    await Promise.race([
      loadPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Reuse a single AudioContext across chunks. Creating/closing one per chunk
// is expensive (audio hardware init/teardown) and was the main per-chunk
// overhead in the old pipeline.
let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    try {
      sharedAudioCtx = new AudioContext({ sampleRate: 16000 });
    } catch {
      sharedAudioCtx = new AudioContext();
    }
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

async function decodeBlobToFloat32(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  if (arrayBuffer.byteLength < 100) {
    return new Float32Array(0);
  }
  const audioCtx = getAudioContext();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const channelData = decoded.getChannelData(0);
    if (audioCtx.sampleRate !== 16000) {
      const ratio = 16000 / audioCtx.sampleRate;
      const targetLength = Math.round(channelData.length * ratio);
      const resampled = new Float32Array(targetLength);
      for (let i = 0; i < targetLength; i++) {
        const srcIdx = i / ratio;
        const low = Math.floor(srcIdx);
        const high = Math.min(low + 1, channelData.length - 1);
        const frac = srcIdx - low;
        resampled[i] = channelData[low] * (1 - frac) + channelData[high] * frac;
      }
      return resampled;
    }
    return new Float32Array(channelData);
  } catch (e) {
    console.warn('[Whisper] Skipping undecodable audio chunk:', e);
    return new Float32Array(0);
  }
}

const HALLUCINATION_PATTERNS = [
  /^you\.?$/i,
  /^thank you\.?$/i,
  /^thanks for watching\.?$/i,
  /^thank you for watching\.?$/i,
  /^please subscribe\.?$/i,
  /^bye\.?$/i,
  /^so\.?$/i,
  /^yeah\.?$/i,
  /^uh\.?$/i,
  /^um\.?$/i,
  /^okay\.?$/i,
  /^ok\.?$/i,
  /^sure\.?$/i,
  /^right\.?$/i,
  /^mm\.?$/i,
  /^hmm\.?$/i,
  /^mm-hmm\.?$/i,
  /^uh-huh\.?$/i,
  /^bye\.?$/i,
  /^goodbye\.?$/i,
  /^see you\.?$/i,
  /^see ya\.?$/i,
  /^thanks\.?$/i,
  /^thank you very much\.?$/i,
  /^please\.?$/i,
  /^subscribe\.?$/i,
  /^like and subscribe\.?$/i,
  /^don't forget to subscribe\.?$/i,
  /^hit that subscribe button\.?$/i,
  /^smash that like button\.?$/i,
  /^\[.*music.*\]$/i,
  /^\[.*applause.*\]$/i,
  /^\[.*laughter.*\]$/i,
  /^\[.*silence.*\]$/i,
];

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Detect whether an audio chunk is likely music rather than speech.
 *
 * Heuristic: speech has natural pauses (20-50% of frames are quiet) and
 * high amplitude variance between voiced/unvoiced segments. Music is
 * continuous — sustained amplitude with very few silent gaps and low
 * variance across active frames.
 *
 * Returns true if the chunk looks like music (should be skipped).
 */
function isLikelyMusic(samples: Float32Array, sampleRate = 16000): boolean {
  const frameSize = Math.floor(sampleRate * 0.05); // 50ms frames
  const numFrames = Math.floor(samples.length / frameSize);
  if (numFrames < 8) return false; // too short to judge reliably

  const SILENCE_THRESHOLD = 0.012;
  let silentFrames = 0;
  const activeRms: number[] = [];

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    let sum = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frameSize);
    if (rms < SILENCE_THRESHOLD) {
      silentFrames++;
    } else {
      activeRms.push(rms);
    }
  }

  // Need enough active frames to judge variance
  if (activeRms.length < 4) return false;

  const silentRatio = silentFrames / numFrames;

  // Coefficient of variation (std / mean) of active-frame RMS.
  // Speech: high CV (words are loud, gaps are quiet → wide spread)
  // Music: low CV (consistent amplitude throughout)
  const mean = activeRms.reduce((a, b) => a + b, 0) / activeRms.length;
  if (mean <= 0) return false;
  const variance = activeRms.reduce((a, b) => a + (b - mean) ** 2, 0) / activeRms.length;
  const cv = Math.sqrt(variance) / mean;

  // Music: very few silent gaps (< 6%) AND low amplitude variance (CV < 0.45)
  // Speech: typically 15%+ silent frames OR CV > 0.7
  if (silentRatio < 0.06 && cv < 0.45) {
    return true;
  }
  return false;
}

/**
 * Detect hallucinated lyric fragments in transcription output.
 * Music transcription tends to produce short, repetitive, verse-like
 * fragments rather than coherent sentences.
 */
export function looksLikeLyrics(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;

  // Very short fragments with no sentence structure (no verbs, just nouns/adjectives)
  // are often hallucinated lyrics. Real speech usually has 5+ words.
  if (words.length <= 3 && !/[.!?]$/.test(text)) {
    // Check if it's just repeated syllables or very short words
    const avgWordLen = words.reduce((a, w) => a + w.length, 0) / words.length;
    if (avgWordLen <= 3) return true;
  }

  // Detect repeated phrases (e.g., "oh oh oh", "yeah yeah yeah")
  const lower = text.toLowerCase().replace(/[^\w\s]/g, '');
  const lowerWords = lower.split(/\s+/).filter(Boolean);
  if (lowerWords.length >= 3) {
    const unique = new Set(lowerWords);
    const uniqueRatio = unique.size / lowerWords.length;
    // If more than 60% of words are repeats, it's likely a lyric/hallucination
    if (uniqueRatio < 0.4) return true;
  }

  return false;
}

export async function transcribeChunk(blob: Blob): Promise<string> {
  const pipe = await getPipeline();
  const audioData = await decodeBlobToFloat32(blob);

  if (audioData.length === 0) {
    return '';
  }

  const rms = computeRMS(audioData);
  if (rms < 0.01) {
    return '';
  }

  // Skip chunks that look like music (sustained amplitude, few pauses).
  // This avoids Whisper hallucinating lyrics over instrumental audio and
  // saves the transcription compute entirely.
  if (isLikelyMusic(audioData)) {
    return '';
  }

  try {
    const output = await pipe(audioData, {
      chunk_length_s: 15,
      stride_length_s: 1,
      return_timestamps: false,
      no_speech_threshold: 0.6,
    });

    const text = (output?.text ?? '').trim();
    if (!text) return '';

    if (HALLUCINATION_PATTERNS.some(pattern => pattern.test(text))) {
      return '';
    }

    if (looksLikeLyrics(text)) {
      return '';
    }

    return text;
  } catch (e: any) {
    console.error('[Whisper] Transcription failed:', e?.message || e);
    return '';
  }
}
