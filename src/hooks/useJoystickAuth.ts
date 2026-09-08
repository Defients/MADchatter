import { useState, useEffect, useCallback, useRef } from 'react';
import { TwitchUser } from '../types';
import {
  getJoystickSession,
  setJoystickSession,
  getJoystickClientId,
  buildJoystickOAuthUrl,
  exchangeJoystickCodeForToken,
  decodeJoystickJwt,
  ensureValidJoystickSession,
  type JoystickSession,
} from '../lib/joystick';
import { useAppStore } from '../store';

const OAUTH_STATE_KEY = 'joystick_oauth_state';

export function useJoystickAuth() {
  const [user, setUser] = useState<TwitchUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const processingCodeRef = useRef(false);

  const fetchMe = useCallback(async () => {
    const session = await ensureValidJoystickSession();
    console.log('[Joystick Auth] fetchMe — session:', session ? `username=${session.username} channelId=${session.channelId}` : 'null');
    if (session) {
      setUser({
        id: session.channelId || session.username,
        login: session.username,
        display_name: session.username,
        profile_image_url: '',
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

  // Polling fallback for when window.opener is null (cross-origin navigation nulled the opener)
  useEffect(() => {
    if (!loginInProgress) return;
    const pollInterval = setInterval(() => {
      const raw = localStorage.getItem('joystick_auth_callback');
      if (!raw) return;
      localStorage.removeItem('joystick_auth_callback');
      try {
        const { code, state, ts } = JSON.parse(raw);
        if (Date.now() - ts > 120000) return; // stale (>2min old)
        // Simulate the postMessage event
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'JOYSTICK_AUTH_CODE', code, state }
        }));
      } catch {}
    }, 500);
    return () => clearInterval(pollInterval);
  }, [loginInProgress]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const origin = event.origin;
      // Allow empty origin (synthetic events from localStorage polling fallback)
      if (origin && origin !== window.location.origin && !origin.includes('localhost') && !origin.includes('madchatter.fun') && !origin.includes('joystick.tv')) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'JOYSTICK_AUTH_CODE') {
        if (processingCodeRef.current) return;
        if (sessionStorage.getItem('joystick_auth_processing')) return;
        processingCodeRef.current = true;
        sessionStorage.setItem('joystick_auth_processing', '1');

        const code = data.code as string;
        const state = data.state as string;
        const savedState = localStorage.getItem(OAUTH_STATE_KEY);

        if (state !== savedState) {
          console.error('[Joystick Auth] State mismatch:', { received: state, saved: savedState });
          processingCodeRef.current = false;
          sessionStorage.removeItem('joystick_auth_processing');
          setLoginInProgress(false);
          setLoginError('OAuth state mismatch — possible CSRF attack. Aborting.');
          return;
        }

        localStorage.removeItem(OAUTH_STATE_KEY);

        try {
          const clientId = getJoystickClientId();

          if (!clientId) {
            throw new Error('Joystick Client ID not configured. Set it in your environment or Settings.');
          }

          console.log('[Joystick Auth] Exchanging code for token via proxy...');
          const tokenData = await exchangeJoystickCodeForToken(clientId, code);
          console.log('[Joystick Auth] Token exchange full response:', JSON.stringify(tokenData));
          const accessToken = tokenData.access_token;
          if (!accessToken) {
            throw new Error('Token exchange succeeded but no access_token in response: ' + JSON.stringify(tokenData));
          }

          // Extract channel_id from JWT token — no need for stream-settings API
          const jwtPayload = decodeJoystickJwt(accessToken);
          console.log('[Joystick Auth] JWT payload:', jwtPayload);
          const channelId = jwtPayload?.channel_id;
          // Use the channel slug the user typed in as username fallback
          const channelSlug = useAppStore.getState().streamMetadata?.channelName || 'unknown';
          const username = channelSlug;

          const session: JoystickSession = {
            accessToken,
            refreshToken: tokenData.refresh_token,
            username,
            channelId,
            expiresAt: jwtPayload?.exp ? jwtPayload.exp * 1000 : Date.now() + (tokenData.expires_in || 3600) * 1000,
          };
          setJoystickSession(session);
          // Set user directly — don't go through async fetchMe to avoid state loss
          setUser({
            id: session.channelId || session.username,
            login: session.username,
            display_name: session.username,
            profile_image_url: '',
            username: session.username,
          });
          setLoading(false);
          console.log('[Joystick Auth] Login complete, setting loginInProgress=false');
          setLoginInProgress(false);
          useAppStore.getState().bumpAuthTick();
        } catch (e: any) {
          console.error('[Joystick Auth] Login error:', e);
          setLoginInProgress(false);
          setLoginError(e.message || 'Joystick token exchange failed');
        } finally {
          processingCodeRef.current = false;
          sessionStorage.removeItem('joystick_auth_processing');
        }
      } else if (data.type === 'JOYSTICK_AUTH_ERROR') {
        setLoginInProgress(false);
        setLoginError(data.error || 'Joystick authentication failed or was cancelled.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchMe]);


  const login = async () => {
    const clientId = getJoystickClientId();
    if (!clientId) {
      setLoginError('Joystick Client ID not set. Go to Settings and enter your Joystick Client ID.');
      return;
    }

    setLoginInProgress(true);
    setLoginError(null);
    processingCodeRef.current = false;
    sessionStorage.removeItem('joystick_auth_processing');

    const state = crypto.randomUUID();
    localStorage.setItem(OAUTH_STATE_KEY, state);

    const url = buildJoystickOAuthUrl(clientId, state);

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(url, 'JoystickLogin', `width=${width},height=${height},left=${left},top=${top}`);
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
      const jwtPayload = decodeJoystickJwt(token);
      const channelId = jwtPayload?.channel_id;
      const session: JoystickSession = {
        accessToken: token,
        username,
        channelId,
      };
      setJoystickSession(session);
      await fetchMe();
    } catch (e: any) {
      setLoginError(e.message || 'Joystick dev token login failed');
    } finally {
      setLoginInProgress(false);
    }
  };

  const logout = async () => {
    setJoystickSession(null);
    localStorage.removeItem('forge_session_id');
    setUser(null);
    useAppStore.getState().bumpAuthTick();
  };

  const clearLoginError = () => setLoginError(null);

  return { user, loading, loginError, loginInProgress, login, logout, loginWithDevToken, clearLoginError, fetchMe };
}
