import { useState, useEffect, useCallback } from 'react';
import { TwitchUser } from '../types';
import {
  getTwitchSession,
  setTwitchSession,
  getTwitchClientId,
  buildOAuthUrl,
  validateDevToken,
} from '../lib/twitch';
import { useAppStore } from '../store';

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
          setTwitchSession(data.session);
          await fetchMe();
        }
      } else if (data.type === 'OAUTH_ERROR') {
        setLoginInProgress(false);
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

  const clearLoginError = () => setLoginError(null);

  return { user, loading, loginError, loginInProgress, login, logout, loginWithDevToken, clearLoginError, fetchMe };
}
