/**
 * Main-process session engine.
 *
 * Composes authkit-session's `AuthKitCore` + `AuthOperations` (built from an
 * injected public WorkOS client) with Electron-native persistence. This is the
 * orchestrator the IPC layer (Phase 2) calls into. It owns the
 * decrypt -> validate/refresh -> persist flow and confines the refresh token to
 * the main process.
 *
 * No `BrowserWindow`/`ipcMain` here — that is Phase 2. Everything in this file
 * is unit-testable by injecting fake `core`/`operations`/`storage` collaborators.
 */

import type { AuthKitCore, AuthOperations } from '@workos/authkit-session';
import type {
  AuthResult,
  BaseTokenClaims,
  CustomClaims,
  Session,
  TokenStorage,
} from '../shared/types.js';

export interface SessionManager {
  /** Decrypt -> validateAndRefresh -> persist if refreshed. */
  getUser(): Promise<AuthResult>;
  /** The short-lived access token, or null when signed out. Never the refresh token. */
  getAccessToken(): Promise<string | null>;
  /** Build the WorkOS logout URL and clear the local session. */
  signOut(opts?: { returnTo?: string }): Promise<{ logoutUrl: string }>;
  /** Force-refresh into a new organization and persist the new session. */
  switchToOrganization(orgId: string): Promise<AuthResult>;
  // Phase 2 adds: beginSignIn() and completeCallback(code, state)
}

export interface SessionManagerDeps {
  core: AuthKitCore;
  operations: AuthOperations;
  storage: TokenStorage;
}

/**
 * Build an `AuthResult` from a refreshed/validated session and its claims.
 * Mirrors the shape authkit-session's `AuthService.withAuth` returns, including
 * the refresh token — the IPC layer strips it before it reaches the renderer,
 * NOT this method.
 */
function toAuthResult<TCustomClaims = CustomClaims>(
  session: Session,
  claims: BaseTokenClaims & TCustomClaims,
): AuthResult<TCustomClaims> {
  return {
    user: session.user,
    sessionId: claims.sid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    claims,
    impersonator: session.impersonator,
    organizationId: claims.org_id,
    role: claims.role,
    roles: claims.roles,
    permissions: claims.permissions,
    entitlements: claims.entitlements,
    featureFlags: claims.feature_flags,
  };
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { core, operations, storage } = deps;

  async function getUser(): Promise<AuthResult> {
    const session = storage.getSession();
    if (!session) {
      return { user: null };
    }

    try {
      const result = await core.validateAndRefresh(session);
      // Re-persist only when the core actually minted new tokens.
      if (result.refreshed) {
        storage.setSession(result.session);
      }
      return toAuthResult(result.session, result.claims);
    } catch {
      // Refresh token invalid/expired (or any validation failure):
      // the session is unusable. Clear it and report signed-out.
      storage.clearSession();
      return { user: null };
    }
  }

  async function getAccessToken(): Promise<string | null> {
    const auth = await getUser();
    return auth.user ? auth.accessToken : null;
  }

  async function signOut(opts?: { returnTo?: string }): Promise<{ logoutUrl: string }> {
    const session = storage.getSession();
    let logoutUrl = '';
    if (session) {
      // The logout URL is keyed by session id, which lives in the access
      // token claims. Parsing is local (no network); guard it so a malformed
      // token still lets us clear local state.
      try {
        const { sid } = core.parseTokenClaims(session.accessToken);
        logoutUrl = operations.getLogoutUrl(sid, { returnTo: opts?.returnTo });
      } catch {
        logoutUrl = '';
      }
    }
    storage.clearSession();
    return { logoutUrl };
  }

  async function switchToOrganization(orgId: string): Promise<AuthResult> {
    const session = storage.getSession();
    if (!session) {
      return { user: null };
    }

    const { auth } = await operations.switchOrganization(session, orgId);
    // Persist the new (org-scoped) session. We store the raw Session via
    // safeStorage, not the core's cookie-sealed `encryptedSession`, so
    // reconstruct it from the auth result.
    if (auth.user) {
      storage.setSession({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        user: auth.user,
        impersonator: auth.impersonator,
      });
    }
    return auth;
  }

  return { getUser, getAccessToken, signOut, switchToOrganization };
}
