const CONFETTI_COLORS = [
  "#f472b6", "#fbbf24", "#34d399", "#60a5fa",
  "#a78bfa", "#fb923c", "#f87171", "#2dd4bf",
  "#facc15", "#e879f9",
];

const CONFETTI_LIFETIME_MS = 3000;

type ConfettiPiece = {
  el: HTMLDivElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  vr: number;
  born: number;
};

let activeConfetti: ConfettiPiece[] = [];
let rafId: number | null = null;

function tick() {
  const now = performance.now();
  activeConfetti = activeConfetti.filter((p) => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.35;
    p.vx *= 0.99;
    p.rotation += p.vr;

    const age = (now - p.born) / CONFETTI_LIFETIME_MS;
    const opacity = age > 0.7 ? Math.max(0, 1 - (age - 0.7) / 0.3) : 1;

    p.el.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.rotation}deg)`;
    p.el.style.opacity = String(opacity);

    if (now - p.born >= CONFETTI_LIFETIME_MS || p.y > window.innerHeight + 50) {
      p.el.remove();
      return false;
    }
    return true;
  });

  if (activeConfetti.length > 0) {
    rafId = requestAnimationFrame(tick);
  } else {
    rafId = null;
    const container = document.getElementById("confetti-container");
    if (container) container.remove();
  }
}

export function fireConfetti(corners: "bottom" | "all" = "all", count = 120) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  let container = document.getElementById("confetti-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "confetti-container";
    container.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:99999;overflow:hidden";
    document.body.appendChild(container);
  }

  const cornerPoints: { x: number; y: number; angle: number }[] = [];
  if (corners === "all") {
    cornerPoints.push({ x: 0, y: h, angle: -45 });
    cornerPoints.push({ x: w, y: h, angle: -135 });
    cornerPoints.push({ x: 0, y: 0, angle: 45 });
    cornerPoints.push({ x: w, y: 0, angle: 135 });
  } else {
    cornerPoints.push({ x: 0, y: h, angle: -45 });
    cornerPoints.push({ x: w, y: h, angle: -135 });
  }

  const perCorner = Math.ceil(count / cornerPoints.length);
  for (const cp of cornerPoints) {
    for (let i = 0; i < perCorner; i++) {
      const spread = 60;
      const a = ((cp.angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
      const speed = 8 + Math.random() * 12;
      const size = 6 + Math.random() * 8;
      const isCircle = Math.random() > 0.5;
      const color =
        CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];

      const el = document.createElement("div");
      el.style.cssText = `position:absolute;width:${size}px;height:${
        isCircle ? size : size * 0.6
      }px;background:${color};border-radius:${
        isCircle ? "50%" : "2px"
      };will-change:transform,opacity;left:0;top:0;`;
      container.appendChild(el);

      activeConfetti.push({
        el,
        x: cp.x,
        y: cp.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        rotation: Math.random() * 360,
        vr: (Math.random() - 0.5) * 20,
        born: performance.now(),
      });
    }
  }

  if (rafId === null) {
    rafId = requestAnimationFrame(tick);
  }
}
