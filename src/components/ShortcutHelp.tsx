import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Keyboard } from 'lucide-react';

const SHORTCUTS = [
  { keys: ['Ctrl', 'K'], label: 'Open Command Palette', category: 'Global' },
  { keys: ['F'], label: 'Forge new batch', category: 'Forge' },
  { keys: ['S'], label: 'Send top variant to chat', category: 'Forge' },
  { keys: ['C'], label: 'Capture browser stream', category: 'Capture' },
  { keys: ['A'], label: 'Toggle AutoForge on/off', category: 'AutoForge' },
  { keys: ['H'], label: 'Toggle AutoForge HUD', category: 'AutoForge' },
  { keys: ['D'], label: 'Toggle Analytics Dashboard', category: 'AutoForge' },
  { keys: ['V'], label: 'Open Visual Snapshot History', category: 'Capture' },
  { keys: ['T'], label: 'Cycle Theme (Default → CosmoTech → Corrupture)', category: 'Theme' },
  { keys: ['Ctrl', 'B'], label: 'Collapse/Expand Context Rail', category: 'Layout' },
  { keys: ['1', '-', '9'], label: 'Toggle bot 1–9 on/off (multi-bot)', category: 'Multi-Bot' },
  { keys: ['?'], label: 'Show this shortcut help', category: 'Global' },
  { keys: ['Esc'], label: 'Close dialogs / overlays', category: 'Global' },
];

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '?') {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-[#121217] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 bg-black/40">
              <div className="flex items-center gap-2">
                <Keyboard className="w-4 h-4 text-orange-400" />
                <h2 className="text-sm font-black uppercase tracking-widest text-gray-300 font-mono">
                  Keyboard Shortcuts
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto forge-scroll">
              {categories.map((cat) => (
                <div key={cat} className="space-y-1.5">
                  <div className="text-[9px] font-black uppercase tracking-widest text-gray-600 font-mono px-1">
                    {cat}
                  </div>
                  {SHORTCUTS.filter((s) => s.category === cat).map((s, i) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors">
                      <span className="text-xs text-gray-300">{s.label}</span>
                      <div className="flex items-center gap-1">
                        {s.keys.map((k, j) => (
                          <React.Fragment key={j}>
                            {j > 0 && <span className="text-[10px] text-gray-600">+</span>}
                            <kbd className="text-[10px] font-mono font-bold bg-white/10 border border-white/15 rounded px-1.5 py-0.5 text-gray-300 shadow-sm">
                              {k}
                            </kbd>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="px-5 py-2.5 border-t border-white/5 bg-black/40">
              <p className="text-[10px] text-gray-600 font-mono text-center">
                Press <kbd className="bg-white/10 border border-white/15 rounded px-1 py-0.5 text-gray-400">?</kbd> anytime to toggle this overlay
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
