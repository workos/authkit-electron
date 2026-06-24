/**
 * `useAuth()` — the primary renderer hook for `@workos/authkit-electron/react`.
 *
 * Returns the renderer-safe auth state (`user`, `isLoading`, the flattened
 * claim helpers) together with the actions (`signIn`, `signOut`,
 * `switchToOrganization`, `getAccessToken`). The shape mirrors the web SDK
 * `@workos/authkit-react` so code moving between web and desktop reads the same.
 *
 * Must be called inside an `<AuthKitProvider>`; otherwise it throws an
 * actionable error (via `useAuthKitContext`).
 */

import { type AuthKitContextValue, useAuthKitContext } from './context.js';

export function useAuth(): AuthKitContextValue {
  return useAuthKitContext();
}
