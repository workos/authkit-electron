/**
 * Internal React context for `@workos/authkit-electron/react`.
 *
 * Holds only renderer-safe state: the `user`, the flattened claim helpers, and
 * the short-lived access token. The refresh token has no representation here —
 * it never crosses the IPC bridge (enforced upstream by `toRendererAuthPayload`
 * in Phase 1), and this layer has no channel that would return it.
 *
 * The field/method names mirror the web SDK `@workos/authkit-react`
 * (`isLoading`, `user`, `role`, `roles`, `organizationId`, `permissions`,
 * `featureFlags`, `impersonator`, `signIn`/`signOut`/`switchToOrganization`/
 * `getAccessToken`) so a developer moving between web and desktop sees the same
 * surface, plus the Electron-only extras the bridge carries (`sessionId`,
 * `entitlements`, `claims`).
 */

import { createContext, useContext } from 'react';
import type { AuthKitBridge, SignInOptions } from '../preload/index.js';
import type { AuthKitClaims, Impersonator, User } from '../shared/types.js';

/**
 * The value surfaced by {@link AuthKitContext} and read by `useAuth()`.
 *
 * Shared names align with the web SDK; `sessionId`, `entitlements`, and
 * `claims` are Electron-specific because the renderer payload carries them.
 */
export interface AuthKitContextValue {
  /** The signed-in user, or `null` when signed out. */
  user: User | null;
  /** True until the first `getUser()` resolves. Mirrors the web SDK name. */
  isLoading: boolean;

  // Flattened claim helpers (present only when signed in).
  sessionId?: string;
  organizationId?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  entitlements?: string[];
  featureFlags?: string[];
  impersonator?: Impersonator;
  /** The full decoded access-token claims (Electron-specific convenience). */
  claims?: AuthKitClaims;

  /** Begin a sign-in ceremony in the system browser (or window). */
  signIn(opts?: SignInOptions): Promise<void>;
  /** Sign out, clearing the session in the main process. */
  signOut(opts?: { returnTo?: string }): Promise<void>;
  /** Force-refresh into a different organization. */
  switchToOrganization(organizationId: string): Promise<void>;
  /** The current short-lived access token, or `null` when signed out. */
  getAccessToken(): Promise<string | null>;
}

/**
 * The React context. `undefined` default lets `useAuth()` detect a missing
 * `<AuthKitProvider>` and throw an actionable error rather than handing back a
 * silently-broken value.
 */
export const AuthKitContext = createContext<AuthKitContextValue | undefined>(undefined);
AuthKitContext.displayName = 'AuthKitContext';

/**
 * Read the preload bridge from `window.__authkit_electron`.
 *
 * Throws a developer-friendly error when the bridge is absent — the usual cause
 * is that `exposeAuthKit()` was never called in the preload script, or the
 * preload did not load for this window.
 */
export function useBridge(): AuthKitBridge {
  const bridge = (globalThis as { __authkit_electron?: AuthKitBridge }).__authkit_electron;
  if (!bridge) {
    throw new Error(
      '[authkit-electron] window.__authkit_electron is missing. Did you call ' +
        'exposeAuthKit() in your preload script (and point your BrowserWindow at it)?',
    );
  }
  return bridge;
}

/**
 * Read the AuthKit context. Throws when used outside an `<AuthKitProvider>`.
 * Shared by `useAuth()` and the `<SignedIn>`/`<SignedOut>` guards.
 */
export function useAuthKitContext(): AuthKitContextValue {
  const value = useContext(AuthKitContext);
  if (!value) {
    throw new Error(
      '[authkit-electron] useAuth() must be used within an <AuthKitProvider>. ' +
        'Wrap your app (or the subtree that needs auth) in <AuthKitProvider>.',
    );
  }
  return value;
}
