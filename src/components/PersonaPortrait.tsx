import { useState } from 'react';
import { Bot } from 'lucide-react';
import { useReducedMotion } from 'motion/react';

/** Keep a usable local portrait when the optional image host is unavailable. */
export function PersonaPortrait({ image, still, active, size }: { image: string; still: string; active: boolean; size: number }) {
  const [stillFailed, setStillFailed] = useState(false);
  const [animationFailed, setAnimationFailed] = useState(false);
  const reducedMotion = useReducedMotion();
  const animate = !reducedMotion && !animationFailed;

  return (
    <span className="persona-portrait relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/5" style={{ width: size, height: size }} aria-hidden="true">
      <Bot className="w-5 h-5 opacity-70" />
      {!stillFailed && <img src={still} alt="" loading="lazy" onError={() => setStillFailed(true)} className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${animate ? active ? 'opacity-0' : 'opacity-100 group-hover:opacity-0' : 'opacity-100'}`} />}
      {animate && <img src={image} alt="" loading="lazy" onError={() => setAnimationFailed(true)} className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${active || stillFailed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />}
    </span>
  );
}
