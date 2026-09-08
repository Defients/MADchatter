export const DELTA_THRESHOLD = 0.02;

const THUMB_W = 64;
const THUMB_H = 36;

let _thumbCanvas: HTMLCanvasElement | null = null;
function getThumbCanvas(): HTMLCanvasElement {
  if (!_thumbCanvas) {
    _thumbCanvas = document.createElement("canvas");
    _thumbCanvas.width = THUMB_W;
    _thumbCanvas.height = THUMB_H;
  }
  return _thumbCanvas;
}

export function computeFrameDelta(
  sourceCanvas: HTMLCanvasElement,
  prevImageData: ImageData | null
): { delta: number; imageData: ImageData } {
  const thumb = getThumbCanvas();
  const ctx = thumb.getContext("2d");
  if (!ctx) {
    return { delta: 1, imageData: new ImageData(THUMB_W, THUMB_H) };
  }

  ctx.drawImage(sourceCanvas, 0, 0, THUMB_W, THUMB_H);
  const currentData = ctx.getImageData(0, 0, THUMB_W, THUMB_H);

  if (!prevImageData) {
    return { delta: 1, imageData: currentData };
  }

  const cur = currentData.data;
  const prev = prevImageData.data;
  let totalDiff = 0;
  const pixelCount = THUMB_W * THUMB_H;

  for (let i = 0; i < cur.length; i += 4) {
    const dr = Math.abs(cur[i] - prev[i]);
    const dg = Math.abs(cur[i + 1] - prev[i + 1]);
    const db = Math.abs(cur[i + 2] - prev[i + 2]);
    totalDiff += (dr + dg + db) / 3;
  }

  const avgDiff = totalDiff / pixelCount;
  const delta = avgDiff / 255;

  return { delta, imageData: currentData };
}
