/**
 * Declarative auth guards for `@workos/authkit-electron/react`, modeled on
 * `@clerk/clerk-react`'s `<SignedIn>` / `<SignedOut>`.
 *
 * Both read the same `AuthKitContext` as `useAuth()`, so they stay in sync with
 * every `onAuthChange` push. They render nothing (and nothing flashes) until the
 * provider has resolved the initial `getUser()` — while `isLoading`, neither
 * guard renders its children.
 */

import type { ReactNode } from 'react';
import { useAuthKitContext } from './context.js';

/** Render `children` only when a user is signed in. */
export function SignedIn({ children }: { children: ReactNode }): ReactNode {
  const { user, isLoading } = useAuthKitContext();
  return !isLoading && user !== null ? children : null;
}

/** Render `children` only when no user is signed in. */
export function SignedOut({ children }: { children: ReactNode }): ReactNode {
  const { user, isLoading } = useAuthKitContext();
  return !isLoading && user === null ? children : null;
}
