import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { X, ChevronLeft, ChevronRight, SkipForward, Sparkles, Check } from "lucide-react";
import { useAppStore } from "../store";
import { playSfx } from "../lib/sfx";
import { TUTORIAL_STEPS, TUTORIAL_STORAGE_KEY, parseChunceLogWithDelays, getTutorialSampleMemories } from "../lib/tutorialData";
import { fireConfetti } from "../lib/confetti";
import kekwImg from "../../assets/kekw.jpg";

type WidgetType = "audio" | "chat" | "visual" | "memory" | "stream";

const STEP_WIDGET_MAP: Record<number, WidgetType> = {
  2: "chat",
  3: "stream",
  4: "visual",
  5: "audio",
  6: "memory",
};

const SCROLL_UP_STEPS = new Set([5]); // step 6 (0-indexed 5): scroll back up

const CARD_WIDTH = 380;
const CARD_MAX_HEIGHT = 320;
const PADDING = 12;

function calculateCardPosition(
  targetRect: DOMRect,
  position: "top" | "bottom" | "right" | "left",
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left: number;
  let top: number;

  switch (position) {
    case "top":
      left = targetRect.left + targetRect.width / 2 - CARD_WIDTH / 2;
      top = targetRect.top - CARD_MAX_HEIGHT - PADDING;
      break;
    case "bottom":
      left = targetRect.left + targetRect.width / 2 - CARD_WIDTH / 2;
      top = targetRect.bottom + PADDING;
      break;
    case "right":
      left = targetRect.right + PADDING;
      top = targetRect.top + targetRect.height / 2 - CARD_MAX_HEIGHT / 2;
      break;
    case "left":
      left = targetRect.left - CARD_WIDTH - PADDING;
      top = targetRect.top + targetRect.height / 2 - CARD_MAX_HEIGHT / 2;
      break;
  }

  left = Math.max(PADDING, Math.min(vw - CARD_WIDTH - PADDING, left));
  top = Math.max(PADDING, Math.min(vh - CARD_MAX_HEIGHT - PADDING, top));

  return { left, top };
}

export function TutorialWalkthrough() {
  const { tutorialActive, setTutorialActive, tutorialStep, setTutorialStep } = useAppStore();
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [cardPos, setCardPos] = useState<{ left: number; top: number }>({ left: 100, top: 100 });
  const rafRef = useRef<number | null>(null);
  const messageTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tutorialChannelRef = useRef<string | null>(null);

  const totalSteps = TUTORIAL_STEPS.length;
  const currentStep = TUTORIAL_STEPS[tutorialStep];

  const updateTargetRect = useCallback(() => {
    if (!currentStep || !tutorialActive) return;
    const el = document.querySelector(currentStep.selector) as HTMLElement | null;
    if (!el) {
      setTargetRect(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setTargetRect(rect);
    const pos = calculateCardPosition(rect, currentStep.position);
    setCardPos(pos);
  }, [currentStep, tutorialActive]);

  useEffect(() => {
    if (!tutorialActive) return;
    updateTargetRect();

    const onScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateTargetRect);
    };
    const onResize = () => updateTargetRect();

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const interval = setInterval(updateTargetRect, 500);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      clearInterval(interval);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [tutorialActive, tutorialStep, updateTargetRect]);

  const loadSampleData = useCallback(() => {
    const state = useAppStore.getState();
    const timedMessages = parseChunceLogWithDelays();
    const prevChannel = state.streamMetadata?.channelName || null;
    tutorialChannelRef.current = prevChannel;
    state.updateStreamMetadata({
      channelName: "skippypoppin",
      title: "Divinity Original Sin 2 — Act 1 Fort Joy",
      category: "Games",
      viewerCount: 4283,
    });
    const existingLog = useAppStore.getState().chatLog;
    const hasTutorialData = existingLog.some(
      (m) => !m.marker && m.user === "thecreature" && m.text.includes("Chunce"),
    );
    if (!hasTutorialData) {
      let cumulative = 0;
      for (const timed of timedMessages) {
        cumulative += timed.delayMs;
        const isBannedMsg = timed.message.user === "thecreature" && timed.message.text.includes("tru dat");
        const id = setTimeout(() => {
          useAppStore.getState().appendChatLog(timed.message);
          if (isBannedMsg) {
            setTimeout(() => {
              useAppStore.getState().markUserBanned("thecreature");
            }, 3500);
          }
        }, cumulative);
        messageTimeoutsRef.current.push(id);
      }
    }
    const existingTranscript = useAppStore.getState().audioTranscript;
    if (!existingTranscript) {
      // Video timeline: mustardfite (0-20s) → waterfite (20-49s) → kissfite (49-78s)
      const transcriptLines: { text: string; delay: number }[] = [
        // Mustard bath dialogue — spread across mustardfite.mp4 (0-20s)
        { text: "Hey check this out.", delay: 500 },
        { text: "What no don't time for a mustard bath.", delay: 3000 },
        { text: "Ah stop it.", delay: 5500 },
        { text: "You look great.", delay: 8000 },
        { text: "This is disgusting. Why?!", delay: 10500 },
        { text: "Damnit Chunce.", delay: 13000 },
        // Fight dialogue — starts during waterfite.mp4 (20-49s), continues into kissfite.mp4 (49-78s)
        { text: "You think you can handle me, knight?", delay: 22000 },
        { text: "Bring it on, kitty cat! Take that!", delay: 24500 },
        { text: "Ha! Too slow!", delay: 27000 },
        { text: "You'll see!", delay: 29000 },
        { text: "Good fight, furball.", delay: 31500 },
        { text: "How about a little refreshment?", delay: 34000 },
        { text: "Oh, you're on! Oh, take that!", delay: 36500 },
        { text: "Not so fast, furball!", delay: 39000 },
        { text: "You're all fizz me aboard.", delay: 41500 },
        { text: "You think this is a game?", delay: 44000 },
        { text: "Back off right now!", delay: 46500 },
        { text: "I'll tear you apart!", delay: 49000 },
        { text: "Try it!", delay: 51500 },
        // Romance dialogue — during kissfite.mp4 (49-78s), slower pacing
        { text: "You drive me wild, armored one.", delay: 54000 },
        { text: "Come here, my furry beast.", delay: 56500 },
        { text: "Hold me closer.", delay: 59000 },
        { text: "Forever, my love.", delay: 61500 },
        { text: "I could stare into your eyes forever.", delay: 64000 },
        { text: "Then never look away, my love.", delay: 66500 },
        { text: "I want to kiss you so badly.", delay: 69000 },
        { text: "I know, but we shouldn't.", delay: 71500 },
        { text: "Not here.", delay: 74000 },
        { text: "PYAH!", delay: 77000 },
      ];
      for (const line of transcriptLines) {
        const id = setTimeout(() => {
          useAppStore.getState().appendAudioTranscript(line.text);
        }, line.delay);
        messageTimeoutsRef.current.push(id);
      }
    }
    const existingMemories = useAppStore.getState().pinnedMemories;
    if (existingMemories.length === 0) {
      const sampleMemories = getTutorialSampleMemories();
      for (const mem of sampleMemories) {
        state.addPinnedMemory({
          type: mem.type,
          content: mem.content,
          label: mem.label,
          timestamp: mem.timestamp,
        });
      }
      // Mark the first memory ("i did it Chunce") as the Golden Memory
      // addPinnedMemory generates new IDs in the store, so read back the actual IDs
      setTimeout(() => {
        const memories = useAppStore.getState().pinnedMemories;
        if (memories.length > 0) {
          useAppStore.getState().setGoldenMemory(memories[0].id);
        }
      }, 2000);
    }
    // Set the KEKW image as the visual snapshot
    if (!useAppStore.getState().visualSnapshotUrl) {
      useAppStore.getState().setVisualSnapshot(kekwImg, ["KEKW", "emote", "reaction"]);
    }
  }, []);

  const startTutorial = useCallback(() => {
    loadSampleData();
    setTutorialStep(0);
    setTutorialActive(true);
    playSfx("forge_start");
  }, [loadSampleData, setTutorialActive, setTutorialStep]);

  const nextStep = useCallback(() => {
    if (tutorialStep >= totalSteps - 1) {
      finishTutorial();
      return;
    }
    setTutorialStep(tutorialStep + 1);
    playSfx("palette_select");
  }, [tutorialStep, totalSteps, setTutorialStep]);

  const prevStep = useCallback(() => {
    if (tutorialStep <= 0) return;
    setTutorialStep(tutorialStep - 1);
    playSfx("palette_select");
  }, [tutorialStep, setTutorialStep]);

  const cleanupTutorialData = useCallback(() => {
    for (const id of messageTimeoutsRef.current) {
      clearTimeout(id);
    }
    messageTimeoutsRef.current = [];
    // Clear all sample stream data
    useAppStore.getState().clearAllContext();
    useAppStore.getState().setIsAutoForgeHUDOpen(false);
    // Reset AutoForge header color if it was changed
    const header = document.querySelector('[data-tutorial="autoforge-header"]') as HTMLElement | null;
    if (header) {
      header.style.color = "";
      header.style.textShadow = "";
    }
    if (tutorialChannelRef.current !== null) {
      useAppStore.getState().updateStreamMetadata({
        channelName: tutorialChannelRef.current,
      });
      tutorialChannelRef.current = null;
    }
  }, []);

  const finishTutorial = useCallback(() => {
    localStorage.setItem(TUTORIAL_STORAGE_KEY, "1");
    cleanupTutorialData();
    setTutorialActive(false);
    setTutorialStep(0);
    playSfx("welcome_dismiss");
    fireConfetti("all", 120);
  }, [setTutorialActive, setTutorialStep, cleanupTutorialData]);

  const skipTutorial = useCallback(() => {
    localStorage.setItem(TUTORIAL_STORAGE_KEY, "1");
    cleanupTutorialData();
    setTutorialActive(false);
    setTutorialStep(0);
    playSfx("panel_collapse");
  }, [setTutorialActive, setTutorialStep, cleanupTutorialData]);

  useEffect(() => {
    if (localStorage.getItem(TUTORIAL_STORAGE_KEY)) return;
    if (localStorage.getItem("madchatter-welcome-seen")) {
      const timer = setTimeout(() => {
        if (!useAppStore.getState().tutorialActive) {
          startTutorial();
        }
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [startTutorial]);

  useEffect(() => {
    const onStart = () => startTutorial();
    window.addEventListener("tutorial-start", onStart);
    return () => window.removeEventListener("tutorial-start", onStart);
  }, [startTutorial]);

  // Auto-open the relevant widget when a widget tutorial step activates
  useEffect(() => {
    if (!tutorialActive) return;
    const widget = STEP_WIDGET_MAP[tutorialStep];
    if (widget) {
      window.dispatchEvent(new CustomEvent("tutorial-open-widget", { detail: { widget } }));
    }
    // Call onActivate for the current step
    if (currentStep?.onActivate) {
      currentStep.onActivate();
    }
    // Handle scroll behavior for steps 5 and 6 (0-indexed 4 and 5)
    if (currentStep?.scrollTarget) {
      setTimeout(() => {
        const scrollEl = document.querySelector(currentStep.scrollTarget!) as HTMLElement | null;
        if (scrollEl) {
          scrollEl.scrollIntoView({
            behavior: (currentStep.scrollBehavior as ScrollBehavior) || "smooth",
            block: "center",
          });
        }
      }, 300);
    } else if (SCROLL_UP_STEPS.has(tutorialStep)) {
      // Scroll back to top for step 6
      setTimeout(() => {
        const scrollContainer = document.querySelector(".forge-scroll-main") as HTMLElement | null;
        if (scrollContainer) {
          scrollContainer.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      }, 300);
    }
  }, [tutorialActive, tutorialStep, currentStep]);

  useEffect(() => {
    if (!tutorialActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skipTutorial();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        nextStep();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevStep();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tutorialActive, nextStep, prevStep, skipTutorial]);

  if (!tutorialActive || !currentStep) return null;

  const isLastStep = tutorialStep === totalSteps - 1;
  const hasTarget = targetRect !== null;

  const spotlightStyle: React.CSSProperties = hasTarget
    ? {
        boxShadow: `0 0 0 9999px rgba(0, 0, 0, 0.55)`,
        borderRadius: "8px",
      }
    : {
        boxShadow: `0 0 0 9999px rgba(0, 0, 0, 0.55)`,
      };

  return createPortal(
    <AnimatePresence>
      {tutorialActive && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100001] pointer-events-none"
        >
          {hasTarget && targetRect && (
            <motion.div
              initial={false}
              animate={{
                left: targetRect.left - 4,
                top: targetRect.top - 4,
                width: targetRect.width + 8,
                height: targetRect.height + 8,
              }}
              transition={{ type: "spring", stiffness: 200, damping: 26 }}
              className="fixed pointer-events-none border-2 border-orange-500/70 rounded-lg"
              style={spotlightStyle}
            >
              <div className="absolute inset-0 rounded-lg ring-2 ring-orange-400/50 animate-pulse" />
              <div className="absolute -top-px -left-px w-3 h-3 border-t-2 border-l-2 border-orange-300 rounded-tl-lg" />
              <div className="absolute -top-px -right-px w-3 h-3 border-t-2 border-r-2 border-orange-300 rounded-tr-lg" />
              <div className="absolute -bottom-px -left-px w-3 h-3 border-b-2 border-l-2 border-orange-300 rounded-bl-lg" />
              <div className="absolute -bottom-px -right-px w-3 h-3 border-b-2 border-r-2 border-orange-300 rounded-br-lg" />
            </motion.div>
          )}

          {!hasTarget && (
            <div className="fixed inset-0 bg-black/55" />
          )}

          <motion.div
            key={tutorialStep}
            initial={{ opacity: 0, scale: 0.92, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 10 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed pointer-events-auto"
            style={{
              left: cardPos.left,
              top: cardPos.top,
              width: CARD_WIDTH,
              maxWidth: `calc(100vw - ${PADDING * 2}px)`,
            }}
          >
            <div className="bg-gradient-to-b from-[#1a1a22] to-[#0f0f14] border border-orange-500/30 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.6)] overflow-hidden">
              <div className="h-[2px] w-full bg-gradient-to-r from-orange-500 via-purple-500 to-cyan-500" />

              <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-orange-500/20 to-purple-500/10 border border-orange-500/25 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(249,115,22,0.15)]">
                    <Sparkles className="w-4 h-4 text-orange-400" />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] font-black uppercase tracking-[0.2em] text-orange-500/60 font-mono">
                      Tutorial
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 font-mono">
                      Step {tutorialStep + 1} of {totalSteps}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={skipTutorial}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-all hover:scale-110 active:scale-95"
                  aria-label="Skip tutorial"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-5 pb-4">
                <h3 className="text-[17px] font-extrabold text-white tracking-tight mb-2 leading-snug">
                  {currentStep.title}
                </h3>
                <p className="text-[13px] text-gray-300/90 leading-[1.65] font-normal antialiased">
                  {currentStep.description}
                </p>
              </div>

              <div className="flex items-center gap-1 px-5 pb-3 flex-wrap">
                {TUTORIAL_STEPS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      i === tutorialStep
                        ? "w-5 bg-orange-500"
                        : i < tutorialStep
                          ? "w-1.5 bg-orange-500/40"
                          : "w-1.5 bg-white/10"
                    }`}
                  />
                ))}
              </div>

              <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06] bg-gradient-to-r from-black/40 via-black/20 to-black/40">
                <button
                  type="button"
                  onClick={skipTutorial}
                  className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <SkipForward className="w-3 h-3" />
                  Skip Tour
                </button>
                <div className="flex items-center gap-2">
                  {tutorialStep > 0 && (
                    <button
                      type="button"
                      onClick={prevStep}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-gray-400 bg-white/5 hover:bg-white/10 border border-white/5 transition-all"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Back
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={isLastStep ? finishTutorial : nextStep}
                    className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${
                      isLastStep
                        ? "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] hover:scale-105"
                        : "bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-[0_0_20px_rgba(249,115,22,0.25)] hover:shadow-[0_0_30px_rgba(249,115,22,0.4)] hover:scale-105"
                    }`}
                  >
                    {isLastStep ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Done
                      </>
                    ) : (
                      <>
                        Next
                        <ChevronRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
