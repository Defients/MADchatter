import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { getActiveProvider, getProviderWithKey, setActiveProvider, TRIAL_PROVIDER } from "../lib/keys";
import {
  clearTrialSession,
  createTrialSession,
  fetchTrialStatus,
  fetchTrialUsage,
  getTrialUsageTone,
  getTrialTurnstileSiteKey,
  getTrialWorkerUrl,
  isTrialSessionValid,
  loadTurnstileScript,
  removeTurnstile,
  renderTurnstile,
  setTrialSession,
} from "../lib/trial";
import { shouldShowMobileFriendTrial } from "../lib/mobileOnboarding";
import { playSfx } from "../lib/sfx";
import { cn } from "../lib/utils";

export function MobileFriendTrialCard() {
  const trialStatus = useAppStore((state) => state.trialStatus);
  const setTrialStatus = useAppStore((state) => state.setTrialStatus);
  const trialTick = useAppStore((state) => state.trialTick);
  const bumpTrialTick = useAppStore((state) => state.bumpTrialTick);
  const trialUsage = useAppStore((state) => state.trialUsage);
  const trialUsageLoading = useAppStore((state) => state.trialUsageLoading);
  const setTrialUsageLoading = useAppStore((state) => state.setTrialUsageLoading);
  useAppStore((state) => state.authTick);

  const [inviteCode, setInviteCode] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activatingRef = useRef(false);
  const turnstileRef = useRef<HTMLDivElement>(null);

  const workerUrl = getTrialWorkerUrl();
  const siteKey = getTrialTurnstileSiteKey();
  const sessionValid = isTrialSessionValid();
  const isActive = sessionValid && getActiveProvider() === TRIAL_PROVIDER;
  const recommendedForNewUser = !sessionValid && !getProviderWithKey();

  useEffect(() => {
    if (!workerUrl || trialStatus) return;
    let cancelled = false;
    fetchTrialStatus(workerUrl)
      .then((status) => {
        if (!cancelled) setTrialStatus(status);
      })
      .catch(() => {
        // No authoritative availability means no onboarding card.
      });
    return () => {
      cancelled = true;
    };
  }, [workerUrl, trialStatus, setTrialStatus, trialTick]);

  useEffect(() => () => {
    if (turnstileRef.current) removeTurnstile(turnstileRef.current);
  }, []);

  useEffect(() => {
    if (!sessionValid || !workerUrl) return;
    let cancelled = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    setTrialUsageLoading(true);
    fetchTrialUsage(workerUrl)
      .then((usage) => {
        if (cancelled || !usage) return;
        const delay = Math.max(1_000, Date.parse(usage.resetAt) - Date.now() + 1_000);
        resetTimer = setTimeout(() => {
          if (!cancelled) void fetchTrialUsage(workerUrl).catch(() => {});
        }, Math.min(delay, 2_147_483_647));
      })
      .catch(() => {
        // Keep the active session usable; the Worker remains authoritative.
      })
      .finally(() => {
        if (!cancelled) setTrialUsageLoading(false);
      });
    return () => {
      cancelled = true;
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, [sessionValid, workerUrl, setTrialUsageLoading]);

  const visible = shouldShowMobileFriendTrial({
    workerConfigured: !!workerUrl,
    turnstileConfigured: !!siteKey,
    status: trialStatus,
    sessionValid,
  });

  if (!visible) return null;

  const getTurnstileToken = async (requiresTurnstile: boolean): Promise<string> => {
    if (!requiresTurnstile) return "";
    if (!siteKey || !turnstileRef.current) {
      throw new Error("Human verification is not configured.");
    }
    loadTurnstileScript();
    let attempts = 0;
    while (!(window as any).turnstile && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts += 1;
    }
    if (!(window as any).turnstile) {
      throw new Error("Could not load human verification. Check your connection and try again.");
    }
    removeTurnstile(turnstileRef.current);
    return renderTurnstile(turnstileRef.current, siteKey);
  };

  const handleActivate = async () => {
    if (activatingRef.current) return;
    activatingRef.current = true;
    setActivating(true);
    setError(null);
    try {
      const currentStatus = await fetchTrialStatus(workerUrl);
      setTrialStatus(currentStatus);
      if (!currentStatus.enabled) {
        setError(currentStatus.reason === "ENDED" ? "Friend Trial has ended." : "Friend Trial is currently unavailable.");
        return;
      }
      if (currentStatus.requiresInviteCode && !inviteCode.trim()) {
        setError("Enter your invite code to start Friend Trial.");
        return;
      }

      const turnstileToken = await getTurnstileToken(currentStatus.requiresTurnstile);
      const result = await createTrialSession(
        workerUrl,
        turnstileToken,
        currentStatus.requiresInviteCode ? inviteCode.trim() : undefined,
      );
      if (!result.ok || !result.token || !result.expiresAt) {
        setError(result.error || "Failed to start Friend Trial.");
        return;
      }

      setTrialSession(result.token, result.expiresAt);
      setActiveProvider(TRIAL_PROVIDER);
      bumpTrialTick();
      toast.success("Friend Trial active — no API key required.");
      playSfx("welcome_dismiss");
    } catch (caught) {
      setError((caught as Error).message || "Failed to start Friend Trial.");
    } finally {
      if (turnstileRef.current) removeTurnstile(turnstileRef.current);
      activatingRef.current = false;
      setActivating(false);
    }
  };

  const handleDeactivate = () => {
    clearTrialSession();
    const providerWithKey = getProviderWithKey();
    if (providerWithKey && providerWithKey !== TRIAL_PROVIDER) {
      setActiveProvider(providerWithKey);
    }
    bumpTrialTick();
    setError(null);
    toast.success("Friend Trial deactivated. Your saved provider keys are unchanged.");
    playSfx("welcome_dismiss");
  };

  const handleUseTrial = () => {
    setActiveProvider(TRIAL_PROVIDER);
    bumpTrialTick();
    toast.success("Friend Trial is now the active provider.");
    playSfx("palette_select");
  };

  const usageTone = trialUsage ? getTrialUsageTone(trialUsage.remaining) : null;
  const usageColor = usageTone === "empty"
    ? "bg-red-400"
    : usageTone === "critical"
      ? "bg-orange-400"
      : usageTone === "low"
        ? "bg-amber-400"
        : usageTone === "watch"
          ? "bg-cyan-400"
          : "bg-emerald-400";

  return (
    <div
      data-mobile-friend-trial
      className={cn(
        "rounded-xl border p-3.5",
        sessionValid
          ? "border-amber-400/35 bg-gradient-to-br from-amber-500/[0.10] to-purple-500/[0.05]"
          : "border-amber-500/25 bg-gradient-to-br from-amber-500/[0.07] to-cyan-500/[0.03]",
        recommendedForNewUser && "border-amber-300/50 ring-1 ring-amber-400/20 shadow-[0_0_24px_rgba(251,191,36,0.10)]",
      )}
    >
      {recommendedForNewUser && (
        <div className="mb-2 flex justify-end">
          <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.14em] text-cyan-200">
            Recommended first step
          </span>
        </div>
      )}
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
          {sessionValid ? <Check className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-black uppercase tracking-wider text-amber-200">
              {isActive ? "Friend Trial Active" : sessionValid ? "Friend Trial Ready" : "Friend Trial"}
            </span>
            <span className="rounded border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-300">
              {isActive ? "Active" : sessionValid ? "Ready" : "Free"}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-gray-400">
            {isActive
              ? "No API key required."
              : sessionValid
                ? "Session ready—switch back without an API key."
                : "Try MADchatter without adding an API key."}
          </p>
          {!sessionValid && trialStatus?.mobileDailyLimit && (
            <p className="mt-1 text-[10px] font-semibold text-cyan-200/70">
              {trialStatus.mobileDailyLimit} free Trial Uses each day
            </p>
          )}
          {!sessionValid && (
            <p className="mt-1.5 text-[10px] italic text-amber-200/60">
              Trial's on me. See what MADchatter can do. <span className="font-black text-pink-400">PYAH!</span>
            </p>
          )}
        </div>
      </div>

      {!sessionValid && trialStatus?.requiresInviteCode && (
        <label className="mt-3 block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-gray-400">Invite code</span>
          <input
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            disabled={activating}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white placeholder-gray-600 focus:border-amber-400/50 focus:outline-none focus:ring-1 focus:ring-amber-400/30 disabled:opacity-60"
            placeholder="Enter invite code"
          />
        </label>
      )}

      <div ref={turnstileRef} className="mt-2 overflow-hidden" />

      {sessionValid && (trialUsage || trialUsageLoading) && (
        <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/20 p-2.5" data-trial-usage-meter>
          {trialUsage ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn(
                  "text-[11px] font-black uppercase tracking-wide",
                  usageTone === "empty" ? "text-red-300" : usageTone === "critical" ? "text-orange-300" : usageTone === "low" ? "text-amber-300" : "text-emerald-300",
                )}>
                  {trialUsage.remaining} / {trialUsage.limit} Trial Uses left
                </span>
                <span className="text-[9px] text-gray-500">Resets at 12:00 PM ET</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]" role="progressbar" aria-label="Friend Trial daily uses remaining" aria-valuemin={0} aria-valuemax={trialUsage.limit} aria-valuenow={trialUsage.remaining}>
                <div
                  className={cn("h-full rounded-full transition-[width,background-color]", usageColor)}
                  style={{ width: `${Math.max(0, Math.min(100, (trialUsage.remaining / trialUsage.limit) * 100))}%` }}
                />
              </div>
              <p className="mt-1.5 text-[9px] text-gray-500">Text uses 1 · Vision uses 2</p>
              {usageTone === "empty" && (
                <p className="mt-1.5 text-[10px] leading-snug text-red-300/90">
                  Today’s Friend Trial is used up. Keep this provider active and it will be ready again after the reset, or switch to your own provider.
                </p>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-[10px] text-gray-500">
              <Loader2 className="h-3 w-3 animate-spin" /> Refreshing today’s allowance…
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-red-300">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {sessionValid ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[10px] text-emerald-300/80">
            {isActive ? "Current AI provider" : "Session ready"}
          </span>
          <div className="flex items-center gap-2">
            {!isActive && (
              <button
                type="button"
                onClick={handleUseTrial}
                className="min-h-9 rounded-lg border border-amber-400/35 bg-amber-500/15 px-3 text-[10px] font-black uppercase tracking-wider text-amber-200 transition-colors hover:bg-amber-500/25"
              >
                Use Trial
              </button>
            )}
            <button
              type="button"
              onClick={handleDeactivate}
              className="min-h-9 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[10px] font-bold text-gray-400 transition-colors hover:border-red-400/30 hover:text-red-300"
            >
              Deactivate
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleActivate}
          disabled={activating}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-amber-400/35 bg-amber-500/15 px-3 text-[11px] font-black uppercase tracking-wider text-amber-200 transition-colors hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-60"
        >
          {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {activating ? "Starting…" : "Start Friend Trial"}
        </button>
      )}
    </div>
  );
}
