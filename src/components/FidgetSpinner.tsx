import React, { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { playSfx } from "../lib/sfx";

const FRICTION = 0.97;
const MIN_VELOCITY = 0.05;
const MAX_SPEED = 80;
const PARTICLE_SPAWN_THRESHOLD = 15;
const MAX_PARTICLES = 15;
const CLICK_WINDOW_MS = 300;
const BOOST_DECAY_MS = 1000;
const MAX_BOOST_MULTIPLIER = 2.5;
const CHARGE_MAX_MS = 3000;
const SECONDARY_DAMP_INTERVAL_MS = 50;
const SECONDARY_DAMP_FACTOR = 0.995;
const CONFETTI_PER_1000 = 60;
const CONFETTI_PER_10000 = 120;
const CONFETTI_LIFETIME_MS = 3000;

const CONFETTI_COLORS = [
  "#f472b6", "#fbbf24", "#34d399", "#60a5fa",
  "#a78bfa", "#fb923c", "#f87171", "#2dd4bf",
  "#facc15", "#e879f9",
];

type ConfettiPiece = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  vr: number;
  color: string;
  size: number;
  shape: "rect" | "circle";
  born: number;
};

type Particle = {
  id: number;
  angle: number;
  distance: number;
  life: number; // 0..1, 1 = just spawned
  size: number;
  hue: number;
};

type FidgetSpinnerProps = {
  size?: number;
  className?: string;
  showSpinCount?: boolean;
};

export function FidgetSpinner({ size = 80, className = "", showSpinCount = true }: FidgetSpinnerProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rotationRef = useRef(0);
  const velocityRef = useRef(0);
  const totalRotationRef = useRef(0);
  const lockedRef = useRef(false);
  const lockedVelocityRef = useRef(0);
  const draggingRef = useRef(false);
  const dragHappenedRef = useRef(false);
  const centerInteractionRef = useRef(false);
  const lastDragAngleRef = useRef(0);
  const dragStartAngleRef = useRef(0);
  const boostMultiplierRef = useRef(1.0);
  const boostDecayStartRef = useRef<number | null>(null);
  const chargeStartRef = useRef<number | null>(null);
  const clickCountRef = useRef(0);
  const lastClickTimeRef = useRef(0);
  const particleIdRef = useRef(0);
  const secondaryDampAccumRef = useRef(0);

  // React state for rendering
  const [rotation, setRotation] = useState(0);
  const [velocity, setVelocity] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [isFast, setIsFast] = useState(false);
  const [isBoosted, setIsBoosted] = useState(false);
  const [boostFlash, setBoostFlash] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isCharging, setIsCharging] = useState(false);
  const [chargeProgress, setChargeProgress] = useState(0);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [totalSpins, setTotalSpins] = useState(0);
  const [spinTick, setSpinTick] = useState(0); // increments on each new full rotation
  const lastSpinCountRef = useRef(0);
  const persistTimerRef = useRef<number | null>(null);
  const lastMilestoneRef = useRef(0); // last 1000-boundary we celebrated
  const lastBigMilestoneRef = useRef(0); // last 10000-boundary we celebrated
  const confettiIdRef = useRef(0);
  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);

  const boostFlashTimerRef = useRef<number | null>(null);

  // Load persisted spin count
  useEffect(() => {
    const saved = localStorage.getItem("fidget-total-spins");
    if (saved) {
      const parsed = parseInt(saved, 10) || 0;
      setTotalSpins(parsed);
      lastSpinCountRef.current = parsed;
      totalRotationRef.current = parsed * 360;
    }
  }, []);

  // Persist spin count periodically (less frequent than UI updates)
  useEffect(() => {
    persistTimerRef.current = window.setInterval(() => {
      const spins = Math.floor(Math.abs(totalRotationRef.current) / 360);
      localStorage.setItem("fidget-total-spins", String(spins));
    }, 3000);
    return () => {
      if (persistTimerRef.current) clearInterval(persistTimerRef.current);
    };
  }, []);

  const getPointerAngle = useCallback((clientX: number, clientY: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    return Math.atan2(dy, dx) * (180 / Math.PI);
  }, []);

  const angleDelta = (a: number, b: number): number => {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  };

  // Main animation loop
  useEffect(() => {
    let rafId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;

      const vel = velocityRef.current;
      const locked = lockedRef.current;

      if (!locked && !draggingRef.current) {
        if (Math.abs(vel) < MIN_VELOCITY) {
          if (vel !== 0) {
            velocityRef.current = 0;
            setVelocity(0);
            setIsSpinning(false);
            setIsFast(false);
          }
        } else {
          // Apply friction
          velocityRef.current = vel * FRICTION;

          // Secondary damping
          secondaryDampAccumRef.current += dt;
          if (secondaryDampAccumRef.current >= SECONDARY_DAMP_INTERVAL_MS) {
            velocityRef.current *= SECONDARY_DAMP_FACTOR;
            secondaryDampAccumRef.current = 0;
          }

          // Integrate
          rotationRef.current += velocityRef.current;
          totalRotationRef.current += velocityRef.current;

          const v = velocityRef.current;
          setRotation(rotationRef.current);
          setVelocity(v);
          setIsSpinning(Math.abs(v) >= MIN_VELOCITY);
          setIsFast(Math.abs(v) > 30);
        }
      } else if (locked) {
        // Locked mode: constant speed, no friction
        rotationRef.current += lockedVelocityRef.current;
        totalRotationRef.current += lockedVelocityRef.current;
        setRotation(rotationRef.current);
        setVelocity(lockedVelocityRef.current);
        setIsSpinning(true);
        setIsFast(Math.abs(lockedVelocityRef.current) > 30);
      }

      // Boost multiplier decay
      if (boostMultiplierRef.current > 1.0) {
        if (boostDecayStartRef.current === null) {
          boostDecayStartRef.current = now;
        }
        const elapsed = now - boostDecayStartRef.current;
        const progress = Math.min(1, elapsed / BOOST_DECAY_MS);
        boostMultiplierRef.current = 1.0 + (MAX_BOOST_MULTIPLIER - 1.0) * (1 - progress);
        if (progress >= 1) {
          boostMultiplierRef.current = 1.0;
          boostDecayStartRef.current = null;
          setIsBoosted(false);
        }
        setIsBoosted(boostMultiplierRef.current > 1.2);
      }

      // Live spin count update — every frame while spinning
      const currentSpins = Math.floor(Math.abs(totalRotationRef.current) / 360);
      if (currentSpins !== lastSpinCountRef.current) {
        lastSpinCountRef.current = currentSpins;
        setTotalSpins(currentSpins);
        setSpinTick((t) => t + 1); // trigger FX pulse

        // Confetti milestones
        const milestone = Math.floor(currentSpins / 1000) * 1000;
        const bigMilestone = Math.floor(currentSpins / 10000) * 10000;

        if (bigMilestone > lastBigMilestoneRef.current && bigMilestone > 0) {
          // All corners — big celebration
          lastBigMilestoneRef.current = bigMilestone;
          lastMilestoneRef.current = milestone; // don't double-fire the 1000
          fireConfetti("all", CONFETTI_PER_10000);
        } else if (milestone > lastMilestoneRef.current && milestone > 0) {
          // Bottom corners only
          lastMilestoneRef.current = milestone;
          fireConfetti("bottom", CONFETTI_PER_1000);
        }
      }

      // Particle spawning
      const currentVel = locked ? lockedVelocityRef.current : velocityRef.current;
      if (Math.abs(currentVel) > PARTICLE_SPAWN_THRESHOLD && !draggingRef.current) {
        if (Math.random() < 0.3) {
          setParticles((prev) => {
            if (prev.length >= MAX_PARTICLES) return prev;
            const newParticle: Particle = {
              id: particleIdRef.current++,
              angle: Math.random() * 360,
              distance: 90 + Math.random() * 30,
              life: 1,
              size: 2 + Math.random() * 3,
              hue: Math.random() * 60 + 160, // teal-ish range
            };
            return [...prev, newParticle];
          });
        }
      }

      // Update particles
      setParticles((prev) =>
        prev
          .map((p) => ({ ...p, life: p.life - dt / 900 }))
          .filter((p) => p.life > 0)
      );

      // Charge progress
      if (chargeStartRef.current !== null) {
        const chargeElapsed = now - chargeStartRef.current;
        setChargeProgress(Math.min(1, chargeElapsed / CHARGE_MAX_MS));
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Cleanup boost flash timer
  useEffect(() => {
    return () => {
      if (boostFlashTimerRef.current) clearTimeout(boostFlashTimerRef.current);
    };
  }, []);

  // --- Interaction handlers ---

  const handleBodyPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    // Ctrl+click toggles lock if moving, or starts auto-spin if idle
    if (e.ctrlKey || e.metaKey) {
      if (lockedRef.current) {
        lockedRef.current = false;
        velocityRef.current = lockedVelocityRef.current;
        setIsLocked(false);
      } else if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
        lockedRef.current = true;
        lockedVelocityRef.current = velocityRef.current;
        setIsLocked(true);
      }
      return;
    }

    // Start drag — break any active lock
    if (lockedRef.current) {
      lockedRef.current = false;
      setIsLocked(false);
    }
    draggingRef.current = true;
    dragHappenedRef.current = false;
    setIsDragging(true);
    velocityRef.current = 0;
    setVelocity(0);
    playSfx('fidget_spin');
    const angle = getPointerAngle(e.clientX, e.clientY);
    lastDragAngleRef.current = angle;
    dragStartAngleRef.current = angle;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleBodyPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    dragHappenedRef.current = true;
    const angle = getPointerAngle(e.clientX, e.clientY);
    const delta = angleDelta(lastDragAngleRef.current, angle);
    rotationRef.current += delta;
    totalRotationRef.current += delta;
    velocityRef.current = delta;
    lastDragAngleRef.current = angle;
    setRotation(rotationRef.current);
  };

  const handleBodyPointerUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    const v = velocityRef.current;
    // Clamp velocity
    const clamped = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
    velocityRef.current = clamped;
    setVelocity(clamped);
    setIsSpinning(Math.abs(clamped) >= MIN_VELOCITY);
  };

  const handleBodyClick = (e: React.MouseEvent) => {
    // Ignore if this was a drag release
    if (dragHappenedRef.current) {
      dragHappenedRef.current = false;
      return;
    }
    // Ignore if the click originated from the center hub
    if (centerInteractionRef.current) {
      centerInteractionRef.current = false;
      return;
    }

    const now = Date.now();
    if (now - lastClickTimeRef.current < CLICK_WINDOW_MS) {
      clickCountRef.current++;
    } else {
      clickCountRef.current = 1;
    }
    lastClickTimeRef.current = now;

    const clickNum = clickCountRef.current;
    let boostAmount = 15;
    if (clickNum === 2) boostAmount = 30;
    else if (clickNum >= 3) boostAmount = 60;

    // Direction: preserve current direction, default CW
    let dir = 1;
    if (velocityRef.current < 0) dir = -1;
    else if (velocityRef.current > 0) dir = 1;

    // If locked, unlock first
    if (lockedRef.current) {
      lockedRef.current = false;
      setIsLocked(false);
    }

    velocityRef.current = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocityRef.current + boostAmount * dir));
    setVelocity(velocityRef.current);
    setIsSpinning(true);

    // Boost multiplier
    const boostLevel = Math.min(MAX_BOOST_MULTIPLIER, 1.0 + clickNum * 0.5);
    boostMultiplierRef.current = boostLevel;
    boostDecayStartRef.current = null;
    setIsBoosted(boostLevel > 1.2);

    // Boost flash
    setBoostFlash(true);
    if (boostFlashTimerRef.current) clearTimeout(boostFlashTimerRef.current);
    boostFlashTimerRef.current = window.setTimeout(() => setBoostFlash(false), 200);
  };

  const handleCenterPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Ctrl+click center: toggle auto-spin at medium rate
    if (e.ctrlKey || e.metaKey) {
      centerInteractionRef.current = true;
      if (lockedRef.current) {
        // Already locked (including auto-spin) — unlock
        lockedRef.current = false;
        velocityRef.current = lockedVelocityRef.current;
        setIsLocked(false);
      } else {
        // Enter auto-spin lock at medium speed
        const dir = velocityRef.current < 0 ? -1 : 1;
        lockedRef.current = true;
        lockedVelocityRef.current = 75 * dir;
        velocityRef.current = lockedVelocityRef.current;
        setVelocity(lockedVelocityRef.current);
        setIsLocked(true);
        setIsSpinning(true);
      }
      return;
    }

    centerInteractionRef.current = true;
  };

  const handleCenterPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();

    // Ctrl+click was handled in pointer down
    if (e.ctrlKey || e.metaKey) return;

    // Each center click adds velocity — start spinning or spin faster
    if (lockedRef.current) {
      lockedRef.current = false;
      setIsLocked(false);
    }

    const dir = velocityRef.current < 0 ? -1 : 1;
    const boostAmount = Math.abs(velocityRef.current) < MIN_VELOCITY ? 20 : 25;
    velocityRef.current = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocityRef.current + boostAmount * dir));
    setVelocity(velocityRef.current);
    setIsSpinning(true);

    // Boost multiplier
    boostMultiplierRef.current = Math.min(MAX_BOOST_MULTIPLIER, 1.5);
    boostDecayStartRef.current = null;
    setIsBoosted(true);

    // Boost flash
    setBoostFlash(true);
    if (boostFlashTimerRef.current) clearTimeout(boostFlashTimerRef.current);
    boostFlashTimerRef.current = window.setTimeout(() => setBoostFlash(false), 200);
  };

  // --- Confetti ---

  const fireConfetti = useCallback((corners: "bottom" | "all", count: number) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cornerPoints: { x: number; y: number; angle: number }[] = [];

    if (corners === "all") {
      // All four corners, shooting toward center
      cornerPoints.push({ x: 0, y: h, angle: -45 });       // bottom-left
      cornerPoints.push({ x: w, y: h, angle: -135 });      // bottom-right
      cornerPoints.push({ x: 0, y: 0, angle: 45 });        // top-left
      cornerPoints.push({ x: w, y: 0, angle: 135 });       // top-right
    } else {
      cornerPoints.push({ x: 0, y: h, angle: -45 });       // bottom-left
      cornerPoints.push({ x: w, y: h, angle: -135 });      // bottom-right
    }

    const pieces: ConfettiPiece[] = [];
    const perCorner = Math.ceil(count / cornerPoints.length);
    for (const cp of cornerPoints) {
      for (let i = 0; i < perCorner; i++) {
        const spread = 60; // degrees of spread
        const a = ((cp.angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
        const speed = 8 + Math.random() * 12;
        pieces.push({
          id: confettiIdRef.current++,
          x: cp.x,
          y: cp.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          rotation: Math.random() * 360,
          vr: (Math.random() - 0.5) * 20,
          color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
          size: 6 + Math.random() * 8,
          shape: Math.random() > 0.5 ? "rect" : "circle",
          born: performance.now(),
        });
      }
    }
    setConfetti((prev) => [...prev, ...pieces]);
  }, []);

  // Confetti physics + cleanup
  useEffect(() => {
    if (confetti.length === 0) return;
    let rafId: number;
    const tick = () => {
      const now = performance.now();
      setConfetti((prev) =>
        prev
          .map((p) => ({
            ...p,
            x: p.x + p.vx,
            y: p.y + p.vy,
            vy: p.vy + 0.35, // gravity
            vx: p.vx * 0.99, // air resistance
            rotation: p.rotation + p.vr,
          }))
          .filter((p) => now - p.born < CONFETTI_LIFETIME_MS && p.y < window.innerHeight + 50)
      );
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [confetti.length > 0]);

  // --- Render ---

  const center = size / 2;
  const armRadius = size * 0.38;
  const hubRadius = size * 0.14;
  const armWidth = size * 0.07;

  const armPositions = [0, 120, 240].map((deg) => {
    const rad = ((deg + rotation) * Math.PI) / 180;
    return {
      x: center + Math.cos(rad) * armRadius,
      y: center + Math.sin(rad) * armRadius,
    };
  });

  const speed = Math.abs(velocity);
  const glowIntensity = Math.min(1, speed / MAX_SPEED);
  const glowColor = isLocked
    ? "rgba(251, 191, 36, " // amber for locked
    : isFast
    ? "rgba(244, 114, 182, " // pink for fast
    : "rgba(20, 184, 166, "; // teal for normal spin

  const glowSize = isSpinning ? 8 + glowIntensity * 20 : 0;
  const fastGlowSize = isFast ? 12 + glowIntensity * 28 : 0;

  const wobbleAnim = !isSpinning && !isDragging ? "fidget-wobble 3s ease-in-out infinite" : undefined;
  const boostRingRotation = rotation * 0.5;

  return (
    <div
      className={`relative flex items-center justify-center select-none ${className}`}
      style={{ width: size, height: size, overflow: "visible" }}
    >
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ touchAction: "none", cursor: isDragging ? "grabbing" : "grab", overflow: "visible" }}
      >
        <defs>
          <radialGradient id="fidget-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glowColor + "0.6)"} />
            <stop offset="100%" stopColor={glowColor + "0)"} />
          </radialGradient>
          <filter id="fidget-blur">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>

        {/* Glow circle */}
        {isSpinning && (
          <circle
            cx={center}
            cy={center}
            r={armRadius + armWidth + glowSize}
            fill="url(#fidget-glow)"
            opacity={0.5 + glowIntensity * 0.3}
            style={{
              animation: isFast ? "fidget-glow-pulse-fast 0.4s ease-in-out infinite" : "fidget-glow-pulse 1s ease-in-out infinite",
            }}
          />
        )}

        {/* Fast glow */}
        {isFast && (
          <circle
            cx={center}
            cy={center}
            r={armRadius + armWidth + fastGlowSize}
            fill="url(#fidget-glow)"
            opacity={0.3}
          />
        )}

        {/* Boost ring */}
        {isBoosted && (
          <g style={{ transformOrigin: `${center}px ${center}px`, transform: `rotate(${boostRingRotation}deg)` }}>
            <circle
              cx={center}
              cy={center}
              r={armRadius + armWidth + 6}
              fill="none"
              stroke="rgba(251, 146, 60, 0.6)"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          </g>
        )}

        {/* Boost flash */}
        {boostFlash && (
          <circle
            cx={center}
            cy={center}
            r={armRadius + armWidth + 10}
            fill="rgba(251, 146, 60, 0.3)"
          />
        )}

        {/* Particle trails */}
        {particles.map((p) => {
          const rad = (p.angle * Math.PI) / 180;
          const px = center + Math.cos(rad) * p.distance;
          const py = center + Math.sin(rad) * p.distance;
          return (
            <circle
              key={p.id}
              cx={px}
              cy={py}
              r={p.size * p.life}
              fill={`hsla(${p.hue}, 80%, 60%, ${p.life * 0.9})`}
              filter="url(#fidget-blur)"
            />
          );
        })}

        {/* Spinner body — 3 arms + connecting lines */}
        <g
          style={{
            transformOrigin: `${center}px ${center}px`,
            transform: `rotate(${rotation}deg)`,
            animation: wobbleAnim,
          }}
          onPointerDown={handleBodyPointerDown}
          onPointerMove={handleBodyPointerMove}
          onPointerUp={handleBodyPointerUp}
          onClick={handleBodyClick}
        >
          {/* Connecting lines between arms */}
          {armPositions.map((pos, i) => {
            const next = armPositions[(i + 1) % 3];
            return (
              <line
                key={`line-${i}`}
                x1={pos.x}
                y1={pos.y}
                x2={next.x}
                y2={next.y}
                stroke="rgba(100, 116, 139, 0.4)"
                strokeWidth={armWidth * 0.5}
                strokeLinecap="round"
              />
            );
          })}

          {/* Arms (circles at 0°, 120°, 240°) */}
          {armPositions.map((pos, i) => (
            <circle
              key={`arm-${i}`}
              cx={pos.x}
              cy={pos.y}
              r={armWidth}
              fill={isLocked ? "rgba(251, 191, 36, 0.9)" : "rgba(71, 85, 105, 0.9)"}
              stroke={isLocked ? "rgba(252, 211, 77, 0.6)" : "rgba(148, 163, 184, 0.5)"}
              strokeWidth={1.5}
            />
          ))}

          {/* Center hub — separate interaction zone */}
          <circle
            cx={center}
            cy={center}
            r={hubRadius}
            fill={isCharging ? `rgba(251, 146, 60, ${0.4 + chargeProgress * 0.5})` : "rgba(51, 65, 85, 0.95)"}
            stroke={isLocked ? "rgba(252, 211, 77, 0.8)" : "rgba(148, 163, 184, 0.6)"}
            strokeWidth={2}
            onPointerDown={handleCenterPointerDown}
            onPointerUp={handleCenterPointerUp}
            style={{ cursor: "pointer" }}
          />

          {/* Charge progress ring */}
          {isCharging && (
            <circle
              cx={center}
              cy={center}
              r={hubRadius + 3}
              fill="none"
              stroke="rgba(251, 146, 60, 0.8)"
              strokeWidth={2}
              strokeDasharray={`${2 * Math.PI * (hubRadius + 3) * chargeProgress} ${2 * Math.PI * (hubRadius + 3)}`}
              transform={`rotate(-90 ${center} ${center})`}
            />
          )}

          {/* Lock indicator */}
          {isLocked && (
            <circle
              cx={center}
              cy={center}
              r={hubRadius * 0.4}
              fill="rgba(252, 211, 77, 0.9)"
            />
          )}
        </g>
      </svg>

      {/* Spin count — live ticking with speed-reactive FX */}
      {showSpinCount && (
      <div
        key={spinTick}
        className="absolute pointer-events-none whitespace-nowrap font-mono font-bold transition-all"
        style={{
          bottom: `${size + size * 0.08}px`,
          fontSize: `${Math.max(12, Math.min(size * 0.12, 12 + size * 0.04 + speed * 0.12))}px`,
          color: isFast ? "rgba(244, 114, 182, 0.9)" : isSpinning ? "rgba(20, 184, 166, 0.9)" : "rgba(100, 116, 139, 0.7)",
          textShadow: isSpinning
            ? `0 0 ${4 + glowIntensity * 12}px ${isFast ? "rgba(244, 114, 182, 0.8)" : "rgba(20, 184, 166, 0.8)"}`
            : "none",
          animation: spinTick > 0 ? "fidget-spin-pop 0.3s ease-out" : undefined,
        }}
      >
        {totalSpins.toLocaleString()} spins
      </div>
      )}

      {/* Confetti — portaled to body so it covers the full viewport */}
      {confetti.length > 0 && createPortal(
        <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999, overflow: "hidden" }}>
          {confetti.map((p) => {
            const age = (performance.now() - p.born) / CONFETTI_LIFETIME_MS;
            const opacity = age > 0.7 ? Math.max(0, 1 - (age - 0.7) / 0.3) : 1;
            return (
              <div
                key={p.id}
                style={{
                  position: "absolute",
                  left: `${p.x}px`,
                  top: `${p.y}px`,
                  width: p.shape === "rect" ? `${p.size}px` : `${p.size}px`,
                  height: p.shape === "rect" ? `${p.size * 0.6}px` : `${p.size}px`,
                  background: p.color,
                  borderRadius: p.shape === "circle" ? "50%" : "2px",
                  transform: `rotate(${p.rotation}deg)`,
                  opacity,
                  willChange: "transform, opacity",
                }}
              />
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}
