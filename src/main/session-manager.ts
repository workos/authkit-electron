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

import type { WorkOS } from '@workos-inc/node';
import type { AuthKitCore, AuthOperations } from '@workos/authkit-session';
import type { Ceremony } from './ceremony/index.js';
import type {
  AuthResult,
  BaseTokenClaims,
  CustomClaims,
  Session,
  TokenStorage,
} from '../shared/types.js';

/** Options accepted when beginning a sign-in ceremony. */
export interface BeginSignInOptions {
  screenHint?: 'sign-in' | 'sign-up';
  organizationId?: string;
}

export interface SessionManager {
  /** Decrypt -> validateAndRefresh -> persist if refreshed. */
  getUser(): Promise<AuthResult>;
  /** The short-lived access token, or null when signed out. Never the refresh token. */
  getAccessToken(): Promise<string | null>;
  /** Build the WorkOS logout URL and clear the local session. */
  signOut(opts?: { returnTo?: string }): Promise<{ logoutUrl: string }>;
  /** Force-refresh into a new organization and persist the new session. */
  switchToOrganization(orgId: string): Promise<AuthResult>;
  /**
   * Begin a sign-in: create a PKCE-bound authorization URL, persist the sealed
   * state main-side, and hand the URL to the ceremony (system browser by
   * default). The callback returns asynchronously via {@link completeCallback}.
   */
  beginSignIn(opts?: BeginSignInOptions): Promise<void>;
  /**
   * Complete an OAuth callback: verify the deep-link `state` against the
   * persisted sealed state, exchange the code for tokens, persist the session,
   * and return the resulting `AuthResult`. Throws on any verification or
   * exchange failure (the IPC layer maps that to a typed error result).
   */
  completeCallback(code: string, state: string | undefined): Promise<AuthResult>;
}

export interface SessionManagerDeps {
  core: AuthKitCore;
  operations: AuthOperations;
  storage: TokenStorage;
  /**
   * The injected public WorkOS client. Needed for the authorization-code
   * exchange (`userManagement.authenticateWithCode`), which `AuthOperations`
   * does not expose because that step is cookie/`AuthService`-bound upstream.
   */
  client: WorkOS;
  /** WorkOS client ID, passed to the code exchange. */
  clientId: string;
  /** The sign-in ceremony (system browser by default). */
  ceremony: Ceremony;
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
  const { core, operations, storage, client, clientId, ceremony } = deps;

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

  async function beginSignIn(opts?: BeginSignInOptions): Promise<void> {
    // `createAuthorization` seals the PKCE verifier into `sealedState` and also
    // embeds `state=sealedState` in the URL. We persist the SAME sealed blob
    // main-side (key === value) so the callback can byte-compare and unseal it.
    const { url, sealedState } = await operations.createAuthorization({
      screenHint: opts?.screenHint,
      organizationId: opts?.organizationId,
    });
    storage.setPendingVerifier(sealedState, sealedState);
    await ceremony.open(url);
  }

  async function completeCallback(code: string, state: string | undefined): Promise<AuthResult> {
    // Single-use take: pull (and remove) the sealed state we persisted at
    // sign-in. A missing/replayed state yields null, and `verifyCallbackState`
    // then rejects with OAuthStateMismatchError / PKCECookieMissingError.
    const stored = state ? storage.takePendingVerifier(state) : null;

    // Verify (constant-time byte-compare + unseal) and recover the PKCE
    // codeVerifier. Any failure here throws before we touch the network.
    const { codeVerifier } = await core.verifyCallbackState({
      stateFromUrl: state,
      cookieValue: stored ?? undefined,
    });

    // Exchange the authorization code for tokens. `AuthOperations` does not
    // expose this (it is AuthService/cookie-bound upstream), so call the
    // injected client directly — the public client implements it.
    const res = await client.userManagement.authenticateWithCode({
      code,
      clientId,
      codeVerifier,
    });

    const session: Session = {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      user: res.user,
      impersonator: res.impersonator,
    };
    storage.setSession(session);

    // Claims are local (no network) — parse them off the freshly minted access
    // token to build the same AuthResult shape getUser/switchOrg return.
    const claims = core.parseTokenClaims(session.accessToken);
    return toAuthResult(session, claims);
  }

  return {
    getUser,
    getAccessToken,
    signOut,
    switchToOrganization,
    beginSignIn,
    completeCallback,
  };
}
