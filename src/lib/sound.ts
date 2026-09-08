const DEFAULT_SOUND_URL = "https://madchatter.fun/defbot.mp3";
let soundUrl = DEFAULT_SOUND_URL;
let audioEl: HTMLAudioElement | null = null;
let currentSinkId: string | null = null;

export function setSoundUrl(url: string | null): void {
  const newUrl = url && url.trim() ? url.trim() : DEFAULT_SOUND_URL;
  if (newUrl === soundUrl && audioEl) return;
  soundUrl = newUrl;
  audioEl = null;
}

export async function enumerateAudioOutputs(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput");
  } catch {
    return [];
  }
}

export async function setAudioOutputSink(deviceId: string): Promise<boolean> {
  currentSinkId = deviceId;
  if (audioEl && typeof (audioEl as any).setSinkId === "function") {
    try {
      await (audioEl as any).setSinkId(deviceId);
      return true;
    } catch (e) {
      console.error("[Sound] Failed to set audio output sink:", e);
      return false;
    }
  }
  return false;
}

let currentVolume = 1;

export function setSoundVolume(vol: number): void {
  currentVolume = Math.max(0, Math.min(1, vol));
  if (audioEl) {
    audioEl.volume = currentVolume;
  }
}

export function playMessageSound(): void {
  if (typeof window === "undefined") return;
  if (!audioEl) {
    audioEl = new Audio(soundUrl);
    audioEl.preload = "auto";
    audioEl.volume = currentVolume;
    if (currentSinkId && typeof (audioEl as any).setSinkId === "function") {
      (audioEl as any).setSinkId(currentSinkId).catch((e: any) => {
        console.error("[Sound] setSinkId failed on init:", e);
      });
    }
  }
  audioEl.currentTime = 0;
  const p = audioEl.play();
  if (p && typeof p.catch === "function") {
    p.catch((e: any) => {
      console.error("[Sound] play() failed:", e?.name, e?.message);
    });
  }
}
