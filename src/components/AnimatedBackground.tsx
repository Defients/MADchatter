import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../store';

// ─── Types ──────────────────────────────────────────────────────────────────

type ParticleType = 'ambient' | 'signal' | 'pulse';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  targetAlpha: number;
  type: ParticleType;
  energy: number;       // 0–1, boosted by events; decays over time
  life: number;         // remaining frames for pulse particles (-1 = infinite)
  maxLife: number;
  trail: number[];      // [x0,y0,x1,y1,...] for pulse trails
  phase: number;        // per-particle phase offset for breathing
}

interface DustOrb {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  phase: number;
}

interface FlowDot {
  fromIdx: number;
  toIdx: number;
  t: number;       // 0–1 position along the link
  speed: number;
}

// ─── Palette ────────────────────────────────────────────────────────────────

const PALETTE = {
  purple:  '168, 85, 247',
  orange:  '249, 115, 22',
  blue:    '59, 130, 246',
  cyan:    '34, 211, 238',
  magenta: '236, 72, 153',
};

const COSMOTECH_PALETTE = {
  purple:  '167, 139, 250',
  orange:  '99, 102, 241',
  blue:    '34, 211, 238',
  cyan:    '34, 211, 238',
  magenta: '232, 121, 249',
};

function pickColor(type: ParticleType, palette = PALETTE): string {
  const r = Math.random();
  if (type === 'pulse') {
    return r < 0.5 ? palette.cyan : palette.magenta;
  }
  if (type === 'signal') {
    if (r < 0.35) return palette.cyan;
    if (r < 0.55) return palette.magenta;
    if (r < 0.75) return palette.purple;
    if (r < 0.9) return palette.blue;
    return palette.orange;
  }
  // ambient — keep the original soul
  if (r < 0.4) return palette.purple;
  if (r < 0.7) return palette.orange;
  return palette.blue;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AnimatedBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cosmotechTheme = useAppStore((s) => s.cosmotechTheme);
  const themeRef = useRef(cosmotechTheme);
  themeRef.current = cosmotechTheme;

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
    const particles: Particle[] = [];
    const dustOrbs: DustOrb[] = [];
    const flowDots: FlowDot[] = [];

    const MAX_AMBIENT = 65;
    const MAX_SIGNAL = 30;
    const MAX_PULSE = 12;

    // Reactivity state
    let chatLevel = 0;          // 0–4
    let energyMultiplier = 1;   // global speed multiplier, decays toward 1
    let flashAlpha = 0;         // brief full-screen flash on events
    let flashColor = PALETTE.cyan;
    let burstParticles: { x: number; y: number; vx: number; vy: number; life: number; color: string; radius: number }[] = [];

    // Mouse proximity
    let mouseX = -9999;
    let mouseY = -9999;

    // Time tracking
    let lastTime = performance.now();
    let globalTime = 0;

    // ── Spatial grid for connection culling ──────────────────────────────────
    const CELL_SIZE = 160;
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
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.life === 0) continue;
        const cx = Math.max(0, Math.min(gridCols - 1, Math.floor(p.x / CELL_SIZE)));
        const cy = Math.max(0, Math.min(gridRows - 1, Math.floor(p.y / CELL_SIZE)));
        grid[cy * gridCols + cx].push(i);
      }
    }

    // ── Particle factory ─────────────────────────────────────────────────────

    function makeParticle(type: ParticleType, atEdge?: boolean): Particle {
      const isPulse = type === 'pulse';
      const speedRange = type === 'ambient' ? 0.18 : type === 'signal' ? 0.45 : 2.8;
      const radiusRange = type === 'ambient' ? 1.2 : type === 'signal' ? 1.6 : 2.4;
      const palette = themeRef.current ? COSMOTECH_PALETTE : PALETTE;

      let x: number, y: number;
      if (atEdge && isPulse) {
        // Spawn from a random edge
        const edge = Math.floor(Math.random() * 4);
        if (edge === 0) { x = Math.random() * width; y = -10; }
        else if (edge === 1) { x = width + 10; y = Math.random() * height; }
        else if (edge === 2) { x = Math.random() * width; y = height + 10; }
        else { x = -10; y = Math.random() * height; }
      } else {
        x = Math.random() * width;
        y = Math.random() * height;
      }

      const angle = Math.random() * Math.PI * 2;
      const speed = (Math.random() * 0.5 + 0.5) * speedRange;
      const life = isPulse ? 80 + Math.random() * 60 : -1;

      return {
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: Math.random() * radiusRange + 1.0,
        color: pickColor(type, palette),
        alpha: type === 'ambient' ? Math.random() * 0.12 : type === 'signal' ? Math.random() * 0.2 + 0.1 : 0.4,
        targetAlpha: type === 'ambient' ? Math.random() * 0.15 + 0.04 : type === 'signal' ? Math.random() * 0.25 + 0.12 : 0.5,
        type,
        energy: 0,
        life,
        maxLife: life,
        trail: [],
        phase: Math.random() * Math.PI * 2,
      };
    }

    function initParticles() {
      particles.length = 0;
      for (let i = 0; i < MAX_AMBIENT; i++) particles.push(makeParticle('ambient'));
      for (let i = 0; i < MAX_SIGNAL; i++) particles.push(makeParticle('signal'));
      // pulse particles are spawned dynamically; start with a few
      for (let i = 0; i < 3; i++) particles.push(makeParticle('pulse', true));

      // Cosmic dust orbs — very few, very large, very slow
      dustOrbs.length = 0;
      const orbPalette = themeRef.current ? COSMOTECH_PALETTE : PALETTE;
      for (let i = 0; i < 3; i++) {
        dustOrbs.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.04,
          vy: (Math.random() - 0.5) * 0.04,
          radius: 120 + Math.random() * 180,
          color: Math.random() < 0.5 ? orbPalette.purple : orbPalette.blue,
          alpha: 0.015 + Math.random() * 0.02,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    // ── Event handlers (reactivity API via window custom events) ─────────────

    function onForgePulse(e: Event) {
      const detail = (e as CustomEvent).detail;
      const cx = detail?.x ?? width / 2;
      const cy = detail?.y ?? height / 2;
      const count = detail?.count ?? 14;

      // Spawn burst particles
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
        const speed = 1.5 + Math.random() * 3;
        const burstPalette = themeRef.current ? COSMOTECH_PALETTE : PALETTE;
        burstParticles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 50 + Math.random() * 30,
          color: Math.random() < 0.5 ? burstPalette.cyan : burstPalette.magenta,
          radius: 1.5 + Math.random() * 2,
        });
      }

      // Energize nearby particles
      for (const p of particles) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 300) {
          p.energy = Math.min(1, p.energy + (1 - dist / 300) * 0.7);
        }
      }

      energyMultiplier = Math.min(3, energyMultiplier + 0.8);
      flashAlpha = 0.08;
      flashColor = themeRef.current ? COSMOTECH_PALETTE.cyan : PALETTE.cyan;
    }

    function onChatActivity(e: Event) {
      const level = (e as CustomEvent).detail?.level ?? 0;
      chatLevel = level;
      // Map chat level to energy multiplier
      const targetMult = 1 + level * 0.3;
      energyMultiplier = Math.max(energyMultiplier, targetMult);

      // At high chat activity, spawn extra pulse particles
      if (level >= 3) {
        for (let i = 0; i < 2; i++) {
          if (particles.filter(p => p.type === 'pulse' && p.life > 0).length < MAX_PULSE) {
            const p = makeParticle('pulse', true);
            // Bias vertical "data rain" at high activity
            if (level >= 4 && Math.random() < 0.6) {
              p.vx *= 0.3;
              p.vy = Math.abs(p.vy) * 1.5;
            }
            particles.push(p);
          }
        }
      }
    }

    function onVisualCapture(e: Event) {
      flashAlpha = 0.12;
      flashColor = themeRef.current ? COSMOTECH_PALETTE.cyan : PALETTE.orange;
      energyMultiplier = Math.min(2.5, energyMultiplier + 0.5);

      // Brief burst of signal particles
      for (let i = 0; i < 6; i++) {
        if (particles.filter(p => p.type === 'signal').length < MAX_SIGNAL + 8) {
          particles.push(makeParticle('signal'));
        }
      }
    }

    window.addEventListener('bg-forge-pulse', onForgePulse as EventListener);
    window.addEventListener('bg-chat-activity', onChatActivity as EventListener);
    window.addEventListener('bg-visual-capture', onVisualCapture as EventListener);

    // Mouse tracking (disabled if reduced motion)
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
      const dt = Math.min(33, now - lastTime); // cap dt to avoid jumps
      lastTime = now;
      globalTime += dt;
      const dtFactor = dt / 16.67; // normalize to ~60fps frames

      ctx.clearRect(0, 0, width, height);

      // ── 1. Deep radial gradient background ────────────────────────────────
      const isCT = themeRef.current;
      const grad = ctx.createRadialGradient(
        width / 2, height * 0.45, 50,
        width / 2, height * 0.45, Math.max(width, height) * 0.85
      );
      if (isCT) {
        grad.addColorStop(0, '#0a0e1f');
        grad.addColorStop(0.5, '#070a18');
        grad.addColorStop(1, '#04060f');
      } else {
        grad.addColorStop(0, '#0d0d18');
        grad.addColorStop(0.5, '#0a0a12');
        grad.addColorStop(1, '#040406');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // ── 2. Cosmic dust orbs (very slow drifting large glows) ──────────────
      for (const orb of dustOrbs) {
        orb.x += orb.vx * dtFactor;
        orb.y += orb.vy * dtFactor;
        if (orb.x < -orb.radius) orb.x = width + orb.radius;
        if (orb.x > width + orb.radius) orb.x = -orb.radius;
        if (orb.y < -orb.radius) orb.y = height + orb.radius;
        if (orb.y > height + orb.radius) orb.y = -orb.radius;

        const breathe = 0.7 + 0.3 * Math.sin(globalTime * 0.0003 + orb.phase);
        const og = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, orb.radius);
        og.addColorStop(0, `rgba(${orb.color}, ${orb.alpha * breathe})`);
        og.addColorStop(1, `rgba(${orb.color}, 0)`);
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, orb.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── 3. Top-edge energy horizon ────────────────────────────────────────
      // Deeper vignette + animated horizontal energy line near top
      const horizonY = 75;
      const topVignette = ctx.createLinearGradient(0, 0, 0, 140);
      topVignette.addColorStop(0, 'rgba(8, 8, 14, 0.65)');
      topVignette.addColorStop(0.5, 'rgba(8, 8, 14, 0.25)');
      topVignette.addColorStop(1, 'rgba(8, 8, 14, 0)');
      ctx.fillStyle = topVignette;
      ctx.fillRect(0, 0, width, 140);

      // Energy horizon line — pulses with activity
      const horizonPulse = 0.3 + 0.15 * Math.sin(globalTime * 0.001) + chatLevel * 0.08;
      const horizonColor = isCT ? COSMOTECH_PALETTE.cyan : PALETTE.purple;
      const hg = ctx.createLinearGradient(0, horizonY - 1, 0, horizonY + 1);
      hg.addColorStop(0, `rgba(${horizonColor}, 0)`);
      hg.addColorStop(0.5, `rgba(${horizonColor}, ${horizonPulse})`);
      hg.addColorStop(1, `rgba(${horizonColor}, 0)`);
      ctx.fillStyle = hg;
      ctx.fillRect(0, horizonY - 1, width, 2);

      // Flowing micro-particles along the horizon
      const flowCount = 5 + chatLevel * 2;
      for (let i = 0; i < flowCount; i++) {
        const fx = ((globalTime * 0.04 * (1 + chatLevel * 0.3) + i * (width / flowCount)) % (width + 100)) - 50;
        const fy = horizonY + Math.sin(globalTime * 0.002 + i * 1.3) * 8;
        const fAlpha = 0.15 + 0.1 * Math.sin(globalTime * 0.003 + i) + chatLevel * 0.04;
        ctx.beginPath();
        ctx.arc(fx, fy, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${horizonColor}, ${fAlpha})`;
        ctx.fill();
      }

      // ── 4. Edge vignette (bottom + sides) ─────────────────────────────────
      const edgeGrad = ctx.createRadialGradient(
        width / 2, height / 2, Math.min(width, height) * 0.3,
        width / 2, height / 2, Math.max(width, height) * 0.7
      );
      edgeGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      edgeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(0, 0, width, height);

      // ── 5. Update particles ───────────────────────────────────────────────
      const speedMult = energyMultiplier * (prefersReducedMotion ? 0.3 : 1);

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        // Update position
        p.x += p.vx * dtFactor * speedMult;
        p.y += p.vy * dtFactor * speedMult;

        // Energy decay
        if (p.energy > 0) {
          p.energy = Math.max(0, p.energy - 0.008 * dtFactor);
        }

        // Alpha breathing
        const breathe = p.type === 'ambient'
          ? 0.005
          : p.type === 'signal'
            ? 0.008
            : 0.015;
        p.alpha += (p.targetAlpha - p.alpha) * breathe * dtFactor;

        // Mouse proximity boost (cheap — only if mouse is on screen)
        if (mouseX > 0) {
          const mdx = p.x - mouseX;
          const mdy = p.y - mouseY;
          const mdist2 = mdx * mdx + mdy * mdy;
          if (mdist2 < 14400) { // 120px radius
            const boost = (1 - Math.sqrt(mdist2) / 120) * 0.15;
            p.alpha = Math.min(0.8, p.alpha + boost * dtFactor);
          }
        }

        // Pulse particle trail
        if (p.type === 'pulse') {
          p.trail.push(p.x, p.y);
          if (p.trail.length > 16) p.trail.splice(0, 2);

          p.life -= dtFactor;
          if (p.life <= 0) {
            particles.splice(i, 1);
            continue;
          }
          // Fade out near end of life
          const lifeRatio = p.life / p.maxLife;
          p.alpha = p.targetAlpha * Math.min(1, lifeRatio * 2);
        }

        // Edge handling
        if (p.type === 'pulse') {
          // Remove pulse particles that go far off-screen
          if (p.x < -50 || p.x > width + 50 || p.y < -50 || p.y > height + 50) {
            particles.splice(i, 1);
            continue;
          }
        } else {
          // Ambient + signal: wrap around
          if (p.x < -20) p.x = width + 20;
          if (p.x > width + 20) p.x = -20;
          if (p.y < -20) p.y = height + 20;
          if (p.y > height + 20) p.y = -20;
        }
      }

      // Maintain minimum pulse particles
      const pulseCount = particles.filter(p => p.type === 'pulse').length;
      if (pulseCount < 2 && Math.random() < 0.005 * dtFactor) {
        particles.push(makeParticle('pulse', true));
      }

      // ── 6. Spatial grid + connection lattice ──────────────────────────────
      rebuildGrid();
      populateGrid();

      const CONNECT_DIST = 160;
      const CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;
      const MAX_CONNECTIONS_PER_PARTICLE = 4;

      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i];
        if (p1.life === 0) continue;

        const cx = Math.max(0, Math.min(gridCols - 1, Math.floor(p1.x / CELL_SIZE)));
        const cy = Math.max(0, Math.min(gridRows - 1, Math.floor(p1.y / CELL_SIZE)));

        let connectionsDrawn = 0;
        for (let dy = -1; dy <= 1 && connectionsDrawn < MAX_CONNECTIONS_PER_PARTICLE; dy++) {
          for (let dx = -1; dx <= 1 && connectionsDrawn < MAX_CONNECTIONS_PER_PARTICLE; dx++) {
            const ncx = cx + dx;
            const ncy = cy + dy;
            if (ncx < 0 || ncx >= gridCols || ncy < 0 || ncy >= gridRows) continue;

            const cell = grid[ncy * gridCols + ncx];
            for (let k = 0; k < cell.length && connectionsDrawn < MAX_CONNECTIONS_PER_PARTICLE; k++) {
              const j = cell[k];
              if (j <= i) continue;

              const p2 = particles[j];
              if (p2.life === 0) continue;

              const ddx = p1.x - p2.x;
              const ddy = p1.y - p2.y;
              const distSq = ddx * ddx + ddy * ddy;
              if (distSq > CONNECT_DIST_SQ) continue;

              const dist = Math.sqrt(distSq);
              const proximity = 1 - dist / CONNECT_DIST;
              const combinedEnergy = (p1.energy + p2.energy) * 0.5;
              const isSignal = p1.type === 'signal' || p2.type === 'signal';

              // Base alpha from proximity + particle alphas + energy boost
              let lineAlpha = proximity * 0.06 * Math.min(p1.alpha, p2.alpha);
              lineAlpha += combinedEnergy * proximity * 0.15;
              if (isSignal) lineAlpha *= 1.4;
              lineAlpha = Math.min(lineAlpha, 0.25);

              if (lineAlpha < 0.003) continue;

              // Color: blend toward cyan/magenta when energized
              const ctPalette = themeRef.current ? COSMOTECH_PALETTE : PALETTE;
              const linkColor = combinedEnergy > 0.2
                ? (isSignal ? ctPalette.cyan : ctPalette.magenta)
                : ctPalette.purple;

              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.strokeStyle = `rgba(${linkColor}, ${lineAlpha})`;
              ctx.lineWidth = 0.6 + combinedEnergy * 0.8 + (isSignal ? 0.2 : 0);
              ctx.stroke();

              connectionsDrawn++;

              // Occasionally spawn a flow dot on energized signal links
              if (isSignal && combinedEnergy > 0.3 && Math.random() < 0.002 * dtFactor && flowDots.length < 12) {
                flowDots.push({ fromIdx: i, toIdx: j, t: 0, speed: 0.01 + Math.random() * 0.015 });
              }
            }
          }
        }
      }

      // ── 7. Flow dots traveling along connections ──────────────────────────
      for (let i = flowDots.length - 1; i >= 0; i--) {
        const fd = flowDots[i];
        const p1 = particles[fd.fromIdx];
        const p2 = particles[fd.toIdx];
        if (!p1 || !p2 || p1.life === 0 || p2.life === 0) {
          flowDots.splice(i, 1);
          continue;
        }
        fd.t += fd.speed * dtFactor;
        if (fd.t >= 1) {
          flowDots.splice(i, 1);
          continue;
        }
        const fx = p1.x + (p2.x - p1.x) * fd.t;
        const fy = p1.y + (p2.y - p1.y) * fd.t;
        const fade = Math.sin(fd.t * Math.PI); // fade in/out
        ctx.beginPath();
        ctx.arc(fx, fy, 1.5, 0, Math.PI * 2);
        const dotColor = themeRef.current ? COSMOTECH_PALETTE.cyan : PALETTE.cyan;
        ctx.fillStyle = `rgba(${dotColor}, ${0.4 * fade})`;
        ctx.fill();
      }

      // ── 8. Draw particles ─────────────────────────────────────────────────
      for (const p of particles) {
        if (p.life === 0) continue;

        const energyBoost = p.energy;
        const drawRadius = p.radius * (1 + energyBoost * 0.5);
        const drawAlpha = Math.min(0.9, p.alpha + energyBoost * 0.2);

        // Glow halo (cheap: one larger low-alpha circle behind)
        if (p.type !== 'ambient' || energyBoost > 0.1) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, drawRadius * 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${p.color}, ${drawAlpha * 0.12})`;
          ctx.fill();
        }

        // Pulse trail
        if (p.type === 'pulse' && p.trail.length >= 4) {
          ctx.beginPath();
          ctx.moveTo(p.trail[0], p.trail[1]);
          for (let t = 2; t < p.trail.length; t += 2) {
            ctx.lineTo(p.trail[t], p.trail[t + 1]);
          }
          ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = `rgba(${p.color}, ${drawAlpha * 0.3})`;
          ctx.lineWidth = drawRadius * 0.8;
          ctx.lineCap = 'round';
          ctx.stroke();
        }

        // Core particle
        ctx.beginPath();
        ctx.arc(p.x, p.y, drawRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${drawAlpha})`;
        ctx.fill();
      }

      // ── 9. Event burst particles ──────────────────────────────────────────
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
        const lifeRatio = b.life / 80;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${b.color}, ${lifeRatio * 0.1})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${b.color}, ${lifeRatio * 0.6})`;
        ctx.fill();
      }

      // ── 10. Event flash overlay ───────────────────────────────────────────
      if (flashAlpha > 0.001) {
        ctx.fillStyle = `rgba(${flashColor}, ${flashAlpha})`;
        ctx.fillRect(0, 0, width, height);
        flashAlpha *= 0.88;
      }

      // ── 11. Energy multiplier decay ───────────────────────────────────────
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

          if (particles.length === 0) {
            initParticles();
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
        className="w-full h-full opacity-60 block"
      />
    </div>
  );
}
