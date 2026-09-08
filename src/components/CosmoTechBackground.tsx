import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../store';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StarParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  baseAlpha: number;
  alpha: number;
  color: string;
  twinklePhase: number;
  twinkleSpeed: number;
  depth: number; // 0–1 parallax depth
}

interface OrbitalRing {
  cx: number;
  cy: number;
  radius: number;
  rotation: number;
  rotSpeed: number;
  tilt: number;       // elliptical squash
  alpha: number;
  pulsePhase: number;
  color: string;
  nodes: number;      // dots on the ring
}

interface SignalTrace {
  points: { x: number; y: number }[];
  progress: number;
  speed: number;
  alpha: number;
  color: string;
  life: number;
  maxLife: number;
}

interface NebulaCloud {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  phase: number;
}

interface ScanSweep {
  angle: number;
  speed: number;
  alpha: number;
  length: number;
}

interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  radius: number;
}

// ─── Palette ────────────────────────────────────────────────────────────────

const C = {
  cyan:    '34, 211, 238',
  teal:    '20, 184, 166',
  violet:  '167, 139, 250',
  magenta: '232, 121, 249',
  indigo:  '99, 102, 241',
  gold:    '251, 191, 36',
  white:   '200, 220, 255',
};

const STAR_COLORS = [C.cyan, C.violet, C.indigo, C.white, C.teal, C.magenta];
const RING_COLORS = [C.cyan, C.violet, C.indigo, C.teal];

function rand(min: number, max: number) { return min + Math.random() * (max - min); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Component ──────────────────────────────────────────────────────────────

export function CosmoTechBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let animationFrameId: number;
    let width = 0;
    let height = 0;
    let dpr = 1;

    // ── State ────────────────────────────────────────────────────────────────
    const stars: StarParticle[] = [];
    const rings: OrbitalRing[] = [];
    const traces: SignalTrace[] = [];
    const nebulae: NebulaCloud[] = [];
    let scanSweep: ScanSweep | null = null;
    let burstParticles: BurstParticle[] = [];

    let chatLevel = 0;
    let energyMultiplier = 1;
    let flashAlpha = 0;
    let flashColor = C.cyan;

    let mouseX = -9999;
    let mouseY = -9999;

    let lastTime = performance.now();
    let globalTime = 0;

    // ── Spatial grid for constellation connections ───────────────────────────
    const CELL_SIZE = 140;
    let gridCols = 0;
    let gridRows = 0;
    let grid: number[][] = [];

    function rebuildGrid() {
      gridCols = Math.ceil(width / CELL_SIZE) + 1;
      gridRows = Math.ceil(height / CELL_SIZE) + 1;
      grid = new Array(gridCols * gridRows);
      for (let i = 0; i < grid.length; i++) grid[i] = [];
    }

    function populateGrid() {
      for (let i = 0; i < grid.length; i++) grid[i].length = 0;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const cx = Math.max(0, Math.min(gridCols - 1, Math.floor(s.x / CELL_SIZE)));
        const cy = Math.max(0, Math.min(gridRows - 1, Math.floor(s.y / CELL_SIZE)));
        grid[cy * gridCols + cx].push(i);
      }
    }

    // ── Initialization ───────────────────────────────────────────────────────

    function initStars() {
      stars.length = 0;
      const count = Math.min(120, Math.floor((width * height) / 12000));
      for (let i = 0; i < count; i++) {
        const depth = Math.random();
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.08 * (0.3 + depth),
          vy: (Math.random() - 0.5) * 0.08 * (0.3 + depth),
          radius: 0.4 + depth * 1.8,
          baseAlpha: 0.15 + depth * 0.5,
          alpha: 0,
          color: pick(STAR_COLORS),
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.0008 + Math.random() * 0.002,
          depth,
        });
      }
    }

    function initRings() {
      rings.length = 0;
      const cx = width / 2;
      const cy = height * 0.5;
      const baseR = Math.min(width, height) * 0.35;

      // 3–4 concentric orbital rings
      const ringCount = 4;
      for (let i = 0; i < ringCount; i++) {
        const r = baseR * (0.4 + i * 0.22);
        rings.push({
          cx,
          cy,
          radius: r,
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() > 0.5 ? 1 : -1) * rand(0.0001, 0.0004),
          tilt: rand(0.35, 0.65),
          alpha: 0.04 + i * 0.015,
          pulsePhase: Math.random() * Math.PI * 2,
          color: RING_COLORS[i % RING_COLORS.length],
          nodes: 3 + i * 2,
        });
      }
    }

    function initNebulae() {
      nebulae.length = 0;
      const colors = [C.violet, C.indigo, C.cyan, C.magenta];
      for (let i = 0; i < 5; i++) {
        nebulae.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.03,
          vy: (Math.random() - 0.5) * 0.03,
          radius: 150 + Math.random() * 250,
          color: colors[i % colors.length],
          alpha: 0.012 + Math.random() * 0.018,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    function initScanSweep() {
      scanSweep = {
        angle: 0,
        speed: 0.0006,
        alpha: 0,
        length: Math.min(width, height) * 0.6,
      };
    }

    // ── Signal trace generation ──────────────────────────────────────────────

    function spawnSignalTrace() {
      if (traces.length >= 6) return;
      const startEdge = Math.floor(Math.random() * 4);
      let sx: number, sy: number, dx: number, dy: number;

      if (startEdge === 0) { sx = -20; sy = Math.random() * height; dx = 1; dy = (Math.random() - 0.5) * 0.6; }
      else if (startEdge === 1) { sx = width + 20; sy = Math.random() * height; dx = -1; dy = (Math.random() - 0.5) * 0.6; }
      else if (startEdge === 2) { sx = Math.random() * width; sy = -20; dx = (Math.random() - 0.5) * 0.6; dy = 1; }
      else { sx = Math.random() * width; sy = height + 20; dx = (Math.random() - 0.5) * 0.6; dy = -1; }

      const points: { x: number; y: number }[] = [];
      let cx = sx, cy = sy;
      const segCount = 4 + Math.floor(Math.random() * 4);
      for (let i = 0; i < segCount; i++) {
        points.push({ x: cx, y: cy });
        const stepLen = 60 + Math.random() * 120;
        cx += dx * stepLen + (Math.random() - 0.5) * 40;
        cy += dy * stepLen + (Math.random() - 0.5) * 40;
        // Gentle direction drift
        dx += (Math.random() - 0.5) * 0.3;
        dy += (Math.random() - 0.5) * 0.3;
        const mag = Math.sqrt(dx * dx + dy * dy) || 1;
        dx /= mag; dy /= mag;
      }

      traces.push({
        points,
        progress: 0,
        speed: 0.003 + Math.random() * 0.004,
        alpha: 0,
        color: pick([C.cyan, C.violet, C.teal]),
        life: 0,
        maxLife: 300 + Math.random() * 200,
      });
    }

    // ── Event handlers ───────────────────────────────────────────────────────

    function onForgePulse(e: Event) {
      const detail = (e as CustomEvent).detail;
      const cx = detail?.x ?? width / 2;
      const cy = detail?.y ?? height / 2;
      const count = detail?.count ?? 16;

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.2;
        const speed = 1.2 + Math.random() * 3.5;
        burstParticles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 60 + Math.random() * 40,
          maxLife: 80,
          color: Math.random() < 0.5 ? C.cyan : C.violet,
          radius: 1.2 + Math.random() * 2,
        });
      }

      energyMultiplier = Math.min(3, energyMultiplier + 0.8);
      flashAlpha = 0.06;
      flashColor = C.cyan;

      // Spawn a signal trace on forge
      spawnSignalTrace();
    }

    function onChatActivity(e: Event) {
      const level = (e as CustomEvent).detail?.level ?? 0;
      chatLevel = level;
      energyMultiplier = Math.max(energyMultiplier, 1 + level * 0.25);
    }

    function onVisualCapture(e: Event) {
      flashAlpha = 0.10;
      flashColor = C.violet;
      energyMultiplier = Math.min(2.5, energyMultiplier + 0.5);
      spawnSignalTrace();
    }

    window.addEventListener('bg-forge-pulse', onForgePulse as EventListener);
    window.addEventListener('bg-chat-activity', onChatActivity as EventListener);
    window.addEventListener('bg-visual-capture', onVisualCapture as EventListener);

    // Mouse tracking
    let mouseHandler: ((e: MouseEvent) => void) | null = null;
    if (!prefersReducedMotion) {
      mouseHandler = (e: MouseEvent) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
      };
      window.addEventListener('mousemove', mouseHandler);
    }

    // ── Render loop ──────────────────────────────────────────────────────────

    function render(now: number) {
      const dt = Math.min(33, now - lastTime);
      lastTime = now;
      globalTime += dt;
      const dtFactor = dt / 16.67;

      ctx.clearRect(0, 0, width, height);

      // ── 1. Deep space gradient ─────────────────────────────────────────────
      const grad = ctx.createRadialGradient(
        width / 2, height * 0.45, 50,
        width / 2, height * 0.45, Math.max(width, height) * 0.9
      );
      grad.addColorStop(0, '#0a0e22');
      grad.addColorStop(0.35, '#070b18');
      grad.addColorStop(0.7, '#050714');
      grad.addColorStop(1, '#020308');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // ── 2. Nebula clouds (slow drifting, breathing) ────────────────────────
      for (const neb of nebulae) {
        neb.x += neb.vx * dtFactor;
        neb.y += neb.vy * dtFactor;
        if (neb.x < -neb.radius) neb.x = width + neb.radius;
        if (neb.x > width + neb.radius) neb.x = -neb.radius;
        if (neb.y < -neb.radius) neb.y = height + neb.radius;
        if (neb.y > height + neb.radius) neb.y = -neb.radius;

        const breathe = 0.6 + 0.4 * Math.sin(globalTime * 0.0002 + neb.phase);
        const ng = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.radius);
        ng.addColorStop(0, `rgba(${neb.color}, ${neb.alpha * breathe})`);
        ng.addColorStop(0.5, `rgba(${neb.color}, ${neb.alpha * breathe * 0.4})`);
        ng.addColorStop(1, `rgba(${neb.color}, 0)`);
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(neb.x, neb.y, neb.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── 3. Orbital rings (concentric, slow rotation, breathing) ───────────
      for (const ring of rings) {
        ring.rotation += ring.rotSpeed * dtFactor;
        const pulse = 0.7 + 0.3 * Math.sin(globalTime * 0.0005 + ring.pulsePhase);
        const alpha = ring.alpha * pulse * (1 + chatLevel * 0.1);

        // Elliptical ring
        ctx.save();
        ctx.translate(ring.cx, ring.cy);
        ctx.rotate(ring.rotation);
        ctx.beginPath();
        ctx.ellipse(0, 0, ring.radius, ring.radius * ring.tilt, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${ring.color}, ${alpha})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();

        // Inner glow ring
        ctx.beginPath();
        ctx.ellipse(0, 0, ring.radius, ring.radius * ring.tilt, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${ring.color}, ${alpha * 0.3})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();

        // Orbital nodes — dots traveling along the ring
        for (let n = 0; n < ring.nodes; n++) {
          const nodeAngle = ring.rotation + (n / ring.nodes) * Math.PI * 2;
          const nx = ring.cx + Math.cos(nodeAngle) * ring.radius;
          const ny = ring.cy + Math.sin(nodeAngle) * ring.radius * ring.tilt;
          const nodeAlpha = alpha * 3;

          // Glow
          ctx.beginPath();
          ctx.arc(nx, ny, 4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${ring.color}, ${nodeAlpha * 0.15})`;
          ctx.fill();

          // Core
          ctx.beginPath();
          ctx.arc(nx, ny, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${ring.color}, ${nodeAlpha})`;
          ctx.fill();
        }
      }

      // ── 4. Scanning sweep (radial, slow, like a cosmic radar) ──────────────
      if (scanSweep) {
        scanSweep.angle += scanSweep.speed * dtFactor * energyMultiplier;
        const sweepAlpha = 0.04 + chatLevel * 0.01;
        const sweepCx = width / 2;
        const sweepCy = height * 0.5;
        const sweepLen = scanSweep.length;

        // Sweep gradient wedge
        ctx.save();
        ctx.translate(sweepCx, sweepCy);
        ctx.rotate(scanSweep.angle);
        const sweepGrad = ctx.createLinearGradient(0, 0, sweepLen, 0);
        sweepGrad.addColorStop(0, `rgba(${C.cyan}, 0)`);
        sweepGrad.addColorStop(0.7, `rgba(${C.cyan}, ${sweepAlpha * 0.5})`);
        sweepGrad.addColorStop(1, `rgba(${C.cyan}, ${sweepAlpha})`);
        ctx.fillStyle = sweepGrad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, sweepLen, -0.08, 0.08);
        ctx.closePath();
        ctx.fill();

        // Leading edge line
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(sweepLen, 0);
        ctx.strokeStyle = `rgba(${C.cyan}, ${sweepAlpha * 1.5})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
        ctx.restore();
      }

      // ── 5. Stars (parallax twinkle, mouse reactivity) ──────────────────────
      const speedMult = energyMultiplier * (prefersReducedMotion ? 0.3 : 1);

      for (const s of stars) {
        s.x += s.vx * dtFactor * speedMult;
        s.y += s.vy * dtFactor * speedMult;

        // Wrap
        if (s.x < -10) s.x = width + 10;
        if (s.x > width + 10) s.x = -10;
        if (s.y < -10) s.y = height + 10;
        if (s.y > height + 10) s.y = -10;

        // Twinkle
        s.twinklePhase += s.twinkleSpeed * dtFactor;
        const twinkle = 0.5 + 0.5 * Math.sin(s.twinklePhase);
        s.alpha = s.baseAlpha * twinkle;

        // Mouse proximity boost
        if (mouseX > 0) {
          const mdx = s.x - mouseX;
          const mdy = s.y - mouseY;
          const md2 = mdx * mdx + mdy * mdy;
          if (md2 < 22500) { // 150px
            const boost = (1 - Math.sqrt(md2) / 150) * 0.3;
            s.alpha = Math.min(1, s.alpha + boost);
          }
        }

        // Glow halo for brighter stars
        if (s.depth > 0.5) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.radius * 3.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${s.color}, ${s.alpha * 0.08})`;
          ctx.fill();
        }

        // Core
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${s.color}, ${s.alpha})`;
        ctx.fill();

        // Cross sparkle for the brightest stars
        if (s.depth > 0.75 && s.alpha > 0.5) {
          const sparkLen = s.radius * 4 * s.alpha;
          ctx.strokeStyle = `rgba(${s.color}, ${s.alpha * 0.3})`;
          ctx.lineWidth = 0.4;
          ctx.beginPath();
          ctx.moveTo(s.x - sparkLen, s.y);
          ctx.lineTo(s.x + sparkLen, s.y);
          ctx.moveTo(s.x, s.y - sparkLen);
          ctx.lineTo(s.x, s.y + sparkLen);
          ctx.stroke();
        }
      }

      // ── 6. Constellation lattice (deliberate, geometric) ───────────────────
      rebuildGrid();
      populateGrid();

      const CONNECT_DIST = 140;
      const CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;
      const MAX_CONN = 3;

      for (let i = 0; i < stars.length; i++) {
        const s1 = stars[i];
        if (s1.depth < 0.3) continue; // only connect brighter stars

        const cx = Math.max(0, Math.min(gridCols - 1, Math.floor(s1.x / CELL_SIZE)));
        const cy = Math.max(0, Math.min(gridRows - 1, Math.floor(s1.y / CELL_SIZE)));

        let connections = 0;
        for (let dy = -1; dy <= 1 && connections < MAX_CONN; dy++) {
          for (let dx = -1; dx <= 1 && connections < MAX_CONN; dx++) {
            const ncx = cx + dx;
            const ncy = cy + dy;
            if (ncx < 0 || ncx >= gridCols || ncy < 0 || ncy >= gridRows) continue;

            const cell = grid[ncy * gridCols + ncx];
            for (let k = 0; k < cell.length && connections < MAX_CONN; k++) {
              const j = cell[k];
              if (j <= i) continue;
              const s2 = stars[j];
              if (s2.depth < 0.3) continue;

              const ddx = s1.x - s2.x;
              const ddy = s1.y - s2.y;
              const distSq = ddx * ddx + ddy * ddy;
              if (distSq > CONNECT_DIST_SQ) continue;

              const dist = Math.sqrt(distSq);
              const proximity = 1 - dist / CONNECT_DIST;
              const lineAlpha = proximity * 0.04 * Math.min(s1.alpha, s2.alpha);
              if (lineAlpha < 0.003) continue;

              ctx.beginPath();
              ctx.moveTo(s1.x, s1.y);
              ctx.lineTo(s2.x, s2.y);
              ctx.strokeStyle = `rgba(${C.cyan}, ${lineAlpha})`;
              ctx.lineWidth = 0.4;
              ctx.stroke();
              connections++;
            }
          }
        }
      }

      // ── 7. Signal traces (curved paths with traveling pulses) ──────────────
      // Spawn occasionally
      if (Math.random() < 0.003 * dtFactor * (1 + chatLevel * 0.3) && traces.length < 6) {
        spawnSignalTrace();
      }

      for (let i = traces.length - 1; i >= 0; i--) {
        const t = traces[i];
        t.life += dtFactor;
        t.progress += t.speed * dtFactor * speedMult;

        // Fade in/out
        const lifeRatio = t.life / t.maxLife;
        if (lifeRatio < 0.15) t.alpha = lifeRatio / 0.15;
        else if (lifeRatio > 0.75) t.alpha = (1 - lifeRatio) / 0.25;
        else t.alpha = 1;

        if (t.life >= t.maxLife || t.progress >= 1) {
          traces.splice(i, 1);
          continue;
        }

        // Draw the path (faint)
        ctx.beginPath();
        ctx.moveTo(t.points[0].x, t.points[0].y);
        for (let p = 1; p < t.points.length; p++) {
          ctx.lineTo(t.points[p].x, t.points[p].y);
        }
        ctx.strokeStyle = `rgba(${t.color}, ${t.alpha * 0.06})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Draw the traveling pulse along the path
        const totalSegs = t.points.length - 1;
        const segProgress = t.progress * totalSegs;
        const segIdx = Math.floor(segProgress);
        const segT = segProgress - segIdx;

        if (segIdx < totalSegs) {
          const p1 = t.points[segIdx];
          const p2 = t.points[segIdx + 1];
          const px = p1.x + (p2.x - p1.x) * segT;
          const py = p1.y + (p2.y - p1.y) * segT;

          // Trailing glow
          const trailLen = 40;
          const trailStartT = Math.max(0, segProgress - trailLen / 100);
          const trailSegIdx = Math.floor(trailStartT * totalSegs);
          const trailSegT = (trailStartT * totalSegs) - trailSegIdx;

          if (trailSegIdx < totalSegs && trailSegIdx >= 0) {
            const tp1 = t.points[trailSegIdx];
            const tp2 = t.points[trailSegIdx + 1] || tp1;
            const tx = tp1.x + (tp2.x - tp1.x) * trailSegT;
            const ty = tp1.y + (tp2.y - tp1.y) * trailSegT;

            const trailGrad = ctx.createLinearGradient(tx, ty, px, py);
            trailGrad.addColorStop(0, `rgba(${t.color}, 0)`);
            trailGrad.addColorStop(1, `rgba(${t.color}, ${t.alpha * 0.5})`);
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(px, py);
            ctx.strokeStyle = trailGrad;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }

          // Pulse head glow
          ctx.beginPath();
          ctx.arc(px, py, 6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${t.color}, ${t.alpha * 0.1})`;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(px, py, 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${t.color}, ${t.alpha * 0.8})`;
          ctx.fill();
        }
      }

      // ── 8. Burst particles (event-driven) ──────────────────────────────────
      for (let i = burstParticles.length - 1; i >= 0; i--) {
        const b = burstParticles[i];
        b.x += b.vx * dtFactor;
        b.y += b.vy * dtFactor;
        b.vx *= 0.96;
        b.vy *= 0.96;
        b.life -= dtFactor;
        if (b.life <= 0) {
          burstParticles.splice(i, 1);
          continue;
        }
        const lifeRatio = b.life / b.maxLife;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${b.color}, ${lifeRatio * 0.08})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${b.color}, ${lifeRatio * 0.7})`;
        ctx.fill();
      }

      // ── 9. Edge vignette ───────────────────────────────────────────────────
      const edgeGrad = ctx.createRadialGradient(
        width / 2, height / 2, Math.min(width, height) * 0.3,
        width / 2, height / 2, Math.max(width, height) * 0.75
      );
      edgeGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      edgeGrad.addColorStop(1, 'rgba(2, 3, 8, 0.5)');
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(0, 0, width, height);

      // ── 10. Event flash ────────────────────────────────────────────────────
      if (flashAlpha > 0.001) {
        ctx.fillStyle = `rgba(${flashColor}, ${flashAlpha})`;
        ctx.fillRect(0, 0, width, height);
        flashAlpha *= 0.88;
      }

      // ── 11. Energy decay ───────────────────────────────────────────────────
      energyMultiplier += (1 + chatLevel * 0.15 - energyMultiplier) * 0.005 * dtFactor;

      animationFrameId = requestAnimationFrame(render);
    }

    // ── Resize handling ──────────────────────────────────────────────────────
    let resizeTimeout: number;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        clearTimeout(resizeTimeout);
        resizeTimeout = window.setTimeout(() => {
          width = w;
          height = h;
          dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          canvas.style.width = w + 'px';
          canvas.style.height = h + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          if (stars.length === 0) {
            initStars();
            initRings();
            initNebulae();
            initScanSweep();
          } else {
            // Re-init rings on resize to recenter
            initRings();
            initScanSweep();
          }
          rebuildGrid();
        }, 80);
      }
    });

    resizeObserver.observe(container);
    lastTime = performance.now();
    animationFrameId = requestAnimationFrame(render);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      clearTimeout(resizeTimeout);
      window.removeEventListener('bg-forge-pulse', onForgePulse as EventListener);
      window.removeEventListener('bg-chat-activity', onChatActivity as EventListener);
      window.removeEventListener('bg-visual-capture', onVisualCapture as EventListener);
      if (mouseHandler) {
        window.removeEventListener('mousemove', mouseHandler);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-0 w-full h-full overflow-hidden select-none pointer-events-none"
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full opacity-70 block"
      />
    </div>
  );
}
