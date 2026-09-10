import React, { useEffect, useRef } from 'react';

// ─── Corrupture™ Palette ────────────────────────────────────────────────────
// Obsidian, charred porcelain, blackened alloy, gold sutures, fracture-vein cyan.
const C = {
  obsidian: '10, 10, 15',
  porcelain: '26, 22, 18',
  alloy: '37, 32, 40',
  gold: '201, 161, 74',
  goldBright: '232, 196, 106',
  fracture: '95, 184, 212',
  void: '58, 42, 74',
};

function rand(min: number, max: number) { return min + Math.random() * (max - min); }

// ─── Minimal placeholder — full canvas implementation in Phase 7 ──────────────
// Renders a static obsidian gradient with subtle fracture-vein overlay.
export function CorruptureBackground() {
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

    interface Crack {
      points: { x: number; y: number }[];
      progress: number;
      speed: number;
      alpha: number;
      maxAlpha: number;
      children: Crack[];
      depth: number;
    }

    let cracks: Crack[] = [];
    let goldSutures: { x1: number; y1: number; x2: number; y2: number; alpha: number; life: number; maxLife: number }[] = [];
    let voidBlooms: { x: number; y: number; radius: number; alpha: number; phase: number }[] = [];
    let burstParticles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; radius: number }[] = [];
    let globalTime = 0;
    let lastTime = performance.now();

    function resize() {
      dpr = window.devicePixelRatio || 1;
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.scale(dpr, dpr);
    }

    function spawnCrack(startX?: number, startY?: number, angle?: number, depth = 0): Crack {
      const sx = startX ?? rand(0, width);
      const sy = startY ?? rand(0, height);
      const startAngle = angle ?? rand(0, Math.PI * 2);
      const points: { x: number; y: number }[] = [{ x: sx, y: sy }];
      let cx = sx, cy = sy, ca = startAngle;
      const segCount = 3 + Math.floor(rand(2, 5));
      for (let i = 0; i < segCount; i++) {
        const stepLen = 30 + rand(0, 80);
        ca += rand(-0.5, 0.5);
        cx += Math.cos(ca) * stepLen;
        cy += Math.sin(ca) * stepLen;
        points.push({ x: cx, y: cy });
      }
      return {
        points,
        progress: 0,
        speed: 0.002 + rand(0, 0.004),
        alpha: 0,
        maxAlpha: 0.15 + rand(0, 0.15),
        children: [],
        depth,
      };
    }

    function initCracks() {
      cracks = [];
      // Asymmetrical — favor one diagonal
      const count = 3 + Math.floor(rand(0, 3));
      for (let i = 0; i < count; i++) {
        const bias = Math.random() > 0.5 ? 0.2 : -0.2;
        cracks.push(spawnCrack(rand(0, width), rand(0, height), rand(0, Math.PI * 2) + bias));
      }
    }

    function initVoidBlooms() {
      voidBlooms = [];
      for (let i = 0; i < 4; i++) {
        voidBlooms.push({
          x: rand(0, width),
          y: rand(0, height),
          radius: 120 + rand(0, 200),
          alpha: 0.015 + rand(0, 0.02),
          phase: rand(0, Math.PI * 2),
        });
      }
    }

    function onForgePulse(e: Event) {
      const detail = (e as CustomEvent).detail;
      const cx = detail?.x ?? width / 2;
      const cy = detail?.y ?? height / 2;
      // Gold/cyan particles along a fracture line (not radial)
      const angle = rand(0, Math.PI * 2);
      for (let i = 0; i < 12; i++) {
        const spread = rand(-0.3, 0.3);
        const speed = 1 + rand(0, 3);
        burstParticles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle + spread) * speed,
          vy: Math.sin(angle + spread) * speed,
          life: 50 + rand(0, 30),
          maxLife: 70,
          color: Math.random() < 0.5 ? C.gold : C.fracture,
          radius: 1 + rand(0, 2),
        });
      }
      // Spawn a new crack from the pulse point
      if (cracks.length < 8) {
        cracks.push(spawnCrack(cx, cy, rand(0, Math.PI * 2)));
      }
      // Spawn a gold suture
      goldSutures.push({
        x1: cx, y1: cy,
        x2: cx + rand(-100, 100), y2: cy + rand(-100, 100),
        alpha: 0.4,
        life: 0,
        maxLife: 60 + rand(0, 40),
      });
    }

    function onChatActivity(_e: Event) {
      // Subtle: spawn occasional gold suture
      if (Math.random() < 0.3) {
        goldSutures.push({
          x1: rand(0, width), y1: rand(0, height),
          x2: rand(0, width), y2: rand(0, height),
          alpha: 0.2,
          life: 0,
          maxLife: 40 + rand(0, 30),
        });
      }
    }

    function onVisualCapture(_e: Event) {
      if (cracks.length < 8) {
        cracks.push(spawnCrack());
      }
    }

    window.addEventListener('bg-forge-pulse', onForgePulse as EventListener);
    window.addEventListener('bg-chat-activity', onChatActivity as EventListener);
    window.addEventListener('bg-visual-capture', onVisualCapture as EventListener);

    function render(now: number) {
      const dt = Math.min(33, now - lastTime);
      lastTime = now;
      globalTime += dt;
      const dtFactor = dt / 16.67;

      ctx.clearRect(0, 0, width, height);

      // ── 1. Obsidian base gradient ────────────────────────────────────────
      const grad = ctx.createRadialGradient(
        width * 0.4, height * 0.5, 50,
        width * 0.4, height * 0.5, Math.max(width, height) * 0.85
      );
      grad.addColorStop(0, `rgba(${C.porcelain}, 0.4)`);
      grad.addColorStop(0.3, `rgba(${C.obsidian}, 0.6)`);
      grad.addColorStop(0.7, '#070707');
      grad.addColorStop(1, '#050505');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // ── 2. Void blooms (dark violet, breathing) ──────────────────────────
      for (const bloom of voidBlooms) {
        const breathe = 0.6 + 0.4 * Math.sin(globalTime * 0.0002 + bloom.phase);
        const bg = ctx.createRadialGradient(bloom.x, bloom.y, 0, bloom.x, bloom.y, bloom.radius);
        bg.addColorStop(0, `rgba(${C.void}, ${bloom.alpha * breathe})`);
        bg.addColorStop(0.5, `rgba(${C.void}, ${bloom.alpha * breathe * 0.3})`);
        bg.addColorStop(1, `rgba(${C.void}, 0)`);
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(bloom.x, bloom.y, bloom.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── 3. Fracture-veins (luminous cracks) ───────────────────────────────
      for (let i = cracks.length - 1; i >= 0; i--) {
        const crack = cracks[i];
        if (!prefersReducedMotion) {
          crack.progress += crack.speed * dtFactor;
        }
        const lifeRatio = crack.progress;
        if (lifeRatio < 0.15) crack.alpha = (lifeRatio / 0.15) * crack.maxAlpha;
        else if (lifeRatio > 0.75) crack.alpha = ((1 - lifeRatio) / 0.25) * crack.maxAlpha;
        else crack.alpha = crack.maxAlpha;

        if (crack.progress >= 1) {
          // Spawn child crack occasionally
          if (crack.depth < 2 && cracks.length < 10 && Math.random() < 0.4) {
            const lastPt = crack.points[crack.points.length - 1];
            const lastAngle = Math.atan2(
              lastPt.y - crack.points[crack.points.length - 2].y,
              lastPt.x - crack.points[crack.points.length - 2].x,
            );
            cracks.push(spawnCrack(lastPt.x, lastPt.y, lastAngle + rand(-0.8, 0.8), crack.depth + 1));
          }
          if (crack.progress >= 1.2) {
            cracks.splice(i, 1);
            if (cracks.length < 3) cracks.push(spawnCrack());
          }
          continue;
        }

        // Draw the crack up to progress
        const totalSegs = crack.points.length - 1;
        const drawSegs = Math.ceil(totalSegs * crack.progress);
        if (drawSegs < 1) continue;

        // Glow
        ctx.beginPath();
        ctx.moveTo(crack.points[0].x, crack.points[0].y);
        for (let s = 1; s <= drawSegs && s < crack.points.length; s++) {
          ctx.lineTo(crack.points[s].x, crack.points[s].y);
        }
        ctx.strokeStyle = `rgba(${C.fracture}, ${crack.alpha * 0.15})`;
        ctx.lineWidth = 3;
        ctx.stroke();

        // Core line
        ctx.strokeStyle = `rgba(${C.fracture}, ${crack.alpha})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();

        // Leading point glow
        if (drawSegs > 0 && drawSegs < crack.points.length) {
          const lead = crack.points[Math.min(drawSegs, crack.points.length - 1)];
          ctx.beginPath();
          ctx.arc(lead.x, lead.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${C.fracture}, ${crack.alpha * 0.5})`;
          ctx.fill();
        }
      }

      // ── 4. Gold sutures (bright seam lines that appear and fade) ─────────
      for (let i = goldSutures.length - 1; i >= 0; i--) {
        const s = goldSutures[i];
        if (!prefersReducedMotion) s.life += dtFactor;
        const lifeRatio = s.life / s.maxLife;
        let alpha = s.alpha;
        if (lifeRatio < 0.2) alpha = s.alpha * (lifeRatio / 0.2);
        else if (lifeRatio > 0.7) alpha = s.alpha * ((1 - lifeRatio) / 0.3);

        if (s.life >= s.maxLife) {
          goldSutures.splice(i, 1);
          continue;
        }

        // Glow
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.strokeStyle = `rgba(${C.gold}, ${alpha * 0.2})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Core
        ctx.strokeStyle = `rgba(${C.goldBright}, ${alpha})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      // ── 5. Burst particles ───────────────────────────────────────────────
      for (let i = burstParticles.length - 1; i >= 0; i--) {
        const p = burstParticles[i];
        if (!prefersReducedMotion) {
          p.x += p.vx * dtFactor;
          p.y += p.vy * dtFactor;
          p.life += dtFactor;
        }
        if (p.life >= p.maxLife) {
          burstParticles.splice(i, 1);
          continue;
        }
        const lifeRatio = p.life / p.maxLife;
        const alpha = (1 - lifeRatio) * 0.8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${alpha})`;
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    }

    resize();
    initCracks();
    initVoidBlooms();
    window.addEventListener('resize', () => {
      resize();
      initCracks();
      initVoidBlooms();
    });

    if (prefersReducedMotion) {
      // Render a single static frame
      render(performance.now());
      cancelAnimationFrame(animationFrameId);
    } else {
      animationFrameId = requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('bg-forge-pulse', onForgePulse as EventListener);
      window.removeEventListener('bg-chat-activity', onChatActivity as EventListener);
      window.removeEventListener('bg-visual-capture', onVisualCapture as EventListener);
    };
  }, []);

  return (
    <div ref={containerRef} className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}
