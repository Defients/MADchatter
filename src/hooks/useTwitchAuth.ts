import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { TwitchUser } from '../types';
import {
  getTwitchSession,
  setTwitchSession,
  getTwitchClientId,
  buildOAuthUrl,
  validateDevToken,
  setTwitchSessionForBot,
} from '../lib/twitch';
import { useAppStore } from '../store';

// ─── Multi-bot pending-auth tracking (opener-side) ─────────────────────────
// The OAuth callback page is loaded from the deployed madchatter.fun origin.
// An older deployed callback won't forward the `state` param as `botState`, so
// we can't rely on data.botState alone. We record which bot slot a given OAuth
// popup is for here; on success, if botState is absent we fall back to this.
// Shared at module scope so all useTwitchAuth instances agree.
let pendingBotAuth: { botId: string; isNewSlot: boolean } | null = null;

export function useTwitchAuth() {
  const [user, setUser] = useState<TwitchUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginInProgress, setLoginInProgress] = useState(false);

  const fetchMe = useCallback(async () => {
    const session = getTwitchSession();
    if (session) {
      setUser({
        id: session.userId,
        login: session.username,
        display_name: session.username,
        profile_image_url: session.profileImageUrl || '',
        username: session.username,
      });
    } else {
      setUser(null);
    }
    setLoading(false);
    useAppStore.getState().bumpAuthTick();
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const origin = event.origin;
      if (origin !== window.location.origin && !origin.includes('localhost') && !origin.includes('madchatter.fun')) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'OAUTH_AUTH_SUCCESS') {
        setLoginInProgress(false);
        if (data.session) {
          // Resolve the target bot slot: prefer the callback's botState (newer
          // deployed callbacks forward the `state` param), else fall back to the
          // pending bot auth recorded when the popup was opened.
          const targetBotId = data.botState || pendingBotAuth?.botId || null;
          // Multi-bot: if a target slot is resolved, route this token to it
          // instead of overwriting the legacy single-bot session.
          if (targetBotId) {
            const store = useAppStore.getState();
            const newUsername = (data.session.username || '').toLowerCase();
            // Detect re-authorizing the SAME account that's already on another bot.
            // Twitch's OAuth authorizes whichever account is currently logged in
            // on twitch.tv — to add a *different* bot, the user must switch accounts
            // on Twitch first (log out, log into the other account in this browser).
            const dup = store.bots.find(
              (b) => b.id !== targetBotId && b.session?.username?.toLowerCase() === newUsername,
            );
            if (dup) {
              toast.warning(`Same account as @${dup.session?.username}`, {
                description: "Twitch authorized the account you're already logged in with. To add a different bot, use the account switcher / 'Log Out' link on the Twitch authorize page in the popup, then approve with the other account.",
                duration: 8000,
              });
            } else {
              toast.success(`Bot @${data.session.username} connected`);
            }
            setTwitchSessionForBot(targetBotId, data.session);
            useAppStore.getState().bumpAuthTick();
          } else {
            setTwitchSession(data.session);
            await fetchMe();
          }
          pendingBotAuth = null;
        }
      } else if (data.type === 'OAUTH_ERROR') {
        setLoginInProgress(false);
        // If a multi-bot add flow failed, clean up the pending bot slot — but
        // only for newly-created slots (authBot on the primary must NOT remove it).
        const errBotId = data.botState || pendingBotAuth?.botId || null;
        if (errBotId && pendingBotAuth?.isNewSlot) {
          useAppStore.getState().removeBot(errBotId);
        }
        pendingBotAuth = null;
        setLoginError(data.error || 'Authentication failed or was cancelled.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchMe]);

  const login = async () => {
    const clientId = getTwitchClientId();
    if (!clientId) {
      setLoginError('Twitch Client ID not set. Go to Settings and enter your Twitch Client ID.');
      return;
    }

    setLoginInProgress(true);
    setLoginError(null);

    const redirectUri = 'https://madchatter.fun/auth-callback.html';
    const url = buildOAuthUrl(clientId, redirectUri);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, 'TwitchLogin', `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      setLoginError('Popup blocked. Please allow popups for this site or use Dev Token Bypass.');
      setLoginInProgress(false);
      return;
    }
  };

  const loginWithDevToken = async (token: string, username: string) => {
    setLoginInProgress(true);
    setLoginError(null);
    try {
      const session = await validateDevToken(token, username);
      setTwitchSession(session);
      await fetchMe();
    } catch (e: any) {
      setLoginError(e.message || 'Dev token login failed');
    } finally {
      setLoginInProgress(false);
    }
  };

  const logout = async () => {
    setTwitchSession(null);
    localStorage.removeItem('forge_session_id');
    setUser(null);
    useAppStore.getState().bumpAuthTick();
  };

  // ─── Multi-Bot: add another Twitch bot account (additive) ───────────────
  // Creates a new bot slot, then opens OAuth with a `state` param tagging the
  // slot id. The callback (handleMessage above) routes the token to that slot.
  // Legacy login() above is unchanged and writes to the single global session.
  const addBot = async (label?: string) => {
    const clientId = getTwitchClientId();
    if (!clientId) {
      setLoginError('Twitch Client ID not set. Go to Settings and enter your Twitch Client ID.');
      return;
    }

    const platform = useAppStore.getState().platform as "twitch" | "kick" | "joystick";
    const botId = useAppStore.getState().addBot({ label: label || `Bot ${useAppStore.getState().bots.length + 1}`, platform, active: true });
    pendingBotAuth = { botId, isNewSlot: true };

    setLoginInProgress(true);
    setLoginError(null);

    const redirectUri = 'https://madchatter.fun/auth-callback.html';
    const url = buildOAuthUrl(clientId, redirectUri, botId);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, `TwitchLogin_${botId}`, `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      setLoginError('Popup blocked. Please allow popups for this site or use Dev Token Bypass.');
      setLoginInProgress(false);
      useAppStore.getState().removeBot(botId);
    }
  };

  const loginBotAsDevToken = async (botId: string, token: string, username: string) => {
    setLoginInProgress(true);
    setLoginError(null);
    try {
      const session = await validateDevToken(token, username);
      setTwitchSessionForBot(botId, session);
      useAppStore.getState().bumpAuthTick();
    } catch (e: any) {
      setLoginError(e.message || 'Dev token login failed');
    } finally {
      setLoginInProgress(false);
    }
  };

  // Authenticate an EXISTING bot slot (e.g. the auto-seeded primary) by opening
  // OAuth with state=botId. The callback routes the token to that slot. Unlike
  // addBot(), this does not create a new slot.
  const authBot = async (botId: string) => {
    const clientId = getTwitchClientId();
    if (!clientId) {
      setLoginError('Twitch Client ID not set. Go to Settings and enter your Twitch Client ID.');
      return;
    }
    const exists = useAppStore.getState().bots.find((b) => b.id === botId);
    if (!exists) return;
    pendingBotAuth = { botId, isNewSlot: false };

    setLoginInProgress(true);
    setLoginError(null);

    const redirectUri = 'https://madchatter.fun/auth-callback.html';
    const url = buildOAuthUrl(clientId, redirectUri, botId);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, `TwitchLogin_${botId}`, `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      setLoginError('Popup blocked. Please allow popups for this site or use Dev Token Bypass.');
      setLoginInProgress(false);
    }
  };

  const clearLoginError = () => setLoginError(null);

  return { user, loading, loginError, loginInProgress, login, logout, loginWithDevToken, clearLoginError, fetchMe, addBot, authBot, loginBotAsDevToken };
}
