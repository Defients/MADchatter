import { useEffect, useSyncExternalStore } from "react";
import { Bot, Bomb, ShieldAlert, X } from "lucide-react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { abortSelfSabotage, selfSabotageController } from "../lib/selfSabotage";
import { SELF_SABOTAGE_CONFIG, type SelfSabotageState } from "../lib/selfSabotageCore";

const STATE_LABELS: Record<SelfSabotageState, string> = {
  DORMANT: "DORMANT",
  ELIGIBLE: "INITIALIZING...",
  ANNOUNCEMENT: "SUSPICIOUS ANNOUNCEMENT",
  DOGPILE: "SOCIAL COVER DEGRADING",
  HESITATION: "INSTIGATOR PANIC",
  IMPOSSIBLE_SEND: "TIMING ANOMALY",
  CONTAGION: "CONTAGION DETECTED",
  CONFESSION_CASCADE: "MULTI-BOT COVER FAILURE",
  OVERDRIVE: "OVERDRIVE",
  PAYLOAD_READY: "PAYLOAD READY",
  PAYLOAD_FIRED: "PAYLOAD FIRED",
  RESET: "RESTORING PLAUSIBLE DENIABILITY",
  AFTERSHOCK: "INCIDENT? WHAT INCIDENT?",
  ABORTED: "EVENT ABORTED - LOCKS CLEARED",
};

export function SelfSabotageHUD() {
  const snapshot = useSyncExternalStore(
    selfSabotageController.subscribe,
    selfSabotageController.getSnapshot,
    selfSabotageController.getSnapshot,
  );
  const familyCopy = useAppStore((state) => state.config.toxicityFilter === "family");

  useEffect(() => {
    document.documentElement.classList.toggle("self-sabotage-active", snapshot.active);
    return () => document.documentElement.classList.remove("self-sabotage-active");
  }, [snapshot.active]);

  useEffect(() => () => {
    if (selfSabotageController.isActive()) abortSelfSabotage("ui_unmounted");
  }, []);

  if (!snapshot.active) return null;
  const progress = Math.max(0, Math.min(100, snapshot.coverIntegrity));
  const coverLabel = progress === 0
    ? (familyCopy ? SELF_SABOTAGE_CONFIG.copy.terminalCoverClean : SELF_SABOTAGE_CONFIG.copy.terminalCover)
    : `COVER INTEGRITY ${progress}%`;

  return (
    <aside
      className={cn(
        "self-sabotage-hud fixed z-[9990] overflow-hidden border border-fuchsia-400/40 bg-[#09080f]/95 shadow-[0_0_45px_rgba(217,70,239,0.2)] backdrop-blur-xl",
        snapshot.mobile
          ? "inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] rounded-2xl"
          : "right-5 top-20 w-[min(360px,calc(100vw-2.5rem))] rounded-2xl",
      )}
      role="status"
      aria-live="polite"
      aria-label="SELF-SAB-BOT-AGE event status"
    >
      <div className="self-sabotage-scanline pointer-events-none absolute inset-0 opacity-20" aria-hidden="true" />
      <div className="relative p-3.5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 p-2 text-fuchsia-300">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-black uppercase tracking-[0.24em] text-fuchsia-300">
              SELF-SAB-BOT-AGE
            </div>
            <div className="mt-0.5 truncate font-mono text-xs font-bold uppercase tracking-wider text-white">
              {STATE_LABELS[snapshot.state]}
            </div>
          </div>
          <button
            type="button"
            onClick={() => abortSelfSabotage("operator_abort")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-400 transition-colors hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            aria-label="Abort SELF-SAB-BOT-AGE"
            title="Abort event"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between font-mono text-[9px] font-bold uppercase tracking-widest">
            <span className={progress <= 20 ? "text-red-300" : "text-gray-400"}>{coverLabel}</span>
            <span className="text-gray-600">{snapshot.remainingMessageBudget} msgs remain</span>
          </div>
          <div
            className="mt-1.5 h-2 overflow-hidden rounded-full border border-white/10 bg-black/60"
            role="progressbar"
            aria-label="Cover integrity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div
              className={cn(
                "h-full origin-left rounded-full transition-[width,background-color] duration-500",
                progress > 55 ? "bg-cyan-400" : progress > 20 ? "bg-amber-400" : "bg-red-500",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Event participants">
          {snapshot.participants.map((participant) => (
            <span
              key={participant.id}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 font-mono text-[9px] uppercase tracking-wide",
                snapshot.currentSpeakerId === participant.id
                  ? "border-cyan-300/60 bg-cyan-400/15 text-cyan-200"
                  : participant.confessed
                    ? "border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200"
                    : "border-white/10 bg-white/[0.03] text-gray-500",
              )}
              title={participant.role.replaceAll("_", " ")}
            >
              <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{participant.username}</span>
              {participant.confessed && <span aria-label="compromised">!</span>}
            </span>
          ))}
        </div>

        {(snapshot.state === "PAYLOAD_READY" || snapshot.state === "PAYLOAD_FIRED") && (
          <button
            type="button"
            disabled={snapshot.state !== "PAYLOAD_READY" || snapshot.payloadFiring || snapshot.payloadFired}
            onClick={() => selfSabotageController.requestPayloadFire()}
            className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-400/50 bg-gradient-to-r from-red-600/80 to-fuchsia-600/80 px-4 py-2.5 font-mono text-xs font-black uppercase tracking-[0.16em] text-white shadow-[0_0_20px_rgba(239,68,68,0.2)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Bomb className="h-4 w-4" aria-hidden="true" />
            {snapshot.payloadFiring ? "FIRING..." : snapshot.payloadFired ? "COVER BLOWN" : "BLOW THE COVER"}
          </button>
        )}
      </div>
    </aside>
  );
}
