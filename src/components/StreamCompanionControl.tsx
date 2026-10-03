import { useId, useState } from "react";
import { ChevronDown, Radio, Users } from "lucide-react";
import { useAppStore } from "../store";
import { useNowTick } from "../hooks/useNowTick";
import { companionBotCount, getCompanionReceipt } from "../lib/streamCompanionRuntime";
import { cn } from "../lib/utils";

/** One shared preference, rendered on every operational surface. No engine mutations on mount. */
export function StreamCompanionControl() {
  const profile = useAppStore(s => s.participationProfile);
  const setProfile = useAppStore(s => s.setParticipationProfile);
  const limits = useAppStore(s => s.rateLimitConfig);
  const now = useNowTick(profile === "stream_companion");
  const id = useId();
  const descriptionId = `${id}-description`;
  const detailsId = `${id}-details`;
  const statusId = `${id}-status`;
  const [expanded, setExpanded] = useState(false);
  const enabled = profile === "stream_companion";
  const receipt = getCompanionReceipt("operator-status", now);
  const count = companionBotCount();
  const constrained = limits.maxActionsPerHour < 30 || limits.maxActionsPerTenMinutes < 8 || limits.minCooldownMs > 15_000;
  return (
    <div className={cn("overflow-hidden rounded-xl border text-xs", enabled ? "border-cyan-400/15 bg-cyan-400/[0.025]" : "border-white/[0.07] bg-black/20")}>
      <div className="flex items-center gap-1 px-2 py-0.5">
        <button type="button" aria-label="Stream Companion details" aria-expanded={expanded}
          aria-controls={detailsId} aria-describedby={statusId}
          onClick={() => setExpanded(open => !open)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
          <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", enabled ? "bg-cyan-400/10 text-cyan-300" : "bg-white/5 text-gray-500")}>
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-semibold text-gray-200">Stream Companion</span>
            <span id={statusId} title={receipt.reason} className={cn("block truncate text-[10px] leading-4", enabled && receipt.eligible ? "text-cyan-300/80" : "text-gray-500")}>{receipt.reason}</span>
          </span>
          <ChevronDown aria-hidden="true" className={cn("mr-1 h-3 w-3 shrink-0 text-gray-500", expanded && "rotate-180")} />
        </button>
        <button type="button" role="switch" aria-label="Stream Companion" aria-checked={enabled}
          aria-describedby={descriptionId}
          onClick={() => setProfile(enabled ? "standard" : "stream_companion")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
          <span className={cn("relative flex h-6 w-11 items-center rounded-full border text-[8px] font-bold tracking-wide", enabled ? "border-cyan-400/35 bg-cyan-400/15 text-cyan-200" : "border-white/10 bg-white/5 text-gray-500")}>
            <span className={enabled ? "ml-1.5" : "ml-auto mr-1"}>{enabled ? "ON" : "OFF"}</span>
            <span aria-hidden="true" className={cn("absolute h-3.5 w-3.5 rounded-full", enabled ? "right-1 bg-cyan-200 shadow-[0_0_8px_rgba(103,232,249,0.25)]" : "left-1 bg-gray-500")} />
          </span>
        </button>
      </div>
      <div id={detailsId} hidden={!expanded} className="border-t border-white/[0.06] px-3 pb-2.5 pt-2">
        <p id={descriptionId} className="text-[11px] leading-relaxed text-gray-400">Participate from streamer speech and visuals, even when chat is quiet.</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] text-gray-400">
          <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" aria-hidden="true" />{count} {count === 1 ? "bot" : "bots"}</span>
          <span><span className="font-mono text-gray-200">{receipt.contributionsLastHour}/30</span> per hour</span>
          <span><span className="font-mono text-gray-200">{receipt.contributionsLastTenMin}/8</span> per 10 min</span>
        </div>
        <p className="mt-1 text-[9px] text-gray-500">One shared budget across all bots.</p>
        {constrained && <p className="mt-1.5 text-[10px] text-amber-300/90">Your existing limits may slow this pace.</p>}
      </div>
    </div>
  );
}
