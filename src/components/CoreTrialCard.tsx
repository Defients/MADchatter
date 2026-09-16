/**
 * CoreTrialCard — Friend Trial activation card for CORE mode's "Choose the
 * brain" step (Step 3).
 *
 * The Friend Trial routes AI requests through a MADchatter-hosted Cloudflare
 * Worker using a server-held Groq key — no BYOK required. This card lets the
 * user start, see the status of, and deactivate the trial directly from CORE
 * mode without opening Studio's Settings panel.
 *
 * Auto-select: when a valid trial session exists, the parent CoreSetup
 * auto-selects the trial as the active provider so the AI step is skipped
 * (the trial counts as a configured provider via getApiKey("trial")). This
 * card surfaces the trial in CORE so the user can activate/deactivate it.
 */
import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Loader2, Sparkles, AlertCircle, ExternalLink } from "lucide-react";
import { cn } from "../lib/utils";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { setActiveProvider, TRIAL_PROVIDER, getProviderWithKey } from "../lib/keys";
import {
  getTrialWorkerUrl, setTrialWorkerUrl,
  getTrialTurnstileSiteKey, setTrialTurnstileSiteKey,
  isTrialSessionValid, clearTrialSession, setTrialSession,
  fetchTrialStatus, createTrialSession,
  loadTurnstileScript, renderTurnstile, removeTurnstile,
  TURNSTILE_TEST_SITE_KEY, type TrialStatus,
} from "../lib/trial";
import { playSfx } from "../lib/sfx";

interface CoreTrialCardProps {
  /** True when the trial is the active provider. */
  isActive: boolean;
  /** Called after a successful activation so the parent can refresh. */
  onActivated?: () => void;
  /** Called after deactivation so the parent can refresh. */
  onDeactivated?: () => void;
}

export function CoreTrialCard({ isActive, onActivated, onDeactivated }: CoreTrialCardProps) {
  const bumpTrialTick = useAppStore((s) => s.bumpTrialTick);
  const setTrialStatusState = useAppStore((s) => s.setTrialStatus);
  const trialStatus = useAppStore((s) => s.trialStatus);
  const trialTick = useAppStore((s) => s.trialTick);

  const [workerUrl, setWorkerUrlState] = useState(getTrialWorkerUrl());
  const [siteKey, setSiteKeyState] = useState(getTrialTurnstileSiteKey());
  const [inviteCode, setInviteCode] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);

  // Re-read session validity when trialTick changes (activation/deactivation
  // in other tabs or the Settings panel bumps it).
  const sessionValid = isTrialSessionValid();

  // Fetch trial status when the worker URL is set and we don't have it yet.
  useEffect(() => {
    const url = getTrialWorkerUrl();
    if (!url || trialStatus) return;
    let cancelled = false;
    fetchTrialStatus(url)
      .then((status) => { if (!cancelled) setTrialStatusState(status); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [trialStatus, setTrialStatusState, trialTick]);

  const handleActivate = async () => {
    setError(null);
    const url = workerUrl.trim().replace(/\/+$/, "");
    if (!url) {
      setError("Set the Friend Trial Worker URL first.");
      setShowConfig(true);
      return;
    }
    setTrialWorkerUrl(url);
    setActivating(true);
    try {
      const status = await fetchTrialStatus(url);
      setTrialStatusState(status);
      if (!status.enabled) {
        setError(status.reason === "ENDED" ? "Friend Trial has ended." : "Friend Trial is currently unavailable.");
        setActivating(false);
        return;
      }
      const key = siteKey.trim() || TURNSTILE_TEST_SITE_KEY;
      setTrialTurnstileSiteKey(key);
      loadTurnstileScript();
      let attempts = 0;
      while (!(window as any).turnstile && attempts < 50) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }
      if (!(window as any).turnstile || !turnstileRef.current) {
        setError("Could not load human verification. Check your connection and try again.");
        setActivating(false);
        return;
      }
      removeTurnstile(turnstileRef.current);
      const turnstileToken = await renderTurnstile(turnstileRef.current, key);
      const result = await createTrialSession(url, turnstileToken, status.requiresInviteCode ? inviteCode.trim() : undefined);
      if (!result.ok || !result.token || !result.expiresAt) {
        setError(result.error || "Failed to start Friend Trial.");
        removeTurnstile(turnstileRef.current);
        setActivating(false);
        return;
      }
      setTrialSession(result.token, result.expiresAt);
      setActiveProvider(TRIAL_PROVIDER);
      bumpTrialTick();
      toast.success("Friend Trial active — no API key required.");
      playSfx("welcome_dismiss");
      removeTurnstile(turnstileRef.current);
      onActivated?.();
    } catch (e) {
      setError((e as Error).message || "Failed to start Friend Trial.");
      if (turnstileRef.current) removeTurnstile(turnstileRef.current);
    } finally {
      setActivating(false);
    }
  };

  const handleDeactivate = () => {
    clearTrialSession();
    bumpTrialTick();
    // Fall back to a BYOK provider if one has a key.
    const providerWithKey = getProviderWithKey();
    if (providerWithKey && providerWithKey !== TRIAL_PROVIDER) {
      setActiveProvider(providerWithKey);
    }
    toast.success("Friend Trial deactivated.");
    playSfx("welcome_dismiss");
    onDeactivated?.();
  };

  const trialEnabled = trialStatus?.enabled ?? true;
  const needsConfig = !getTrialWorkerUrl();

  return (
    <div className={cn(
      "w-full p-4 rounded-xl border-2 text-left transition-all",
      sessionValid && isActive
        ? "border-amber-500/40 bg-amber-500/[0.06]"
        : "border-amber-500/20 bg-amber-500/[0.03] hover:border-amber-500/30",
    )}>
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
          sessionValid ? "bg-amber-500/15 text-amber-400" : "bg-amber-500/10 text-amber-500",
        )}>
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-gray-200 flex items-center gap-2">
            Friend Trial
            {sessionValid && (
              <span className="text-[9px] font-bold uppercase text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded">Active</span>
            )}
            {!trialEnabled && trialStatus && (
              <span className="text-[9px] font-bold uppercase text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded">Ended</span>
            )}
          </div>
          <div className="text-[11px] text-gray-500">
            {sessionValid
              ? "No API key needed — powered by MADchatter"
              : needsConfig
                ? "Free trial · needs Worker URL"
                : trialEnabled
                  ? "Free trial · tap to start (no API key)"
                  : "Trial ended — add your own key"}
          </div>
        </div>
        {/* Status indicator on the right */}
        {sessionValid && isActive ? (
          <span className="text-[9px] font-bold uppercase text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded shrink-0">Active</span>
        ) : sessionValid ? (
          <ChevronRight className="w-4 h-4 text-amber-400" />
        ) : null}
      </div>

      {/* Deffy's welcome message — a personal note from the developer */}
      <div className="mt-3 rounded-lg border border-amber-500/15 bg-gradient-to-br from-amber-500/[0.07] to-amber-600/[0.03] px-3.5 py-3">
        <div className="flex items-start gap-2.5">
          <span className="text-lg leading-none mt-0.5">👋</span>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-amber-300/90">Hey, Deffy here</div>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-200/60">
              Trial's on me. Fire up MADchatter, try MULTI-BOT, and cause a little beautiful chaos. <span className="font-bold" style={{ color: "#ff69b4" }}>PYAH!</span>
            </p>
          </div>
        </div>
      </div>

      {/* Active session — show deactivate */}
      {sessionValid && (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-[10px] text-amber-300/80 flex-1">
            <Check className="w-3 h-3 shrink-0" />
            <span>Trial session active — no expiration</span>
          </div>
          <button
            type="button"
            onClick={handleDeactivate}
            className="px-2 py-1 rounded bg-red-500/15 border border-red-500/25 text-red-300 hover:bg-red-500/25 text-[9px] font-bold uppercase tracking-wider transition-colors"
          >
            Deactivate
          </button>
        </div>
      )}

      {/* Inactive — show activate button + config toggle */}
      {!sessionValid && trialEnabled && (
        <>
          {/* Config (Worker URL + site key) — collapsible */}
          {showConfig && (
            <div className="mt-3 space-y-2 p-2.5 rounded-lg bg-black/30 border border-amber-500/15">
              <div className="space-y-1">
                <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Worker URL</span>
                <input
                  type="text"
                  value={workerUrl}
                  onChange={(e) => { setWorkerUrlState(e.target.value); setTrialWorkerUrl(e.target.value); }}
                  className="w-full bg-black/40 border border-amber-500/20 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500/50 text-white placeholder-gray-700 font-mono"
                  placeholder="https://friend-trial.<account>.workers.dev"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Turnstile Site Key (optional)</span>
                <input
                  type="text"
                  value={siteKey}
                  onChange={(e) => { setSiteKeyState(e.target.value); setTrialTurnstileSiteKey(e.target.value); }}
                  className="w-full bg-black/40 border border-amber-500/20 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500/50 text-white placeholder-gray-700 font-mono"
                  placeholder="0x4AAAAAAA... (blank = test key)"
                />
              </div>
              {trialStatus?.requiresInviteCode && (
                <div className="space-y-1">
                  <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Invite Code</span>
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    className="w-full bg-black/40 border border-amber-500/20 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500/50 text-white placeholder-gray-700 font-mono"
                    placeholder="Enter invite code"
                  />
                </div>
              )}
            </div>
          )}

          {/* Turnstile widget container */}
          <div ref={turnstileRef} />

          {/* Error message */}
          {error && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[10px] leading-relaxed bg-red-500/10 border border-red-500/25 text-red-300">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleActivate}
              disabled={activating || !workerUrl.trim()}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs font-bold uppercase tracking-wider text-amber-300 hover:bg-amber-500/20 hover:border-amber-400/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {activating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {activating ? "Starting…" : "Start Friend Trial"}
            </button>
            <button
              type="button"
              onClick={() => setShowConfig((s) => !s)}
              className="px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:bg-white/10 hover:text-gray-300 transition-colors"
            >
              {showConfig ? "Hide" : "Config"}
            </button>
          </div>

          {/* Toggle to show config when Worker URL is missing */}
          {!getTrialWorkerUrl() && !showConfig && (
            <button
              type="button"
              onClick={() => setShowConfig(true)}
              className="mt-1.5 text-[10px] text-amber-400/60 hover:text-amber-400 flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Set the Worker URL first
            </button>
          )}
        </>
      )}
    </div>
  );
}
