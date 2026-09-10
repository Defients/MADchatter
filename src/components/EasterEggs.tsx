import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '../store';
import { toast } from 'sonner';
import { playSfx } from '../lib/sfx';

// ─── Konami Code ─────────────────────────────────────────────────────────────

const KONAMI_SEQUENCE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'b', 'a',
];

// ─── Secret Words ────────────────────────────────────────────────────────────

const SECRET_WORDS = ['gremlin', 'forge', 'rage', 'urz'] as const;
const SECRET_WORD_TIMEOUT_MS = 2500;

// ─── Secret Lab Fortunes ─────────────────────────────────────────────────────

const SECRET_LAB_FORTUNES = [
  "The gremlin whispers: 'touch grass'",
  "Raid Shadow Legends sponsors your next forge",
  "Kappa is watching. Always watching.",
  "The forge burns brightest at 3am",
  "A wild Hype Beast appeared!",
  "Chaos level 100 is not a personality trait... or is it?",
  "The Analyst says: your win rate is statistically irrelevant",
  "One-Worder says: 'nice'",
  "Questioner asks: why are you here?",
  "Support says: you're doing great, keep going",
  "R34L mode is just being yourself on main",
  "The Fidget Spinner holds the secrets of the universe",
  "AutoForge never sleeps. It only hungers.",
  "EleGiggle is the sound of one hand clapping",
  "Kreygasm: the face of pure forge energy",
];

// ─── Confetti ────────────────────────────────────────────────────────────────

const CONFETTI_COLORS = [
  '#f472b6', '#fbbf24', '#34d399', '#60a5fa',
  '#a78bfa', '#fb923c', '#f87171', '#2dd4bf',
  '#facc15', '#e879f9',
];

interface ConfettiPiece {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  vr: number;
  color: string;
  size: number;
  shape: 'rect' | 'circle';
  born: number;
}

function ConfettiBurst({ pieces }: { pieces: ConfettiPiece[] }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return createPortal(
    <div className="fixed inset-0 z-[99998] pointer-events-none overflow-hidden">
      {pieces.map((p) => (
        <div
          key={p.id}
          className="absolute"
          style={{
            left: `${p.x}px`,
            top: `${p.y}px`,
            width: `${p.size}px`,
            height: p.shape === 'rect' ? `${p.size * 0.6}px` : `${p.size}px`,
            backgroundColor: p.color,
            borderRadius: p.shape === 'circle' ? '50%' : '2px',
            transform: `rotate(${p.rotation}deg)`,
            animation: `confetti-fall 3s ease-out forwards`,
            '--confetti-vx': `${p.vx}px`,
            '--confetti-vy': `${p.vy}px`,
            '--confetti-vr': `${p.vr}deg`,
          } as React.CSSProperties}
        />
      ))}
    </div>,
    document.body,
  );
}

function generateConfetti(count: number, originX?: number, originY?: number): ConfettiPiece[] {
  const pieces: ConfettiPiece[] = [];
  const cx = originX ?? window.innerWidth / 2;
  const cy = originY ?? window.innerHeight / 2;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 8;
    pieces.push({
      id: Date.now() + i,
      x: cx + (Math.random() - 0.5) * 40,
      y: cy + (Math.random() - 0.5) * 40,
      vx: Math.cos(angle) * speed * 50,
      vy: Math.sin(angle) * speed * 50 - 100,
      rotation: Math.random() * 360,
      vr: (Math.random() - 0.5) * 720,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      size: 6 + Math.random() * 8,
      shape: Math.random() < 0.5 ? 'rect' : 'circle',
      born: Date.now(),
    });
  }
  return pieces;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function EasterEggs() {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);

  const [confetti, setConfetti] = useState<ConfettiPiece[]>([]);
  const [maxRageActive, setMaxRageActive] = useState(false);
  const [secretLabOpen, setSecretLabOpen] = useState(false);
  const [secretLabFortune, setSecretLabFortune] = useState('');

  const konamiRef = useRef<string[]>([]);
  const konamiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wordBufferRef = useRef<string>('');
  const wordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxRageToastShownRef = useRef(false);

  // ── 1. Konami Code Listener ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      konamiRef.current.push(key);
      if (konamiRef.current.length > KONAMI_SEQUENCE.length) {
        konamiRef.current.shift();
      }

      // Check if the last N keys match the Konami sequence
      if (konamiRef.current.length === KONAMI_SEQUENCE.length) {
        const match = konamiRef.current.every(
          (k, i) => k === KONAMI_SEQUENCE[i].toLowerCase()
        );
        if (match) {
          konamiRef.current = [];
          triggerKonami();
          return;
        }
      }

      // Reset timer
      if (konamiTimerRef.current) clearTimeout(konamiTimerRef.current);
      konamiTimerRef.current = setTimeout(() => {
        konamiRef.current = [];
      }, 3000);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (konamiTimerRef.current) clearTimeout(konamiTimerRef.current);
    };
  }, []);

  const triggerKonami = useCallback(() => {
    setConfetti(generateConfetti(120));
    playSfx('konami');
    toast.success('🌈 KONAMI CODE ACTIVATED — RAINBOW FORGE MODE! 🌈', {
      duration: 4000,
    });
    window.dispatchEvent(new CustomEvent('easter-egg-konami', { detail: { active: true } }));
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('easter-egg-konami', { detail: { active: false } }));
    }, 10000);
  }, []);

  // ── 2. Secret Word Listener ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in inputs
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      // Only process letter keys
      if (e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;

      wordBufferRef.current = (wordBufferRef.current + e.key.toLowerCase()).slice(-20);

      // Check for secret word matches
      for (const word of SECRET_WORDS) {
        if (wordBufferRef.current.endsWith(word)) {
          wordBufferRef.current = '';
          triggerSecretWord(word);
          return;
        }
      }

      // Reset buffer after timeout
      if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
      wordTimerRef.current = setTimeout(() => {
        wordBufferRef.current = '';
      }, SECRET_WORD_TIMEOUT_MS);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
    };
  }, []);

  const triggerSecretWord = useCallback((word: string) => {
    if (word === 'gremlin') {
      playSfx('secret_word');
      toast.success('👹 GREMLIN MODE UNLEASHED!', { duration: 3000 });
      window.dispatchEvent(new CustomEvent('easter-egg-particles', {
        detail: { color: '239, 68, 68', count: 40 },
      }));
    } else if (word === 'forge') {
      playSfx('secret_word');
      toast.success('🔥 FORGE FRENZY!', { duration: 3000 });
      setConfetti(generateConfetti(60));
      // Triple forge trigger
      window.dispatchEvent(new CustomEvent('forge-trigger'));
      setTimeout(() => window.dispatchEvent(new CustomEvent('forge-trigger')), 500);
      setTimeout(() => window.dispatchEvent(new CustomEvent('forge-trigger')), 1000);
    } else if (word === 'rage') {
      playSfx('secret_word');
      toast.success('😡 MAX RAGE DETECTED!', { duration: 3000 });
      updateConfig({ humorLevel: 100, chaosLevel: 100 });
    } else if (word === 'urz') {
      const s = useAppStore.getState();
      const next = !s.lightThemeActive;
      s.setLightThemeActive(next);
      playSfx('theme_toggle');
      toast.success(next ? '✨ Urz Light Theme unlocked!' : 'Urz Light Theme forgotten.', { duration: 3000 });
    }
  }, [updateConfig]);

  // ── 3. MAX RAGE Slider Combo ─────────────────────────────────────────────
  useEffect(() => {
    const bothMaxed = config.humorLevel === 100 && config.chaosLevel === 100;
    if (bothMaxed && !maxRageActive) {
      setMaxRageActive(true);
      playSfx('max_rage');
      window.dispatchEvent(new CustomEvent('easter-egg-max-rage', { detail: { active: true } }));
      if (!maxRageToastShownRef.current) {
        maxRageToastShownRef.current = true;
        toast.success('🔥🌀 MAX RAGE MODE ENGAGED — MAY GOD HAVE MERCY 🔥🌀', {
          duration: 5000,
        });
      }
    } else if (!bothMaxed && maxRageActive) {
      setMaxRageActive(false);
      window.dispatchEvent(new CustomEvent('easter-egg-max-rage', { detail: { active: false } }));
      if (maxRageToastShownRef.current) {
        maxRageToastShownRef.current = false;
        toast.success('Phew... rage subsided. Normality restored.', {
          duration: 3000,
        });
      }
    }
  }, [config.humorLevel, config.chaosLevel, maxRageActive]);

  // ── 4. Secret Lab Event Listener ─────────────────────────────────────────
  useEffect(() => {
    const onSecretLab = () => {
      const fortune = SECRET_LAB_FORTUNES[Math.floor(Math.random() * SECRET_LAB_FORTUNES.length)];
      setSecretLabFortune(fortune);
      setSecretLabOpen(true);
      playSfx('secret_lab');
      toast.success('🔓 You found the secret lab!', { duration: 3000 });
    };
    window.addEventListener('easter-egg-secret-lab', onSecretLab);
    return () => window.removeEventListener('easter-egg-secret-lab', onSecretLab);
  }, []);

  const closeSecretLab = useCallback(() => {
    setSecretLabOpen(false);
  }, []);

  // Auto-dismiss secret lab after 4s
  useEffect(() => {
    if (!secretLabOpen) return;
    const timer = setTimeout(closeSecretLab, 4000);
    return () => clearTimeout(timer);
  }, [secretLabOpen, closeSecretLab]);

  return (
    <>
      {/* Confetti */}
      {confetti.length > 0 && <ConfettiBurst pieces={confetti} />}

      {/* MAX RAGE vignette */}
      {maxRageActive && (
        <div className="fixed inset-0 z-[99996] pointer-events-none max-rage-vignette" />
      )}

      {/* Secret Lab overlay */}
      <AnimatePresence>
        {secretLabOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[99998] flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={closeSecretLab}
          >
            <motion.div
              initial={{ scale: 0.8, y: 30 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.8, y: 30 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="relative bg-[#0a0a0f] border-2 border-orange-500/40 rounded-2xl shadow-2xl px-8 py-10 max-w-md text-center overflow-hidden"
            >
              {/* Glow background */}
              <div className="absolute inset-0 bg-gradient-to-br from-orange-500/10 via-purple-500/10 to-transparent pointer-events-none" />

              <div className="relative space-y-4">
                <h2 className="text-2xl font-black uppercase tracking-widest text-orange-400 font-mono glitch-text" data-text="SECRET LAB">
                  SECRET LAB
                </h2>
                <div className="text-[10px] font-mono uppercase tracking-widest text-gray-600">
                  🔓 Unlocked
                </div>
                <div className="h-px bg-gradient-to-r from-transparent via-orange-500/30 to-transparent" />
                <p className="text-sm text-gray-300 font-mono italic leading-relaxed">
                  "{secretLabFortune}"
                </p>
                <div className="text-[9px] font-mono text-gray-700 pt-2">
                  click anywhere to dismiss
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
