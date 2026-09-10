import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { playSfx } from "../lib/sfx";
import { toast } from "sonner";

// ─── Physics constants ─────────────────────────────────────────────────────
const MIN_VELOCITY = 0.04;
const MAX_SPEED = 120;
const PARTICLE_SPAWN_THRESHOLD = 12;
const MAX_PARTICLES = 40;
const CLICK_WINDOW_MS = 300;
const BOOST_DECAY_MS = 1000;
const MAX_BOOST_MULTIPLIER = 2.5;
const CHARGE_MAX_MS = 3000;
const SECONDARY_DAMP_INTERVAL_MS = 50;
const SECONDARY_DAMP_FACTOR = 0.996;
const CONFETTI_LIFETIME_MS = 3500;

// Drag momentum buffer — track recent deltas for smooth throw velocity
const DRAG_BUFFER_SIZE = 5;
const DRAG_BUFFER_WINDOW_MS = 100;

// ─── Spinner type definitions ──────────────────────────────────────────────
export type SpinnerTier = {
  id: number;
  threshold: number;
  name: string;
  subtitle: string;
  // Color palette
  armColor: string;
  armStroke: string;
  glowR: number;
  glowG: number;
  glowB: number;
  // Arm design
  armCount: number;       // 2–6 arms
  armShape: "circle" | "blade" | "star" | "diamond" | "orbital";
  hubShape: "circle" | "hex" | "core";
  connectorStyle: "line" | "arc" | "none";
  // FX flags — each tier adds more
  particles: boolean;
  particleHueRange: [number, number];
  trails: boolean;
  aura: boolean;
  rings: boolean;
  lightning: boolean;
  accretion: boolean;
  prismatic: boolean;
  starfield: boolean;
  confettiColors: string[];
};

const TIERS: SpinnerTier[] = [
  {
    id: 0, threshold: 0, name: "Classic", subtitle: "Where it all begins",
    armColor: "rgba(71, 85, 105, 0.95)", armStroke: "rgba(148, 163, 184, 0.6)",
    glowR: 20, glowG: 184, glowB: 166,
    armCount: 3, armShape: "circle", hubShape: "circle", connectorStyle: "line",
    particles: true, particleHueRange: [160, 200], trails: false, aura: false, rings: false, lightning: false, accretion: false, prismatic: false, starfield: false,
    confettiColors: ["#f472b6", "#fbbf24", "#34d399", "#60a5fa", "#a78bfa"],
  },
  {
    id: 1, threshold: 1337, name: "Neon", subtitle: "Electric dreams",
    armColor: "rgba(99, 102, 241, 0.95)", armStroke: "rgba(165, 180, 252, 0.8)",
    glowR: 99, glowG: 102, glowB: 241,
    armCount: 3, armShape: "blade", hubShape: "circle", connectorStyle: "line",
    particles: true, particleHueRange: [220, 280], trails: true, aura: false, rings: false, lightning: false, accretion: false, prismatic: false, starfield: false,
    confettiColors: ["#818cf8", "#c084fc", "#22d3ee", "#a78bfa", "#6366f1"],
  },
  {
    id: 2, threshold: 5000, name: "Galaxy", subtitle: "Spiral into the cosmos",
    armColor: "rgba(168, 85, 247, 0.95)", armStroke: "rgba(216, 180, 254, 0.8)",
    glowR: 168, glowG: 85, glowB: 247,
    armCount: 4, armShape: "diamond", hubShape: "circle", connectorStyle: "arc",
    particles: true, particleHueRange: [260, 320], trails: true, aura: true, rings: false, lightning: false, accretion: false, prismatic: false, starfield: true,
    confettiColors: ["#c084fc", "#e879f9", "#f0abfc", "#d946ef", "#a855f7"],
  },
  {
    id: 3, threshold: 9001, name: "Over 9000", subtitle: "It's over NINE THOUSAND!",
    armColor: "rgba(251, 191, 36, 0.95)", armStroke: "rgba(253, 224, 71, 0.9)",
    glowR: 251, glowG: 191, glowB: 36,
    armCount: 3, armShape: "star", hubShape: "hex", connectorStyle: "line",
    particles: true, particleHueRange: [40, 60], trails: true, aura: true, rings: true, lightning: false, accretion: false, prismatic: false, starfield: false,
    confettiColors: ["#fbbf24", "#f59e0b", "#fde047", "#facc15", "#eab308"],
  },
  {
    id: 4, threshold: 25000, name: "Plasma", subtitle: "Pure energy",
    armColor: "rgba(56, 189, 248, 0.95)", armStroke: "rgba(125, 211, 252, 0.9)",
    glowR: 56, glowG: 189, glowB: 248,
    armCount: 5, armShape: "blade", hubShape: "core", connectorStyle: "arc",
    particles: true, particleHueRange: [180, 240], trails: true, aura: true, rings: true, lightning: true, accretion: false, prismatic: false, starfield: true,
    confettiColors: ["#38bdf8", "#0ea5e9", "#7dd3fc", "#06b6d4", "#22d3ee"],
  },
  {
    id: 5, threshold: 50000, name: "Cosmic", subtitle: "Bending space and time",
    armColor: "rgba(236, 72, 153, 0.95)", armStroke: "rgba(244, 114, 182, 0.9)",
    glowR: 236, glowG: 72, glowB: 153,
    armCount: 6, armShape: "orbital", hubShape: "core", connectorStyle: "none",
    particles: true, particleHueRange: [300, 360], trails: true, aura: true, rings: true, lightning: true, accretion: true, prismatic: false, starfield: true,
    confettiColors: ["#ec4899", "#f472b6", "#e879f9", "#d946ef", "#c026d3"],
  },
  {
    id: 6, threshold: 100000, name: "Singularity", subtitle: "Reality itself bends",
    armColor: "rgba(255, 255, 255, 0.95)", armStroke: "rgba(255, 255, 255, 0.9)",
    glowR: 255, glowG: 255, glowB: 255,
    armCount: 8, armShape: "orbital", hubShape: "core", connectorStyle: "none",
    particles: true, particleHueRange: [0, 360], trails: true, aura: true, rings: true, lightning: true, accretion: true, prismatic: true, starfield: true,
    confettiColors: ["#ff006e", "#fb5607", "#ffbe0b", "#8338ec", "#3a86ff", "#06ffa5", "#ff4081"],
  },
];

function getTierForSpins(spins: number): SpinnerTier {
  let tier = TIERS[0];
  for (const t of TIERS) {
    if (spins >= t.threshold) tier = t;
  }
  return tier;
}

function getNextTier(spins: number): SpinnerTier | null {
  for (const t of TIERS) {
    if (t.threshold > spins) return t;
  }
  return null;
}

// ─── Types ─────────────────────────────────────────────────────────────────
type ConfettiPiece = {
  id: number; x: number; y: number; vx: number; vy: number;
  rotation: number; vr: number; color: string; size: number;
  shape: "rect" | "circle" | "star"; born: number;
};

type Particle = {
  id: number; angle: number; distance: number; life: number;
  size: number; hue: number; drift: number;
};

type StarParticle = {
  id: number; angle: number; distance: number; size: number;
  twinkle: number; born: number;
};

type LightningArc = {
  id: number; angle: number; length: number; life: number;
  segments: { x: number; y: number }[];
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

  // Drag momentum buffer
  const dragBufferRef = useRef<{ delta: number; time: number }[]>([]);

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
  const [stars, setStars] = useState<StarParticle[]>([]);
  const [lightning, setLightning] = useState<LightningArc[]>([]);
  const [totalSpins, setTotalSpins] = useState(0);
  const [spinTick, setSpinTick] = useState(0);
  const lastSpinCountRef = useRef(0);
  const persistTimerRef = useRef<number | null>(null);
  const lastMilestoneRef = useRef(0);
  const lastBigMilestoneRef = useRef(0);
  const confettiIdRef = useRef(0);
  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);
  const boostFlashTimerRef = useRef<number | null>(null);
  const [unlockedTier, setUnlockedTier] = useState(0);
  const [unlockFlash, setUnlockFlash] = useState(false);
  const lastTierIdRef = useRef(0);
  const lightningIdRef = useRef(0);
  const starIdRef = useRef(0);
  // Refs mirroring stars/lightning lengths so the RAF loop closure stays fresh
  // without re-triggering the effect (which would thrash the animation at Galaxy+).
  const starsCountRef = useRef(0);
  const lightningCountRef = useRef(0);

  // Load persisted spin count
  useEffect(() => {
    const saved = localStorage.getItem("fidget-total-spins");
    if (saved) {
      const parsed = parseInt(saved, 10) || 0;
      setTotalSpins(parsed);
      lastSpinCountRef.current = parsed;
      totalRotationRef.current = parsed * 360;
      const tier = getTierForSpins(parsed);
      lastTierIdRef.current = tier.id;
      setUnlockedTier(tier.id);
    }
  }, []);

  // Persist spin count periodically
  useEffect(() => {
    persistTimerRef.current = window.setInterval(() => {
      const spins = Math.floor(Math.abs(totalRotationRef.current) / 360);
      localStorage.setItem("fidget-total-spins", String(spins));
    }, 3000);
    return () => {
      if (persistTimerRef.current) clearInterval(persistTimerRef.current);
    };
  }, []);

  // Current tier (memoized from totalSpins)
  const tier = useMemo(() => getTierForSpins(totalSpins), [totalSpins]);
  const nextTier = useMemo(() => getNextTier(totalSpins), [totalSpins]);

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

  // ─── Velocity-dependent friction ────────────────────────────────────────
  // Higher friction at very low speeds (natural settle), lower at high speeds
  // (feels like momentum/glide). This replaces the flat 0.97 constant.
  const computeFriction = (vel: number): number => {
    const absVel = Math.abs(vel);
    if (absVel < 1) return 0.92;       // quick settle near stop
    if (absVel < 5) return 0.96;      // moderate damping
    if (absVel < 20) return 0.982;    // smooth glide
    if (absVel < 50) return 0.988;    // fast spin coasts
    return 0.992;                     // very fast — minimal loss
  };

  // ─── Main animation loop ────────────────────────────────────────────────
  useEffect(() => {
    let rafId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(50, now - lastTime); // clamp dt to avoid jumps
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
          // Velocity-dependent friction
          const friction = computeFriction(vel);
          velocityRef.current = vel * friction;

          // Secondary damping (tiny extra decay)
          secondaryDampAccumRef.current += dt;
          if (secondaryDampAccumRef.current >= SECONDARY_DAMP_INTERVAL_MS) {
            velocityRef.current *= SECONDARY_DAMP_FACTOR;
            secondaryDampAccumRef.current = 0;
          }

          // Sub-stepping for high velocities (smooth rotation at high speed)
          const steps = Math.ceil(Math.abs(velocityRef.current) / 30);
          const stepVel = velocityRef.current / steps;
          for (let s = 0; s < steps; s++) {
            rotationRef.current += stepVel;
            totalRotationRef.current += stepVel;
          }

          const v = velocityRef.current;
          setRotation(rotationRef.current);
          setVelocity(v);
          setIsSpinning(Math.abs(v) >= MIN_VELOCITY);
          setIsFast(Math.abs(v) > 35);
        }
      } else if (locked) {
        rotationRef.current += lockedVelocityRef.current;
        totalRotationRef.current += lockedVelocityRef.current;
        setRotation(rotationRef.current);
        setVelocity(lockedVelocityRef.current);
        setIsSpinning(true);
        setIsFast(Math.abs(lockedVelocityRef.current) > 35);
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

      // Live spin count update
      const currentSpins = Math.floor(Math.abs(totalRotationRef.current) / 360);
      if (currentSpins !== lastSpinCountRef.current) {
        lastSpinCountRef.current = currentSpins;
        setTotalSpins(currentSpins);
        setSpinTick((t) => t + 1);

        // Tier unlock check
        const newTier = getTierForSpins(currentSpins);
        if (newTier.id > lastTierIdRef.current) {
          lastTierIdRef.current = newTier.id;
          setUnlockedTier(newTier.id);
          setUnlockFlash(true);
          setTimeout(() => setUnlockFlash(false), 1500);
          playSfx('hud_open');
          toast.success(`Spinner Unlocked: ${newTier.name}!`, {
            description: newTier.subtitle,
            duration: 5000,
          });
          // Mega confetti for unlock
          fireConfetti("all", 180, newTier.confettiColors);
        }

        // Confetti milestones
        const milestone = Math.floor(currentSpins / 1000) * 1000;
        const bigMilestone = Math.floor(currentSpins / 10000) * 10000;

        if (bigMilestone > lastBigMilestoneRef.current && bigMilestone > 0) {
          lastBigMilestoneRef.current = bigMilestone;
          lastMilestoneRef.current = milestone;
          fireConfetti("all", 120, tier.confettiColors);
        } else if (milestone > lastMilestoneRef.current && milestone > 0) {
          lastMilestoneRef.current = milestone;
          fireConfetti("bottom", 60, tier.confettiColors);
        }
      }

      // Particle spawning (tier-aware)
      const currentVel = locked ? lockedVelocityRef.current : velocityRef.current;
      const absVel = Math.abs(currentVel);
      if (absVel > PARTICLE_SPAWN_THRESHOLD && !draggingRef.current && tier.particles) {
        const spawnRate = Math.min(0.6, 0.2 + absVel / 200);
        if (Math.random() < spawnRate) {
          setParticles((prev) => {
            if (prev.length >= MAX_PARTICLES) return prev;
            const [hueMin, hueMax] = tier.particleHueRange;
            const newParticle: Particle = {
              id: particleIdRef.current++,
              angle: Math.random() * 360,
              distance: size * 0.42 + Math.random() * size * 0.15,
              life: 1,
              size: 1.5 + Math.random() * 3,
              hue: tier.prismatic ? Math.random() * 360 : hueMin + Math.random() * (hueMax - hueMin),
              drift: (Math.random() - 0.5) * 0.5,
            };
            return [...prev, newParticle];
          });
        }
      }

      // Update particles
      setParticles((prev) =>
        prev
          .map((p) => ({ ...p, life: p.life - dt / 900, angle: p.angle + p.drift, distance: p.distance + 0.3 }))
          .filter((p) => p.life > 0)
      );

      // Star field for galaxy+ tiers
      if (tier.starfield && starsCountRef.current < 25 && Math.random() < 0.15) {
        setStars((prev) => {
          const next = [...prev, {
            id: starIdRef.current++,
            angle: Math.random() * 360,
            distance: size * 0.2 + Math.random() * size * 0.3,
            size: 0.5 + Math.random() * 1.5,
            twinkle: Math.random() * Math.PI * 2,
            born: now,
          }].slice(-25);
          starsCountRef.current = next.length;
          return next;
        });
      }
      // Update stars (slow rotation + twinkle)
      if (starsCountRef.current > 0) {
        setStars((prev) => prev.map((s) => ({
          ...s,
          angle: s.angle + 0.15,
          twinkle: s.twinkle + 0.05,
        })));
      }

      // Lightning arcs for plasma+ tiers
      if (tier.lightning && absVel > 20 && Math.random() < 0.08 && lightningCountRef.current < 3) {
        const angle = Math.random() * 360;
        const segs: { x: number; y: number }[] = [];
        const arcLen = size * 0.35;
        const numSegs = 5;
        for (let i = 0; i <= numSegs; i++) {
          const t = i / numSegs;
          const r = t * arcLen;
          const jitter = (Math.random() - 0.5) * size * 0.08;
          const rad = ((angle + jitter) * Math.PI) / 180;
          segs.push({ x: Math.cos(rad) * r, y: Math.sin(rad) * r });
        }
        setLightning((prev) => {
          const next = [...prev, {
            id: lightningIdRef.current++,
            angle, length: arcLen, life: 1, segments: segs,
          }];
          lightningCountRef.current = next.length;
          return next;
        });
      }
      if (lightningCountRef.current > 0) {
        setLightning((prev) => {
          const next = prev.map((l) => ({ ...l, life: l.life - dt / 200 })).filter((l) => l.life > 0);
          lightningCountRef.current = next.length;
          return next;
        });
      }

      // Charge progress
      if (chargeStartRef.current !== null) {
        const chargeElapsed = now - chargeStartRef.current;
        setChargeProgress(Math.min(1, chargeElapsed / CHARGE_MAX_MS));
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [size, tier]);

  // Cleanup boost flash timer
  useEffect(() => {
    return () => {
      if (boostFlashTimerRef.current) clearTimeout(boostFlashTimerRef.current);
    };
  }, []);

  // ─── Interaction handlers ───────────────────────────────────────────────

  const handleBodyPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;

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

    if (lockedRef.current) {
      lockedRef.current = false;
      setIsLocked(false);
    }
    draggingRef.current = true;
    dragHappenedRef.current = false;
    setIsDragging(true);
    velocityRef.current = 0;
    setVelocity(0);
    dragBufferRef.current = [];
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

    // Push to drag buffer for momentum calculation
    const now = performance.now();
    dragBufferRef.current.push({ delta, time: now });
    // Trim old entries
    dragBufferRef.current = dragBufferRef.current.filter(
      (d) => now - d.time < DRAG_BUFFER_WINDOW_MS
    );
    if (dragBufferRef.current.length > DRAG_BUFFER_SIZE) {
      dragBufferRef.current = dragBufferRef.current.slice(-DRAG_BUFFER_SIZE);
    }
  };

  const handleBodyPointerUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);

    // Compute throw velocity from drag buffer (weighted average, recent = heavier)
    const buffer = dragBufferRef.current;
    if (buffer.length >= 2) {
      let totalDelta = 0;
      let totalWeight = 0;
      const now = performance.now();
      for (let i = 0; i < buffer.length; i++) {
        const age = now - buffer[i].time;
        const weight = Math.max(0.1, 1 - age / DRAG_BUFFER_WINDOW_MS);
        totalDelta += buffer[i].delta * weight;
        totalWeight += weight;
      }
      const avgVel = totalWeight > 0 ? totalDelta / totalWeight : 0;
      // Amplify slightly for a satisfying throw
      velocityRef.current = avgVel * 1.3;
    }

    const clamped = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocityRef.current));
    velocityRef.current = clamped;
    setVelocity(clamped);
    setIsSpinning(Math.abs(clamped) >= MIN_VELOCITY);
    dragBufferRef.current = [];
  };

  const handleBodyClick = (e: React.MouseEvent) => {
    if (dragHappenedRef.current) {
      dragHappenedRef.current = false;
      return;
    }
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
    let boostAmount = 18;
    if (clickNum === 2) boostAmount = 35;
    else if (clickNum >= 3) boostAmount = 70;

    let dir = 1;
    if (velocityRef.current < 0) dir = -1;
    else if (velocityRef.current > 0) dir = 1;

    if (lockedRef.current) {
      lockedRef.current = false;
      setIsLocked(false);
    }

    velocityRef.current = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocityRef.current + boostAmount * dir));
    setVelocity(velocityRef.current);
    setIsSpinning(true);

    const boostLevel = Math.min(MAX_BOOST_MULTIPLIER, 1.0 + clickNum * 0.5);
    boostMultiplierRef.current = boostLevel;
    boostDecayStartRef.current = null;
    setIsBoosted(boostLevel > 1.2);

    setBoostFlash(true);
    if (boostFlashTimerRef.current) clearTimeout(boostFlashTimerRef.current);
    boostFlashTimerRef.current = window.setTimeout(() => setBoostFlash(false), 200);
  };

  const handleCenterPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
      centerInteractionRef.current = true;
      if (lockedRef.current) {
        lockedRef.current = false;
        velocityRef.current = lockedVelocityRef.current;
        setIsLocked(false);
      } else {
        const dir = velocityRef.current < 0 ? -1 : 1;
        lockedRef.current = true;
        lockedVelocityRef.current = 90 * dir;
        velocityRef.current = lockedVelocityRef.current;
        setVelocity(lockedVelocityRef.current);
        setIsLocked(true);
        setIsSpinning(true);
      }
      return;
    }

    centerInteractionRef.current = true;
    chargeStartRef.current = performance.now();
    setIsCharging(true);
  };

  const handleCenterPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) return;

    // Release charge — power proportional to hold duration
    if (lockedRef.current) {
      lockedRef.current = false;
      setIsLocked(false);
    }

    const chargeElapsed = chargeStartRef.current ? performance.now() - chargeStartRef.current : 0;
    chargeStartRef.current = null;
    setIsCharging(false);

    const chargePower = Math.min(1, chargeElapsed / CHARGE_MAX_MS);
    const dir = velocityRef.current < 0 ? -1 : 1;
    const boostAmount = 20 + chargePower * 80; // 20–100 based on charge
    velocityRef.current = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, velocityRef.current + boostAmount * dir));
    setVelocity(velocityRef.current);
    setIsSpinning(true);

    boostMultiplierRef.current = Math.min(MAX_BOOST_MULTIPLIER, 1.5 + chargePower);
    boostDecayStartRef.current = null;
    setIsBoosted(true);

    setBoostFlash(true);
    if (boostFlashTimerRef.current) clearTimeout(boostFlashTimerRef.current);
    boostFlashTimerRef.current = window.setTimeout(() => setBoostFlash(false), 200);
  };

  // ─── Confetti ───────────────────────────────────────────────────────────

  const fireConfetti = useCallback((corners: "bottom" | "all", count: number, colors?: string[]) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const palette = colors || tier.confettiColors;
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

    const pieces: ConfettiPiece[] = [];
    const perCorner = Math.ceil(count / cornerPoints.length);
    for (const cp of cornerPoints) {
      for (let i = 0; i < perCorner; i++) {
        const spread = 70;
        const a = ((cp.angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
        const speed = 8 + Math.random() * 14;
        pieces.push({
          id: confettiIdRef.current++,
          x: cp.x, y: cp.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          rotation: Math.random() * 360,
          vr: (Math.random() - 0.5) * 25,
          color: palette[Math.floor(Math.random() * palette.length)],
          size: 5 + Math.random() * 9,
          shape: Math.random() > 0.7 ? "star" : Math.random() > 0.5 ? "rect" : "circle",
          born: performance.now(),
        });
      }
    }
    setConfetti((prev) => [...prev, ...pieces]);
  }, [tier]);

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
            vy: p.vy + 0.35,
            vx: p.vx * 0.99,
            rotation: p.rotation + p.vr,
          }))
          .filter((p) => now - p.born < CONFETTI_LIFETIME_MS && p.y < window.innerHeight + 50)
      );
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [confetti.length > 0]);

  // ─── Render ─────────────────────────────────────────────────────────────

  const center = size / 2;
  const armRadius = size * 0.38;
  const hubRadius = size * 0.14;
  const armWidth = size * 0.07;

  // Arm positions driven by tier arm count
  const armAngles = useMemo(() => {
    const count = tier.armCount;
    return Array.from({ length: count }, (_, i) => (360 / count) * i);
  }, [tier.armCount]);

  const armPositions = armAngles.map((deg) => {
    const rad = ((deg + rotation) * Math.PI) / 180;
    return {
      x: center + Math.cos(rad) * armRadius,
      y: center + Math.sin(rad) * armRadius,
      angle: deg,
    };
  });

  const speed = Math.abs(velocity);
  const glowIntensity = Math.min(1, speed / MAX_SPEED);
  const glowColor = isLocked
    ? `rgba(251, 191, 36, `
    : isFast
    ? `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, `
    : `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, `;

  const glowSize = isSpinning ? 8 + glowIntensity * 24 : 0;
  const fastGlowSize = isFast ? 12 + glowIntensity * 32 : 0;
  const wobbleAnim = !isSpinning && !isDragging ? "fidget-wobble 3s ease-in-out infinite" : undefined;
  const boostRingRotation = rotation * 0.5;

  // Gradient IDs (unique per instance to avoid SVG conflicts)
  const gid = `fs-${size}-${tier.id}`;

  return (
    <div
      className={`relative flex items-center justify-center select-none ${className}`}
      style={{ width: size, height: size, overflow: "visible" }}
    >
      {/* Unlock flash overlay */}
      {unlockFlash && (
        <div
          className="absolute inset-0 pointer-events-none rounded-full"
          style={{
            boxShadow: `0 0 ${size * 0.5}px ${size * 0.1}px rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.8)`,
            animation: "fidget-unlock-flash 1.5s ease-out forwards",
          }}
        />
      )}

      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ touchAction: "none", cursor: isDragging ? "grabbing" : "grab", overflow: "visible" }}
      >
        <defs>
          <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glowColor + "0.7)"} />
            <stop offset="60%" stopColor={glowColor + "0.2)"} />
            <stop offset="100%" stopColor={glowColor + "0)"} />
          </radialGradient>
          <radialGradient id={`${gid}-arm`} cx="30%" cy="30%" r="70%">
            <stop offset="0%" stopColor={tier.armColor.replace(/[\d.]+\)$/, "1)")} />
            <stop offset="100%" stopColor={tier.armColor} />
          </radialGradient>
          <radialGradient id={`${gid}-hub`} cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="rgba(100, 116, 139, 1)" />
            <stop offset="100%" stopColor="rgba(30, 41, 59, 0.95)" />
          </radialGradient>
          <filter id={`${gid}-blur`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={tier.id >= 3 ? 3 : 2} />
          </filter>
          <filter id={`${gid}-glow-filter`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={4 + glowIntensity * 6} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="prismatic-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ff006e" />
            <stop offset="16%" stopColor="#fb5607" />
            <stop offset="33%" stopColor="#ffbe0b" />
            <stop offset="50%" stopColor="#06ffa5" />
            <stop offset="66%" stopColor="#3a86ff" />
            <stop offset="83%" stopColor="#8338ec" />
            <stop offset="100%" stopColor="#ff006e" />
          </linearGradient>
        </defs>

        {/* ─── Star field (Galaxy+) ─────────────────────────────────── */}
        {tier.starfield && stars.map((s) => {
          const rad = (s.angle * Math.PI) / 180;
          const sx = center + Math.cos(rad) * s.distance;
          const sy = center + Math.sin(rad) * s.distance;
          const twinkleOpacity = 0.3 + Math.abs(Math.sin(s.twinkle)) * 0.7;
          return (
            <circle
              key={s.id}
              cx={sx}
              cy={sy}
              r={s.size}
              fill="white"
              opacity={twinkleOpacity}
              style={{ filter: `drop-shadow(0 0 ${s.size * 2}px white)` }}
            />
          );
        })}

        {/* ─── Accretion disk (Cosmic+) ────────────────────────────── */}
        {tier.accretion && (
          <g style={{ transformOrigin: `${center}px ${center}px`, transform: `rotate(${rotation * 0.3}deg)` }}>
            <ellipse
              cx={center}
              cy={center}
              rx={armRadius + armWidth + 8}
              ry={(armRadius + armWidth + 8) * 0.3}
              fill="none"
              stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.3)`}
              strokeWidth={2}
              strokeDasharray="4 8"
            />
            <ellipse
              cx={center}
              cy={center}
              rx={armRadius + armWidth + 14}
              ry={(armRadius + armWidth + 14) * 0.25}
              fill="none"
              stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.15)`}
              strokeWidth={1.5}
              strokeDasharray="2 6"
            />
          </g>
        )}

        {/* ─── Glow circle ──────────────────────────────────────────── */}
        {isSpinning && (
          <circle
            cx={center}
            cy={center}
            r={armRadius + armWidth + glowSize}
            fill={`url(#${gid}-glow)`}
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
            fill={`url(#${gid}-glow)`}
            opacity={0.3}
          />
        )}

        {/* ─── Aura (Galaxy+) ───────────────────────────────────────── */}
        {tier.aura && isSpinning && (
          <circle
            cx={center}
            cy={center}
            r={armRadius + armWidth + 4}
            fill="none"
            stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, ${0.2 + glowIntensity * 0.3})`}
            strokeWidth={1.5}
            style={{
              transformOrigin: `${center}px ${center}px`,
              transform: `rotate(${rotation * 0.5}deg)`,
              animation: "fidget-aura-rotate 3s linear infinite",
            }}
            strokeDasharray="3 12"
          />
        )}

        {/* ─── Rings (Over 9000+) ──────────────────────────────────── */}
        {tier.rings && isSpinning && (
          <g style={{ transformOrigin: `${center}px ${center}px`, transform: `rotate(${boostRingRotation}deg)` }}>
            <circle
              cx={center}
              cy={center}
              r={armRadius + armWidth + 6}
              fill="none"
              stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.5)`}
              strokeWidth={2}
              strokeDasharray="8 5"
            />
            {isFast && (
              <circle
                cx={center}
                cy={center}
                r={armRadius + armWidth + 12}
                fill="none"
                stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.3)`}
                strokeWidth={1.5}
                strokeDasharray="4 10"
              />
            )}
          </g>
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

        {/* ─── Lightning arcs (Plasma+) ────────────────────────────── */}
        {tier.lightning && lightning.map((arc) => (
          <g key={arc.id} style={{ transformOrigin: `${center}px ${center}px`, transform: `rotate(${arc.angle + rotation}deg)` }}>
            <polyline
              points={arc.segments.map((s) => `${center + s.x},${center + s.y}`).join(" ")}
              fill="none"
              stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, ${arc.life * 0.8})`}
              strokeWidth={1.5 + arc.life * 2}
              strokeLinecap="round"
              filter={`url(#${gid}-blur)`}
            />
          </g>
        ))}

        {/* ─── Particle trails ──────────────────────────────────────── */}
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
              fill={`hsla(${p.hue}, 85%, 65%, ${p.life * 0.9})`}
              filter={`url(#${gid}-blur)`}
              style={tier.trails ? { filter: `url(#${gid}-blur) drop-shadow(0 0 ${p.size * p.life * 2}px hsla(${p.hue}, 85%, 65%, ${p.life * 0.5}))` } : undefined}
            />
          );
        })}

        {/* ─── Spinner body ─────────────────────────────────────────── */}
        <g
          style={{
            transformOrigin: `${center}px ${center}px`,
            animation: wobbleAnim,
          }}
        >
        <g
          style={{
            transformOrigin: `${center}px ${center}px`,
            transform: `rotate(${rotation}deg)`,
          }}
          onPointerDown={handleBodyPointerDown}
          onPointerMove={handleBodyPointerMove}
          onPointerUp={handleBodyPointerUp}
          onClick={handleBodyClick}
        >
          {/* Connecting lines/arcs between arms */}
          {tier.connectorStyle !== "none" && armPositions.map((pos, i) => {
            const next = armPositions[(i + 1) % armPositions.length];
            if (tier.connectorStyle === "arc") {
              // Arc connector — quadratic curve bowing toward center
              const midX = (pos.x + next.x) / 2;
              const midY = (pos.y + next.y) / 2;
              const towardCenterX = center + (midX - center) * 0.3;
              const towardCenterY = center + (midY - center) * 0.3;
              return (
                <path
                  key={`conn-${i}`}
                  d={`M ${pos.x} ${pos.y} Q ${towardCenterX} ${towardCenterY} ${next.x} ${next.y}`}
                  fill="none"
                  stroke={isLocked ? "rgba(251, 191, 36, 0.5)" : `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.35)`}
                  strokeWidth={armWidth * 0.4}
                  strokeLinecap="round"
                />
              );
            }
            return (
              <line
                key={`conn-${i}`}
                x1={pos.x}
                y1={pos.y}
                x2={next.x}
                y2={next.y}
                stroke={isLocked ? "rgba(251, 191, 36, 0.5)" : `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.3)`}
                strokeWidth={armWidth * 0.5}
                strokeLinecap="round"
              />
            );
          })}

          {/* Arms — shape varies by tier */}
          {armPositions.map((pos, i) => {
            const armFill = isLocked ? "rgba(251, 191, 36, 0.95)" : `url(#${gid}-arm)`;
            const armStroke = isLocked ? "rgba(252, 211, 77, 0.8)" : tier.armStroke;
            const armAngle = pos.angle + rotation;

            return (
              <g key={`arm-${i}`}>
                {/* Outer glow ring on arm (tier 1+) */}
                {tier.id >= 1 && isSpinning && (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={armWidth + 2 + glowIntensity * 4}
                    fill="none"
                    stroke={`rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, ${0.3 + glowIntensity * 0.3})`}
                    strokeWidth={1}
                  />
                )}

                {/* Arm shape by tier */}
                {tier.armShape === "circle" && (
                  <>
                    <circle cx={pos.x} cy={pos.y} r={armWidth} fill={armFill} stroke={armStroke} strokeWidth={1.5} />
                    <circle cx={pos.x - armWidth * 0.25} cy={pos.y - armWidth * 0.25} r={armWidth * 0.3} fill="rgba(255,255,255,0.25)" />
                  </>
                )}

                {tier.armShape === "blade" && (
                  <g transform={`rotate(${armAngle} ${pos.x} ${pos.y})`}>
                    <ellipse cx={pos.x} cy={pos.y} rx={armWidth * 1.4} ry={armWidth * 0.6} fill={armFill} stroke={armStroke} strokeWidth={1.5} />
                    <ellipse cx={pos.x - armWidth * 0.3} cy={pos.y} rx={armWidth * 0.4} ry={armWidth * 0.2} fill="rgba(255,255,255,0.3)" />
                  </g>
                )}

                {tier.armShape === "diamond" && (
                  <g transform={`rotate(${armAngle} ${pos.x} ${pos.y})`}>
                    <polygon
                      points={`${pos.x},${pos.y - armWidth * 1.1} ${pos.x + armWidth * 0.7},${pos.y} ${pos.x},${pos.y + armWidth * 1.1} ${pos.x - armWidth * 0.7},${pos.y}`}
                      fill={armFill}
                      stroke={armStroke}
                      strokeWidth={1.5}
                    />
                    <polygon
                      points={`${pos.x},${pos.y - armWidth * 0.5} ${pos.x + armWidth * 0.3},${pos.y} ${pos.x},${pos.y + armWidth * 0.5} ${pos.x - armWidth * 0.3},${pos.y}`}
                      fill="rgba(255,255,255,0.25)"
                    />
                  </g>
                )}

                {tier.armShape === "star" && (() => {
                  const points: string[] = [];
                  const spikes = 5;
                  for (let s = 0; s < spikes * 2; s++) {
                    const r = s % 2 === 0 ? armWidth * 1.3 : armWidth * 0.55;
                    const a = (s / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
                    points.push(`${pos.x + Math.cos(a) * r},${pos.y + Math.sin(a) * r}`);
                  }
                  return (
                    <polygon points={points.join(" ")} fill={armFill} stroke={armStroke} strokeWidth={1.5} />
                  );
                })()}

                {tier.armShape === "orbital" && (
                  <g transform={`rotate(${armAngle} ${pos.x} ${pos.y})`}>
                    <ellipse cx={pos.x} cy={pos.y} rx={armWidth * 0.5} ry={armWidth * 1.2} fill={armFill} stroke={armStroke} strokeWidth={1.5} />
                    <circle cx={pos.x} cy={pos.y - armWidth * 0.6} r={armWidth * 0.25} fill="rgba(255,255,255,0.4)" />
                  </g>
                )}
              </g>
            );
          })}

          {/* Center hub — shape varies by tier */}
          {tier.hubShape === "circle" && (
            <circle
              cx={center}
              cy={center}
              r={hubRadius}
              fill={isCharging ? `rgba(251, 146, 60, ${0.4 + chargeProgress * 0.5})` : `url(#${gid}-hub)`}
              stroke={isLocked ? "rgba(252, 211, 77, 0.8)" : "rgba(148, 163, 184, 0.6)"}
              strokeWidth={2}
              onPointerDown={handleCenterPointerDown}
              onPointerUp={handleCenterPointerUp}
              style={{ cursor: "pointer" }}
            />
          )}

          {tier.hubShape === "hex" && (() => {
            const pts: string[] = [];
            for (let h = 0; h < 6; h++) {
              const a = (h / 6) * Math.PI * 2 - Math.PI / 2;
              pts.push(`${center + Math.cos(a) * hubRadius},${center + Math.sin(a) * hubRadius}`);
            }
            return (
              <polygon
                points={pts.join(" ")}
                fill={isCharging ? `rgba(251, 146, 60, ${0.4 + chargeProgress * 0.5})` : `url(#${gid}-hub)`}
                stroke={isLocked ? "rgba(252, 211, 77, 0.8)" : "rgba(148, 163, 184, 0.6)"}
                strokeWidth={2}
                onPointerDown={handleCenterPointerDown}
                onPointerUp={handleCenterPointerUp}
                style={{ cursor: "pointer" }}
              />
            );
          })()}

          {tier.hubShape === "core" && (
            <g
              onPointerDown={handleCenterPointerDown}
              onPointerUp={handleCenterPointerUp}
              style={{ cursor: "pointer" }}
            >
              {/* Outer ring */}
              <circle cx={center} cy={center} r={hubRadius} fill="none" stroke={tier.armStroke} strokeWidth={1.5} />
              {/* Inner pulsing core */}
              <circle
                cx={center}
                cy={center}
                r={hubRadius * 0.65}
                fill={isCharging ? `rgba(251, 146, 60, ${0.4 + chargeProgress * 0.5})` : `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.6)`}
                style={{ animation: "fidget-glow-pulse 1.5s ease-in-out infinite" }}
              />
              {/* Bright center */}
              <circle cx={center} cy={center} r={hubRadius * 0.3} fill="rgba(255,255,255,0.7)" />
            </g>
          )}

          {/* Charge progress ring */}
          {isCharging && (
            <circle
              cx={center}
              cy={center}
              r={hubRadius + 3}
              fill="none"
              stroke="rgba(251, 146, 60, 0.8)"
              strokeWidth={2.5}
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
        </g>

        {/* ─── Prismatic overlay (Singularity) ──────────────────────── */}
        {tier.prismatic && isFast && (
          <circle
            cx={center}
            cy={center}
            r={armRadius + armWidth + 6}
            fill="none"
            stroke="url(#prismatic-grad)"
            strokeWidth={3}
            opacity={0.4 + glowIntensity * 0.4}
            style={{
              transformOrigin: `${center}px ${center}px`,
              animation: "fidget-prismatic-rotate 2s linear infinite",
            }}
          />
        )}
      </svg>

      {/* ─── Spin count badge (positioned above the spinner, inside bounds) ── */}
      {showSpinCount && (
        <div
          className="absolute pointer-events-none whitespace-nowrap font-mono font-bold transition-all z-10"
          style={{
            top: `${size * 0.02}px`,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: `${Math.max(10, Math.min(size * 0.09, 10 + size * 0.025 + speed * 0.06))}px`,
            color: isFast
              ? `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.95)`
              : isSpinning
              ? `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.85)`
              : "rgba(100, 116, 139, 0.7)",
            textShadow: isSpinning
              ? `0 0 ${4 + glowIntensity * 16}px rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.8)`
              : "none",
            animation: spinTick > 0 ? "fidget-spin-pop 0.3s ease-out" : undefined,
          }}
        >
          {totalSpins.toLocaleString()} spins
        </div>
      )}

      {/* Tier name + next unlock progress (positioned below the spinner, inside bounds) */}
      {showSpinCount && (
        <div
          className="absolute pointer-events-none whitespace-nowrap font-mono transition-all z-10"
          style={{
            bottom: `${size * 0.02}px`,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: `${Math.max(8, size * 0.06)}px`,
            color: `rgba(${tier.glowR}, ${tier.glowG}, ${tier.glowB}, 0.6)`,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            fontWeight: 700,
          }}
        >
          {tier.name}
          {nextTier && (
            <span style={{ fontSize: `${Math.max(7, size * 0.045)}px`, color: "rgba(100, 116, 139, 0.5)", marginLeft: "6px" }}>
              → {nextTier.name} @ {nextTier.threshold.toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Confetti — portaled to body */}
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
                  width: p.shape === "star" ? `${p.size * 1.2}px` : `${p.size}px`,
                  height: p.shape === "rect" ? `${p.size * 0.6}px` : `${p.size}px`,
                  background: p.color,
                  borderRadius: p.shape === "circle" ? "50%" : p.shape === "star" ? "0" : "2px",
                  clipPath: p.shape === "star" ? "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)" : undefined,
                  transform: `rotate(${p.rotation}deg)`,
                  opacity,
                  willChange: "transform, opacity",
                  boxShadow: `0 0 4px ${p.color}80`,
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
