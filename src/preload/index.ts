/**
 * Preload bridge — `@workos/authkit-electron/preload`.
 *
 * Exposes a typed `window.__authkit_electron` API to the renderer over the
 * SDK-owned IPC channels. The channel names are IMPORTED from the shared module
 * (`IPC_CHANNELS`) — never redeclared — which is the whole point of owning the
 * contract in the package: preload and main can never drift out of sync behind
 * a "these must match" comment (the bug in the hand-wired example).
 *
 * Renderer→main calls go through `ipcRenderer.invoke` and resolve to an
 * `IpcResult` discriminated union; the renderer (`/react`, Phase 3) unwraps it.
 * The main→renderer auth-change push is delivered via `onAuthChange`, which
 * returns an unsubscribe so React effects can clean up.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels.js';
import type { IpcResult } from '../main/ipc-handlers.js';
import type { RendererAuthPayload } from '../shared/types.js';

/** Options accepted by `signIn`, mirroring `SessionManager.beginSignIn`. */
export interface SignInOptions {
  screenHint?: 'sign-in' | 'sign-up';
  organizationId?: string;
}

/** The shape exposed at `window.__authkit_electron`. */
export interface AuthKitBridge {
  signIn(opts?: SignInOptions): Promise<IpcResult<null>>;
  signOut(opts?: { returnTo?: string }): Promise<IpcResult<{ logoutUrl: string }>>;
  getUser(): Promise<IpcResult<RendererAuthPayload>>;
  getAccessToken(): Promise<IpcResult<string | null>>;
  switchToOrganization(organizationId: string): Promise<IpcResult<RendererAuthPayload>>;
  /** Subscribe to auth-change broadcasts. Returns an unsubscribe function. */
  onAuthChange(callback: (payload: RendererAuthPayload) => void): () => void;
}

/** The global key the bridge is exposed under in the renderer. */
export const AUTHKIT_BRIDGE_KEY = '__authkit_electron';

/** Build the bridge object (pure — no Electron globals touched at call time). */
function createBridge(): AuthKitBridge {
  return {
    signIn: (opts) => ipcRenderer.invoke(IPC_CHANNELS.signIn, opts),
    signOut: (opts) => ipcRenderer.invoke(IPC_CHANNELS.signOut, opts),
    getUser: () => ipcRenderer.invoke(IPC_CHANNELS.getUser),
    getAccessToken: () => ipcRenderer.invoke(IPC_CHANNELS.getAccessToken),
    switchToOrganization: (organizationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.switchToOrganization, organizationId),
    onAuthChange: (callback) => {
      const listener = (_event: unknown, payload: RendererAuthPayload): void => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.authChanged, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.authChanged, listener);
      };
    },
  };
}

/**
 * Expose the AuthKit bridge to the renderer.
 *
 * With `contextIsolation` on (the secure default and the only supported mode
 * for this bridge), use `contextBridge`. Without it, assign to `window`
 * directly as a fallback so the bridge still works in apps that have disabled
 * isolation — though that configuration is discouraged.
 *
 * Call this once from your preload script.
 */
export function exposeAuthKit(): void {
  const bridge = createBridge();

  if (process.contextIsolated) {
    try {
      contextBridge.exposeInMainWorld(AUTHKIT_BRIDGE_KEY, bridge);
    } catch (error) {
      // exposeInMainWorld throws if called after the context is set up, or if a
      // non-cloneable value sneaks in. Surface it rather than silently failing.
      console.error('[authkit-electron] failed to expose preload bridge:', error);
    }
  } else {
    (globalThis as unknown as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY] = bridge;
  }
}
