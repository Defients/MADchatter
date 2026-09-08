let pipelinePromise: Promise<any> | null = null;
let pipelineError: string | null = null;

async function getPipeline() {
  if (pipelineError) {
    console.warn('[Whisper] Clearing previous error and retrying:', pipelineError);
    pipelineError = null;
  }
  if (!pipelinePromise) {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      pipelinePromise = pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
        dtype: {
          encoder_model: 'fp32',
          decoder_model_merged: 'q4',
        },
        device: 'webgpu',
        progress_callback: (info: any) => {
          if (info.status === 'progress') {
            console.log(`Whisper model download: ${info.file} — ${Math.round((info.loaded / info.total) * 100)}%`);
          }
        },
      });
      await pipelinePromise;
    } catch (e: any) {
      console.error('[Whisper] Failed to load with WebGPU, falling back to WASM:', e?.message);
      pipelinePromise = null;
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.allowLocalModels = false;
        pipelinePromise = pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
          dtype: {
            encoder_model: 'fp32',
            decoder_model_merged: 'q4',
          },
          progress_callback: (info: any) => {
            if (info.status === 'progress') {
              console.log(`Whisper model download (WASM): ${info.file} — ${Math.round((info.loaded / info.total) * 100)}%`);
            }
          },
        });
        await pipelinePromise;
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

async function decodeBlobToFloat32(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  if (arrayBuffer.byteLength < 100) {
    return new Float32Array(0);
  }
  let audioCtx: AudioContext;
  try {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  } catch {
    audioCtx = new AudioContext();
  }
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
  } finally {
    audioCtx.close();
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
];

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
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

  try {
    const output = await pipe(audioData, {
      chunk_length_s: 15,
      stride_length_s: 1,
      return_timestamps: false,
    });

    const text = (output?.text ?? '').trim();
    if (!text) return '';

    if (HALLUCINATION_PATTERNS.some(pattern => pattern.test(text))) {
      return '';
    }

    return text;
  } catch (e: any) {
    console.error('[Whisper] Transcription failed:', e?.message || e);
    return '';
  }
}
