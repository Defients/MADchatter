import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { TwitchUser } from '../types';
import {
  getKickSession,
  setKickSession,
  setKickSessionForBot,
  getKickClientId,
  buildKickOAuthUrl,
  generatePkceChallenge,
  fetchKickUser,
  ensureValidKickSession,
  type KickSession,
} from '../lib/kick';
import { useAppStore } from '../store';

const PKCE_VERIFIER_KEY = 'kick_pkce_verifier';
const OAUTH_STATE_KEY = 'kick_oauth_state';

// ─── Multi-bot pending-auth tracking (opener-side) ─────────────────────────
// The Kick OAuth callback page is loaded from the deployed madchatter.fun
// origin. An older deployed callback may not forward `state`, which would
// both break the CSRF check and lose the botId routing. We record the pending
// bot auth here so we can fall back to it. Shared across useKickAuth instances.
let pendingKickBotAuth: { botId: string; isNewSlot: boolean; state: string } | null = null;

export function useKickAuth() {
  const [user, setUser] = useState<TwitchUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const processingCodeRef = useRef(false);

  const fetchMe = useCallback(async () => {
    // Try to get a valid session — auto-refreshes if token is expired
    const session = await ensureValidKickSession();
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

      if (data.type === 'KICK_AUTH_CODE') {
        if (processingCodeRef.current) return;
        if (sessionStorage.getItem('kick_auth_processing')) return;
        processingCodeRef.current = true;
        sessionStorage.setItem('kick_auth_processing', '1');

        const code = data.code as string;
        // The deployed Kick callback may not forward `state` (older version).
        // Fall back to the pending bot-auth state so CSRF + botId routing still work.
        const state = (data.state as string) || pendingKickBotAuth?.state || '';
        const savedState = localStorage.getItem(OAUTH_STATE_KEY);
        const verifier = localStorage.getItem(PKCE_VERIFIER_KEY);

        if (state !== savedState) {
          console.error('[Kick Auth] State mismatch:', { received: state, saved: savedState });
          processingCodeRef.current = false;
          sessionStorage.removeItem('kick_auth_processing');
          setLoginInProgress(false);
          // Clean up a pending new-slot add if the CSRF check fails.
          if (pendingKickBotAuth?.isNewSlot) {
            useAppStore.getState().removeBot(pendingKickBotAuth.botId);
          }
          pendingKickBotAuth = null;
          setLoginError('OAuth state mismatch — possible CSRF attack. Aborting.');
          return;
        }

        if (!verifier) {
          processingCodeRef.current = false;
          sessionStorage.removeItem('kick_auth_processing');
          setLoginInProgress(false);
          setLoginError('PKCE verifier missing. Please try logging in again.');
          return;
        }

        // Clear immediately to prevent reuse
        localStorage.removeItem(OAUTH_STATE_KEY);
        localStorage.removeItem(PKCE_VERIFIER_KEY);

        try {
          const clientId = getKickClientId();
          const redirectUri = 'https://madchatter.fun/kick-auth-callback.html';
          const clientSecret = import.meta.env.VITE_KICK_CLIENT_SECRET || '1d65cf46b2b732092e9a7cf053832b3bb1c9e02cc377b0bd0d0d896f08f05fee';

          // Use Cloudflare Worker proxy for static sites, fallback to local server for dev
          const tokenProxyUrl = import.meta.env.VITE_KICK_TOKEN_PROXY || 'https://kick-token-proxy.mcmllnt.workers.dev';

          const res = await fetch(tokenProxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code,
              redirect_uri: redirectUri,
              code_verifier: verifier,
              client_id: clientId,
              client_secret: clientSecret,
            }),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Token exchange failed (${res.status}): ${errText}`);
          }

          const tokenData = await res.json();
          const accessToken = tokenData.access_token;

          // Fetch user info (non-fatal — save session even if this fails)
          let kickUser = null;
          try {
            kickUser = await fetchKickUser(accessToken);
          } catch (e) {
            console.warn('[Kick Auth] User fetch failed, continuing with unknown username');
          }
          const session: KickSession = {
            accessToken,
            refreshToken: tokenData.refresh_token,
            username: kickUser?.username || 'unknown',
            userId: kickUser?.id || 'unknown',
            profileImageUrl: kickUser?.profileImageUrl,
            expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
          };
          // Multi-bot: if the OAuth state encodes a botId, route to that slot.
          // Fall back to the pending bot auth if state didn't carry a botId.
          const stateBotId = state.includes('|') ? state.split('|')[0] : null;
          const botId = stateBotId || pendingKickBotAuth?.botId || null;
          if (botId) {
            const store = useAppStore.getState();
            const newUsername = (session.username || '').toLowerCase();
            const dup = store.bots.find(
              (b) => b.id !== botId && b.session?.username?.toLowerCase() === newUsername,
            );
            if (dup) {
              toast.warning(`Same account as @${dup.session?.username}`, {
                description: "Kick authorized the account you're already logged in with. To add a different bot, use the account switcher / log-out option on the Kick authorize page in the popup, then approve with the other account.",
                duration: 8000,
              });
            } else {
              toast.success(`Bot @${session.username} connected`);
            }
            setKickSessionForBot(botId, session);
            useAppStore.getState().bumpAuthTick();
          } else {
            setKickSession(session);
            await fetchMe();
          }
          pendingKickBotAuth = null;
          setLoginInProgress(false);
        } catch (e: any) {
          setLoginInProgress(false);
          setLoginError(e.message || 'Kick token exchange failed');
        } finally {
          processingCodeRef.current = false;
          sessionStorage.removeItem('kick_auth_processing');
        }
      } else if (data.type === 'KICK_AUTH_ERROR') {
        setLoginInProgress(false);
        // Clean up a pending multi-bot slot if its state encoded a botId — but
        // only for newly-created slots (authKickBot on the primary must not remove it).
        const errState = (data.state as string) || pendingKickBotAuth?.state || '';
        const botId = errState.includes('|') ? errState.split('|')[0] : null;
        if (botId && pendingKickBotAuth?.isNewSlot) useAppStore.getState().removeBot(botId);
        pendingKickBotAuth = null;
        setLoginError(data.error || 'Kick authentication failed or was cancelled.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchMe]);

  const login = async () => {
    const clientId = getKickClientId();
    if (!clientId) {
      setLoginError('Kick Client ID not set. Go to Settings and enter your Kick Client ID.');
      return;
    }

    setLoginInProgress(true);
    setLoginError(null);
    processingCodeRef.current = false;
    sessionStorage.removeItem('kick_auth_processing');

    const redirectUri = 'https://madchatter.fun/kick-auth-callback.html';
    const { verifier, challenge } = await generatePkceChallenge();
    const state = crypto.randomUUID();

    localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    localStorage.setItem(OAUTH_STATE_KEY, state);

    const url = buildKickOAuthUrl(clientId, redirectUri, challenge, state);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, 'KickLogin', `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      setLoginError('Popup blocked. Please allow popups for this site.');
      setLoginInProgress(false);
      return;
    }
  };

  const loginWithDevToken = async (token: string, username: string) => {
    setLoginInProgress(true);
    setLoginError(null);
    try {
      const kickUser = await fetchKickUser(token);
      const session: KickSession = {
        accessToken: token,
        username: kickUser?.username || username,
        userId: kickUser?.id || username,
      };
      setKickSession(session);
      await fetchMe();
    } catch (e: any) {
      setLoginError(e.message || 'Kick dev token login failed');
    } finally {
      setLoginInProgress(false);
    }
  };

  const logout = async () => {
    setKickSession(null);
    localStorage.removeItem('forge_session_id');
    setUser(null);
    useAppStore.getState().bumpAuthTick();
  };

  // ─── Multi-Bot: add another Kick bot account (additive) ──────────────────
  // Encodes the botId into the OAuth state as `${botId}|${uuid}` so the
  // callback handler can route the resulting session to the right slot.
  const addKickBot = async (label?: string) => {
    const clientId = getKickClientId();
    if (!clientId) {
      setLoginError('Kick Client ID not set. Go to Settings and enter your Kick Client ID.');
      return;
    }

    const botId = useAppStore.getState().addBot({ label: label || `Bot ${useAppStore.getState().bots.length + 1}`, platform: 'kick', active: true });

    setLoginInProgress(true);
    setLoginError(null);
    processingCodeRef.current = false;
    sessionStorage.removeItem('kick_auth_processing');

    const redirectUri = 'https://madchatter.fun/kick-auth-callback.html';
    const { verifier, challenge } = await generatePkceChallenge();
    const state = `${botId}|${crypto.randomUUID()}`;

    localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    localStorage.setItem(OAUTH_STATE_KEY, state);
    pendingKickBotAuth = { botId, isNewSlot: true, state };

    const url = buildKickOAuthUrl(clientId, redirectUri, challenge, state);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, `KickLogin_${botId}`, `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      setLoginError('Popup blocked. Please allow popups for this site.');
      setLoginInProgress(false);
      useAppStore.getState().removeBot(botId);
    }
  };

  // Authenticate an EXISTING Kick bot slot (e.g. the auto-seeded primary) by
  // opening OAuth with state=`${botId}|${uuid}`. Does not create a new slot.
  const authKickBot = async (botId: string) => {
    const clientId = getKickClientId();
    if (!clientId) {
      setLoginError('Kick Client ID not set. Go to Settings and enter your Kick Client ID.');
      return;
    }
    const exists = useAppStore.getState().bots.find((b) => b.id === botId);
    if (!exists) return;

    setLoginInProgress(true);
    setLoginError(null);
    processingCodeRef.current = false;
    sessionStorage.removeItem('kick_auth_processing');

    const redirectUri = 'https://madchatter.fun/kick-auth-callback.html';
    const { verifier, challenge } = await generatePkceChallenge();
    const state = `${botId}|${crypto.randomUUID()}`;

    localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    localStorage.setItem(OAUTH_STATE_KEY, state);
    pendingKickBotAuth = { botId, isNewSlot: false, state };

    const url = buildKickOAuthUrl(clientId, redirectUri, challenge, state);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, `KickLogin_${botId}`, `width=${width},height=${height},left=${left},top=${top}`);
    if (!popup) {
      setLoginError('Popup blocked. Please allow popups for this site.');
      setLoginInProgress(false);
    }
  };

  const clearLoginError = () => setLoginError(null);

  return { user, loading, loginError, loginInProgress, login, logout, loginWithDevToken, clearLoginError, fetchMe, addKickBot, authKickBot };
}
