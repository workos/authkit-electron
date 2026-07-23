/**
 * Shared types for @workos/authkit-electron.
 *
 * These types are safe to import from any Electron process context (main,
 * preload, renderer). The renderer-facing payload types deliberately OMIT the
 * refresh token — it is confined to the main process and never crosses IPC.
 */

import type { Impersonator, User } from '@workos-inc/node';
import type { AuthResult, BaseTokenClaims, CustomClaims, Session } from '@workos/authkit-session';

// Surface @workos-inc/node's auth types directly so consumers never redeclare
// them (avoids the type drift the hand-wired example suffered from).
export type { Impersonator, User } from '@workos-inc/node';
export type { AuthResult, BaseTokenClaims, CustomClaims, Session } from '@workos/authkit-session';

/**
 * Optional pluggable persistence adapter. Defaults to the bundled
 * `electron-store` + `safeStorage` implementation. Defined here (not in
 * `main/storage.ts`) so it can be referenced by the public config type without
 * pulling Electron-only modules into shared code.
 */
export interface TokenStorage {
  getSession(): Session | null;
  setSession(session: Session): void;
  clearSession(): void;
  /** Per-install, >= 32 char secret used to seal in-flight PKCE state. */
  getOrCreateCookiePassword(): string;
  /**
   * Persist an in-flight PKCE verifier (the sealed state blob) under `key`,
   * with a single-use semantic and a TTL matching the core's PKCE seal (10
   * minutes). Used at sign-in to remember the `sealedState` so the callback can
   * verify it. NOT a cookie — it lives only in the main process.
   */
  setPendingVerifier(key: string, value: string): void;
  /**
   * Atomically read AND remove a pending verifier by `key`. Returns null when
   * absent or expired. Single-use: a second `take` for the same key returns
   * null, so a replayed callback cannot reuse a consumed verifier.
   */
  takePendingVerifier(key: string): string | null;
}

/**
 * Public configuration consumers pass to the SDK.
 *
 * Note: there is NO `apiKey` — authkit-electron operates as a public OAuth
 * client. Only the `clientId` is needed; no secret ships in the binary.
 */
export interface AuthKitElectronConfig {
  /** WorkOS Client ID (e.g. `client_...`). */
  clientId: string;
  /** Custom-protocol redirect URI, e.g. `workos-auth://callback`. */
  redirectUri: string;
  /**
   * Optional override for the session-sealing secret. When omitted, a
   * per-install >= 32 char secret is generated on first run and persisted in
   * the OS keychain via `safeStorage`.
   */
  cookiePassword?: string;
  /** Sign-in ceremony selection (default: system browser). */
  ceremony?: { mode?: 'system-browser' | 'window' };
  /** Optional custom storage adapter; defaults to the bundled electron-store. */
  storage?: TokenStorage;
}

/**
 * The user-facing claims object surfaced to the renderer. Identical to the
 * core's token claims; re-exported under an SDK-owned name for stability.
 */
export type AuthKitClaims<TCustomClaims = CustomClaims> = BaseTokenClaims & TCustomClaims;

/**
 * Renderer-facing authentication payload.
 *
 * Structurally mirrors the core `AuthResult` but with the refresh token
 * REMOVED — the refresh token must never appear in any IPC payload. The IPC
 * layer produces this shape from the main-side `AuthResult`.
 */
export type RendererAuthPayload<TCustomClaims = CustomClaims> =
  | { user: null }
  | {
      user: User;
      sessionId: string;
      accessToken: string;
      claims: AuthKitClaims<TCustomClaims>;
      organizationId?: string;
      role?: string;
      roles?: string[];
      permissions?: string[];
      entitlements?: string[];
      featureFlags?: string[];
      impersonator?: Impersonator;
    };

/**
 * Renderer-facing description of a failed sign-in / callback attempt.
 *
 * Carries only a stable `code` (for branching) and a human-readable `message` —
 * never tokens or any other secret. Broadcast on the auth-error channel when a
 * sign-in ceremony returns a provider error, is cancelled, fails to open, or
 * the code/token exchange fails, so the renderer can surface the failure
 * instead of silently staying signed out.
 */
export interface AuthErrorPayload {
  /** A stable, branchable error code (e.g. the provider `error` value). */
  code: string;
  /** A human-readable description safe to show or log. */
  message: string;
}

/**
 * Strip the refresh token (and anything else not renderer-safe) from a
 * main-side `AuthResult`, producing a `RendererAuthPayload`. This is the single
 * chokepoint the IPC layer uses to guarantee `refreshToken` never leaves the
 * main process.
 */
export function toRendererAuthPayload<TCustomClaims = CustomClaims>(
  auth: AuthResult<TCustomClaims>,
): RendererAuthPayload<TCustomClaims> {
  if (!auth.user) {
    return { user: null };
  }
  // Explicitly destructure so `refreshToken` is dropped by omission rather
  // than relying on a denylist — a new sensitive field can only leak if it is
  // added to this allowlist on purpose.
  const {
    user,
    sessionId,
    accessToken,
    claims,
    organizationId,
    role,
    roles,
    permissions,
    entitlements,
    featureFlags,
    impersonator,
  } = auth;
  return {
    user,
    sessionId,
    accessToken,
    claims,
    organizationId,
    role,
    roles,
    permissions,
    entitlements,
    featureFlags,
    impersonator,
  };
}
