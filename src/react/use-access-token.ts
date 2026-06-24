/**
 * `useAccessToken()` — fetch and cache the short-lived access token for calling
 * the consumer's own backend.
 *
 * On mount and on every `onAuthChange`, it calls `bridge.getAccessToken()`
 * (which triggers the main-side validate-and-refresh). `refresh()` re-invokes
 * the same call on demand. The token is the renderer-safe access token only —
 * never the refresh token, which has no IPC channel.
 *
 * Race guard (Failure Modes): a `getAccessToken()` resolving AFTER an
 * `onAuthChange(signed-out)` must not write a stale token. We tag each fetch
 * with a monotonically increasing id and drop any response that is not the
 * latest, and we clear the token whenever an auth change reports `user: null`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from './context.js';

export interface UseAccessTokenResult {
  /** The current access token, or `null` when signed out or not yet loaded. */
  accessToken: string | null;
  /** True while a fetch is in flight. Matches `useAuth`'s `isLoading`. */
  isLoading: boolean;
  /** The last fetch error, or `null`. */
  error: Error | null;
  /** Re-fetch the token (triggers main-side validate-and-refresh). */
  refresh(): Promise<string | null>;
}

export function useAccessToken(): UseAccessTokenResult {
  const bridge = useBridge();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Monotonic request id: only the most recent fetch may write state. This
  // prevents an in-flight token from clobbering a later sign-out (or a later
  // refresh()).
  const requestIdRef = useRef(0);

  const fetchToken = useCallback(async (): Promise<string | null> => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    try {
      const result = await bridge.getAccessToken();
      // A newer fetch (or a sign-out reset) superseded us — drop this response.
      if (requestId !== requestIdRef.current) {
        return result.ok ? result.data : null;
      }
      if (result.ok) {
        setAccessToken(result.data);
        setError(null);
        setIsLoading(false);
        return result.data;
      }
      const err = new Error(result.error.message);
      err.name = result.error.code;
      setAccessToken(null);
      setError(err);
      setIsLoading(false);
      return null;
    } catch (cause) {
      if (requestId !== requestIdRef.current) {
        return null;
      }
      const err = cause instanceof Error ? cause : new Error(String(cause));
      setAccessToken(null);
      setError(err);
      setIsLoading(false);
      return null;
    }
  }, [bridge]);

  useEffect(() => {
    void fetchToken();

    const unsubscribe = bridge.onAuthChange((payload) => {
      if (payload.user === null) {
        // Signed out: invalidate any in-flight fetch and clear the token now,
        // so a token resolving afterward can't write a stale value.
        requestIdRef.current++;
        setAccessToken(null);
        setError(null);
        setIsLoading(false);
        return;
      }
      // Signed in / org switch / refresh: re-fetch the (possibly rotated) token.
      void fetchToken();
    });

    return unsubscribe;
  }, [bridge, fetchToken]);

  return { accessToken, isLoading, error, refresh: fetchToken };
}
