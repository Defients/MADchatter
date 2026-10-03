import { useId } from "react";
import { useAppStore } from "../store";
import { useNowTick } from "../hooks/useNowTick";
import { companionBotCount, getCompanionReceipt } from "../lib/streamCompanionRuntime";

/** One shared preference, rendered on every operational surface. No engine mutations on mount. */
export function StreamCompanionControl() {
  const profile = useAppStore(s => s.participationProfile);
  const setProfile = useAppStore(s => s.setParticipationProfile);
  const limits = useAppStore(s => s.rateLimitConfig);
  const now = useNowTick(profile === "stream_companion");
  const descriptionId = useId();
  const enabled = profile === "stream_companion";
  const receipt = getCompanionReceipt("operator-status", now);
  const count = companionBotCount();
  const constrained = limits.maxActionsPerHour < 30 || limits.maxActionsPerTenMinutes < 8 || limits.minCooldownMs > 15_000;
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold text-gray-200">Stream Companion</span>
        <button type="button" role="switch" aria-label="Stream Companion" aria-checked={enabled}
          aria-describedby={descriptionId}
          onClick={() => setProfile(enabled ? "standard" : "stream_companion")}
          className="min-h-11 min-w-16 rounded-md border border-white/20 px-3 font-semibold text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">
          {enabled ? "ON" : "OFF"}
        </button>
      </div>
      <p id={descriptionId} className="mt-1 text-gray-400">Participate from streamer speech and visuals, even when chat is quiet.</p>
      {enabled && <div className="mt-2 space-y-1 text-[11px] text-gray-300">
        <p>{receipt.reason}</p>
        <p className="text-gray-400">{count} {count === 1 ? "bot" : "bots"} · shared {receipt.contributionsLastHour}/30 per hour · {receipt.contributionsLastTenMin}/8 per 10 min</p>
        {constrained && <p className="text-amber-300">Your existing limits may slow this pace.</p>}
      </div>}
    </div>
  );
}
