/**
 * `AuthKitProvider` — the renderer-side root for `@workos/authkit-electron/react`.
 *
 * Pattern: the main process is the single source of truth. The provider never
 * computes auth itself — it reflects `getUser()` (once, on mount) and then every
 * `onAuthChange` push, which can originate from ANY window (e.g. a sign-out in a
 * second window updates this one). The subscription returns an unsubscribe that
 * the effect cleanup runs on unmount.
 *
 * Mirrors `electron-authkit-example/.../hooks/useAuth.ts` (subscribe-on-mount),
 * minus the locally-redefined `User` type — we use `@workos-inc/node`'s `User`
 * via the shared payload.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { IpcResult } from '../main/ipc-handlers.js';
import type { SignInOptions } from '../preload/index.js';
import type { RendererAuthPayload } from '../shared/types.js';
import { AuthKitContext, type AuthKitContextValue, useBridge } from './context.js';

/** Internal reducer-free state: the latest payload + the loading flag. */
interface ProviderState {
  auth: RendererAuthPayload;
  isLoading: boolean;
}

const SIGNED_OUT: RendererAuthPayload = { user: null };

/** Unwrap an `IpcResult`-wrapped payload to a `RendererAuthPayload`. */
function unwrapAuth(result: IpcResult<RendererAuthPayload>): RendererAuthPayload {
  return result.ok ? result.data : SIGNED_OUT;
}

export interface AuthKitProviderProps {
  children: ReactNode;
}

export function AuthKitProvider({ children }: AuthKitProviderProps): ReactNode {
  // useBridge throws a clear error if exposeAuthKit() wasn't called in preload.
  const bridge = useBridge();
  const [state, setState] = useState<ProviderState>({ auth: SIGNED_OUT, isLoading: true });

  useEffect(() => {
    let active = true;

    // 1. Initial fetch. Ignore the result if we unmounted or an onAuthChange
    //    already landed (handled by `active`); the subscription is the
    //    authoritative ongoing path.
    bridge.getUser().then(
      (result) => {
        if (active) {
          setState({ auth: unwrapAuth(result), isLoading: false });
        }
      },
      () => {
        // invoke() rejected (handler missing, etc.). Treat as signed out rather
        // than leaving the UI stuck in a loading state forever.
        if (active) {
          setState({ auth: SIGNED_OUT, isLoading: false });
        }
      },
    );

    // 2. Subscribe to pushes from any window. Returns an unsubscribe.
    const unsubscribe = bridge.onAuthChange((payload) => {
      setState({ auth: payload, isLoading: false });
    });

    return () => {
      active = false;
      unsubscribe();
    };
    // The bridge identity is stable for the window's lifetime; subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthKitContextValue>(() => {
    const { auth, isLoading } = state;

    const actions: Pick<
      AuthKitContextValue,
      'signIn' | 'signOut' | 'switchToOrganization' | 'getAccessToken'
    > = {
      signIn: async (opts?: SignInOptions) => {
        const result = await bridge.signIn(opts);
        if (!result.ok) {
          throw new Error(`[authkit-electron] signIn failed: ${result.error.message}`);
        }
      },
      signOut: async (opts?: { returnTo?: string }) => {
        const result = await bridge.signOut(opts);
        if (!result.ok) {
          throw new Error(`[authkit-electron] signOut failed: ${result.error.message}`);
        }
        // The main process broadcasts auth-changed on sign-out, so the
        // subscription updates state; no local mutation needed here.
      },
      switchToOrganization: async (organizationId: string) => {
        const result = await bridge.switchToOrganization(organizationId);
        if (!result.ok) {
          throw new Error(
            `[authkit-electron] switchToOrganization failed: ${result.error.message}`,
          );
        }
      },
      getAccessToken: async () => {
        const result = await bridge.getAccessToken();
        return result.ok ? result.data : null;
      },
    };

    if (auth.user === null) {
      return { user: null, isLoading, ...actions };
    }

    return {
      user: auth.user,
      isLoading,
      sessionId: auth.sessionId,
      organizationId: auth.organizationId,
      role: auth.role,
      roles: auth.roles,
      permissions: auth.permissions,
      entitlements: auth.entitlements,
      featureFlags: auth.featureFlags,
      impersonator: auth.impersonator,
      claims: auth.claims,
      ...actions,
    };
  }, [state, bridge]);

  return <AuthKitContext.Provider value={value}>{children}</AuthKitContext.Provider>;
}
