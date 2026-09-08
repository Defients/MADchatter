import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store';

// ─── Persona Cursor Themes ───────────────────────────────────────────────────

interface PersonaTheme {
  primary: string;
  secondary: string;
  accent: string;
  // Trail particle behavior
  spread: number;       // how far particles scatter from cursor
  speed: number;        // how fast particles move outward
  size: number;         // base particle radius
  trailLength: number;  // max trail points
  jitter: number;       // random position offset (chaos-like)
  // Cursor core shape
  coreSize: number;     // radius of the cursor core circle
  ringSize: number;     // radius of outer ring
  glowSize: number;     // radius of glow halo
  // Behavior flags
  erratic: boolean;     // particles fly in random directions
  swirling: boolean;    // particles spiral around cursor
  pulsing: boolean;     // cursor pulses rhythmically
}

const PERSONA_THEMES: Record<string, PersonaTheme> = {
  Gremlin: {
    primary: '239, 68, 68',
    secondary: '220, 38, 38',
    accent: '252, 165, 165',
    spread: 28,
    speed: 2.5,
    size: 2.5,
    trailLength: 24,
    jitter: 8,
    coreSize: 5,
    ringSize: 14,
    glowSize: 40,
    erratic: true,
    swirling: false,
    pulsing: true,
  },
  Hype: {
    primary: '249, 115, 22',
    secondary: '234, 88, 12',
    accent: '253, 224, 71',
    spread: 35,
    speed: 3.5,
    size: 3,
    trailLength: 30,
    jitter: 5,
    coreSize: 6,
    ringSize: 16,
    glowSize: 50,
    erratic: false,
    swirling: false,
    pulsing: true,
  },
  Analyst: {
    primary: '59, 130, 246',
    secondary: '37, 99, 235',
    accent: '147, 197, 253',
    spread: 12,
    speed: 1.2,
    size: 1.8,
    trailLength: 18,
    jitter: 1,
    coreSize: 4,
    ringSize: 12,
    glowSize: 35,
    erratic: false,
    swirling: false,
    pulsing: false,
  },
  Short: {
    primary: '20, 184, 166',
    secondary: '13, 148, 136',
    accent: '94, 234, 212',
    spread: 6,
    speed: 0.8,
    size: 1.5,
    trailLength: 10,
    jitter: 0,
    coreSize: 3,
    ringSize: 9,
    glowSize: 25,
    erratic: false,
    swirling: false,
    pulsing: false,
  },
  Questioner: {
    primary: '168, 85, 247',
    secondary: '147, 51, 234',
    accent: '232, 121, 249',
    spread: 20,
    speed: 1.8,
    size: 2.2,
    trailLength: 22,
    jitter: 4,
    coreSize: 4.5,
    ringSize: 13,
    glowSize: 38,
    erratic: false,
    swirling: true,
    pulsing: true,
  },
  Support: {
    primary: '34, 197, 94',
    secondary: '22, 163, 74',
    accent: '134, 239, 172',
    spread: 15,
    speed: 1.5,
    size: 2,
    trailLength: 16,
    jitter: 2,
    coreSize: 4.5,
    ringSize: 13,
    glowSize: 36,
    erratic: false,
    swirling: false,
    pulsing: true,
  },
  none: {
    primary: '229, 231, 235',
    secondary: '156, 163, 175',
    accent: '255, 255, 255',
    spread: 8,
    speed: 1,
    size: 1.5,
    trailLength: 12,
    jitter: 1,
    coreSize: 3.5,
    ringSize: 10,
    glowSize: 28,
    erratic: false,
    swirling: false,
    pulsing: false,
  },
};

// ─── Trail Particle ──────────────────────────────────────────────────────────

interface TrailParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  angle: number;
  angularVel: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RageCursor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const config = useAppStore((s) => s.config);
  // Refs for animation loop to avoid stale closures
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    // Mouse state
    let mouseX = width / 2;
    let mouseY = height / 2;
    let prevMouseX = mouseX;
    let prevMouseY = mouseY;
    let mouseVelocityX = 0;
    let mouseVelocityY = 0;
    let mouseInside = false;
    let mouseDown = false;
    let globalTime = 0;
    let lastTime = performance.now();

    // Trail history (smooth positions for the cursor body)
    const trailHistory: { x: number; y: number }[] = [];

    // Active particles
    const particles: TrailParticle[] = [];

    // Click burst particles
    const burstParticles: TrailParticle[] = [];

    function getTheme(): PersonaTheme {
      const cfg = configRef.current;
      const persona = cfg.primaryProfile || 'none';
      return PERSONA_THEMES[persona] || PERSONA_THEMES.none;
    }

    function getIntensity(): number {
      const cfg = configRef.current;
      // Combined intensity: average of humor and chaos, normalized 0-1
      return (cfg.humorLevel + cfg.chaosLevel) / 200;
    }

    function getChaosFactor(): number {
      return configRef.current.chaosLevel / 100;
    }

    function getHumorFactor(): number {
      return configRef.current.humorLevel / 100;
    }

    function onMouseMove(e: MouseEvent) {
      prevMouseX = mouseX;
      prevMouseY = mouseY;
      mouseX = e.clientX;
      mouseY = e.clientY;
      mouseVelocityX = mouseX - prevMouseX;
      mouseVelocityY = mouseY - prevMouseY;
      mouseInside = true;

      // Add to trail history
      trailHistory.push({ x: mouseX, y: mouseY });
      const theme = getTheme();
      const maxTrail = Math.floor(theme.trailLength * (0.5 + getIntensity() * 0.5));
      while (trailHistory.length > maxTrail) trailHistory.shift();

      // Spawn trail particles based on intensity & speed
      const speed = Math.sqrt(mouseVelocityX * mouseVelocityX + mouseVelocityY * mouseVelocityY);
      const intensity = getIntensity();
      const chaos = getChaosFactor();

      // Particle spawn rate scales with speed and intensity
      const spawnChance = Math.min(0.9, 0.15 + intensity * 0.5 + (speed / 200) * 0.3);
      const numToSpawn = Math.random() < spawnChance ? 1 + Math.floor(intensity * 2) : 0;

      for (let i = 0; i < numToSpawn; i++) {
        const angle = theme.erratic
          ? Math.random() * Math.PI * 2
          : Math.atan2(mouseVelocityY, mouseVelocityX) + Math.PI + (Math.random() - 0.5) * 0.8;

        const spread = theme.spread * (0.5 + intensity * 0.5);
        const particleSpeed = theme.speed * (0.3 + intensity * 0.7) * (0.5 + Math.random() * 0.8);
        const jitter = theme.jitter * (0.5 + chaos * 0.8);

        const px = mouseX + (Math.random() - 0.5) * spread;
        const py = mouseY + (Math.random() - 0.5) * spread;

        particles.push({
          x: px + (Math.random() - 0.5) * jitter,
          y: py + (Math.random() - 0.5) * jitter,
          vx: Math.cos(angle) * particleSpeed + (Math.random() - 0.5) * chaos * 2,
          vy: Math.sin(angle) * particleSpeed + (Math.random() - 0.5) * chaos * 2,
          life: 30 + Math.random() * 30 + intensity * 20,
          maxLife: 50 + intensity * 30,
          size: theme.size * (0.6 + Math.random() * 0.8) * (0.5 + getHumorFactor() * 0.5),
          color: Math.random() < 0.6 ? theme.primary : Math.random() < 0.5 ? theme.secondary : theme.accent,
          angle: Math.random() * Math.PI * 2,
          angularVel: (Math.random() - 0.5) * 0.1 * (1 + chaos),
        });
      }

      // Cap particles
      const maxParticles = 80 + Math.floor(intensity * 120);
      if (particles.length > maxParticles) {
        particles.splice(0, particles.length - maxParticles);
      }
    }

    function onMouseDown(e: MouseEvent) {
      mouseDown = true;
      // Burst on click
      const theme = getTheme();
      const intensity = getIntensity();
      const chaos = getChaosFactor();
      const burstCount = 12 + Math.floor(intensity * 20);

      for (let i = 0; i < burstCount; i++) {
        const angle = (i / burstCount) * Math.PI * 2 + Math.random() * 0.3;
        const speed = (2 + Math.random() * 4) * (0.5 + intensity * 0.8);
        burstParticles.push({
          x: mouseX,
          y: mouseY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 40 + Math.random() * 30,
          maxLife: 60,
          size: theme.size * (1 + Math.random()),
          color: Math.random() < 0.5 ? theme.primary : theme.accent,
          angle: 0,
          angularVel: 0,
        });
      }
    }

    function onMouseUp() {
      mouseDown = false;
    }

    function onMouseLeave() {
      mouseInside = false;
    }

    function onMouseEnter() {
      mouseInside = true;
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('mouseenter', onMouseEnter);

    // Easter egg particle burst listener
    function onEasterEggParticles(e: Event) {
      const detail = (e as CustomEvent).detail;
      const color = detail?.color || '239, 68, 68';
      const count = detail?.count || 30;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
        const speed = (3 + Math.random() * 5) * (0.8 + Math.random() * 0.6);
        burstParticles.push({
          x: mouseX,
          y: mouseY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 50 + Math.random() * 30,
          maxLife: 70,
          size: 3 + Math.random() * 2,
          color,
          angle: 0,
          angularVel: 0,
        });
      }
    }
    window.addEventListener('easter-egg-particles', onEasterEggParticles);

    // ── Render loop ──────────────────────────────────────────────────────────

    function render(now: number) {
      const dt = Math.min(33, now - lastTime);
      lastTime = now;
      globalTime += dt;
      const dtFactor = dt / 16.67;

      ctx.clearRect(0, 0, width, height);

      if (!mouseInside && trailHistory.length === 0 && particles.length === 0) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      const theme = getTheme();
      const intensity = getIntensity();
      const chaos = getChaosFactor();
      const humor = getHumorFactor();

      // If mouse left, fade out trail history
      if (!mouseInside && trailHistory.length > 0) {
        trailHistory.shift();
      }

      // ── 1. Draw trail line (connecting trail history points) ───────────────
      if (trailHistory.length >= 2) {
        const trailAlpha = 0.15 + intensity * 0.35;
        for (let i = 1; i < trailHistory.length; i++) {
          const p0 = trailHistory[i - 1];
          const p1 = trailHistory[i];
          const t = i / trailHistory.length;
          const alpha = trailAlpha * t;
          const lineWidth = (1 + intensity * 3) * t;

          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.strokeStyle = `rgba(${theme.primary}, ${alpha})`;
          ctx.lineWidth = lineWidth;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }

      // ── 2. Update and draw particles ───────────────────────────────────────
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dtFactor;
        p.y += p.vy * dtFactor;
        p.vx *= 0.95;
        p.vy *= 0.95;

        // Swirling behavior
        if (theme.swirling) {
          p.angle += p.angularVel * dtFactor;
          p.vx += Math.cos(p.angle) * 0.3 * dtFactor;
          p.vy += Math.sin(p.angle) * 0.3 * dtFactor;
        }

        // Chaos jitter
        if (chaos > 0.3 && Math.random() < chaos * 0.1) {
          p.vx += (Math.random() - 0.5) * chaos * 2;
          p.vy += (Math.random() - 0.5) * chaos * 2;
        }

        p.life -= dtFactor;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }

        const lifeRatio = p.life / p.maxLife;
        const alpha = lifeRatio * (0.4 + intensity * 0.4);

        // Glow halo
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${alpha * 0.08})`;
        ctx.fill();

        // Core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * lifeRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${alpha})`;
        ctx.fill();
      }

      // ── 3. Update and draw click burst particles ───────────────────────────
      for (let i = burstParticles.length - 1; i >= 0; i--) {
        const b = burstParticles[i];
        b.x += b.vx * dtFactor;
        b.y += b.vy * dtFactor;
        b.vx *= 0.94;
        b.vy *= 0.94;
        b.life -= dtFactor;
        if (b.life <= 0) {
          burstParticles.splice(i, 1);
          continue;
        }
        const lifeRatio = b.life / b.maxLife;
        const alpha = lifeRatio * 0.7;

        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${b.color}, ${alpha * 0.1})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size * lifeRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${b.color}, ${alpha})`;
        ctx.fill();
      }

      // ── 4. Draw the cursor itself ──────────────────────────────────────────
      if (mouseInside) {
        const pulse = theme.pulsing ? 1 + 0.15 * Math.sin(globalTime * 0.006) : 1;
        const ragePulse = intensity > 0.8 ? 1 + 0.1 * Math.sin(globalTime * 0.012) : 1;
        const combinedPulse = pulse * ragePulse;

        // Click squeeze
        const clickScale = mouseDown ? 0.7 : 1;

        // Outer glow halo
        const glowRadius = theme.glowSize * combinedPulse * (0.6 + intensity * 0.6);
        const glowGrad = ctx.createRadialGradient(mouseX, mouseY, 0, mouseX, mouseY, glowRadius);
        glowGrad.addColorStop(0, `rgba(${theme.primary}, ${0.15 + intensity * 0.2})`);
        glowGrad.addColorStop(0.4, `rgba(${theme.primary}, ${0.05 + intensity * 0.08})`);
        glowGrad.addColorStop(1, `rgba(${theme.primary}, 0)`);
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(mouseX, mouseY, glowRadius, 0, Math.PI * 2);
        ctx.fill();

        // Outer ring
        const ringRadius = theme.ringSize * combinedPulse * clickScale;
        ctx.beginPath();
        ctx.arc(mouseX, mouseY, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${theme.primary}, ${0.4 + intensity * 0.3})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Inner ring (accent color) — only at higher intensities
        if (intensity > 0.3) {
          ctx.beginPath();
          ctx.arc(mouseX, mouseY, ringRadius * 0.7, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${theme.accent}, ${0.2 + intensity * 0.3})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Rage spikes — at high chaos, draw jagged spikes around cursor
        if (chaos > 0.5) {
          const spikeCount = 4 + Math.floor(chaos * 6);
          const spikeLength = ringRadius * (0.8 + chaos * 0.6);
          ctx.strokeStyle = `rgba(${theme.secondary}, ${0.3 + chaos * 0.3})`;
          ctx.lineWidth = 1 + chaos;
          for (let i = 0; i < spikeCount; i++) {
            const angle = (i / spikeCount) * Math.PI * 2 + globalTime * 0.001 * (chaos > 0.7 ? 1 : 0.3);
            const jitterAngle = angle + (Math.random() - 0.5) * chaos * 0.3;
            const innerR = ringRadius * 0.9;
            const outerR = ringRadius + spikeLength * (0.5 + Math.random() * 0.5);
            ctx.beginPath();
            ctx.moveTo(mouseX + Math.cos(jitterAngle) * innerR, mouseY + Math.sin(jitterAngle) * innerR);
            ctx.lineTo(mouseX + Math.cos(jitterAngle) * outerR, mouseY + Math.sin(jitterAngle) * outerR);
            ctx.stroke();
          }
        }

        // Core dot
        const coreRadius = theme.coreSize * combinedPulse * clickScale;
        ctx.beginPath();
        ctx.arc(mouseX, mouseY, coreRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${theme.accent}, ${0.9})`;
        ctx.fill();

        // Core inner highlight
        ctx.beginPath();
        ctx.arc(mouseX, mouseY, coreRadius * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.8})`;
        ctx.fill();

        // Crosshair lines at high intensity (rage mode)
        if (intensity > 0.7) {
          const crossSize = ringRadius * 1.5;
          const crossAlpha = (intensity - 0.7) * 1.5;
          ctx.strokeStyle = `rgba(${theme.primary}, ${crossAlpha * 0.4})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mouseX - crossSize, mouseY);
          ctx.lineTo(mouseX - ringRadius - 4, mouseY);
          ctx.moveTo(mouseX + ringRadius + 4, mouseY);
          ctx.lineTo(mouseX + crossSize, mouseY);
          ctx.moveTo(mouseX, mouseY - crossSize);
          ctx.lineTo(mouseX, mouseY - ringRadius - 4);
          ctx.moveTo(mouseX, mouseY + ringRadius + 4);
          ctx.lineTo(mouseX, mouseY + crossSize);
          ctx.stroke();
        }
      }

      animationFrameId = requestAnimationFrame(render);
    }

    lastTime = performance.now();
    animationFrameId = requestAnimationFrame(render);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('mouseenter', onMouseEnter);
      window.removeEventListener('easter-egg-particles', onEasterEggParticles);
    };
  }, []);

  return createPortal(
    <canvas
      ref={canvasRef}
      className="rage-cursor-canvas fixed inset-0 z-[2147483647] pointer-events-none"
      style={{ display: 'block' }}
    />,
    document.body,
  );
}
