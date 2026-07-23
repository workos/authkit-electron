/**
 * Cross-context IPC contract for @workos/authkit-electron.
 *
 * These types are the shared shape every Electron process agrees on: the main
 * process produces them, the preload bridge forwards them, and the renderer
 * (`/react`) consumes them. They live here in `shared/` — not in a main- or
 * preload-process module — so the dependency graph flows inward to `shared/`
 * and the renderer/preload never import from a main-process implementation file
 * (which pulls in main-only Electron APIs).
 */

import type { AuthErrorPayload, RendererAuthPayload } from './types.js';

/**
 * Discriminated result returned across every renderer→main `invoke`.
 *
 * `ipcRenderer.invoke` flattens a rejected handler into an opaque rejection, so
 * the main handlers return this instead — the renderer branches on `ok` and
 * reads a stable `error.code`.
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** Options accepted by `signIn`, mirroring `SessionManager.beginSignIn`. */
export interface SignInOptions {
  screenHint?: 'sign-in' | 'sign-up';
  organizationId?: string;
}

/** The shape exposed at `window.__authkit_electron` by `exposeAuthKit()`. */
export interface AuthKitBridge {
  signIn(opts?: SignInOptions): Promise<IpcResult<null>>;
  signOut(opts?: { returnTo?: string }): Promise<IpcResult<{ logoutUrl: string }>>;
  getUser(): Promise<IpcResult<RendererAuthPayload>>;
  getAccessToken(): Promise<IpcResult<string | null>>;
  switchToOrganization(organizationId: string): Promise<IpcResult<RendererAuthPayload>>;
  /** Subscribe to auth-change broadcasts. Returns an unsubscribe function. */
  onAuthChange(callback: (payload: RendererAuthPayload) => void): () => void;
  /**
   * Subscribe to auth-error broadcasts (a failed/denied/cancelled sign-in or a
   * failed code exchange). Returns an unsubscribe function. The payload never
   * contains tokens — only a safe `code` + `message`.
   */
  onAuthError(callback: (error: AuthErrorPayload) => void): () => void;
}
