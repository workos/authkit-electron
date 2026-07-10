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
import { AUTHKIT_BRIDGE_KEY, IPC_CHANNELS } from '../shared/ipc-channels.js';
import type { AuthKitBridge } from '../shared/ipc.js';
import type { RendererAuthPayload } from '../shared/types.js';

// Re-export the cross-context contract so `@workos/authkit-electron/preload`
// consumers (and the renderer typings) keep importing it from the preload entry.
export type { AuthKitBridge, IpcResult, SignInOptions } from '../shared/ipc.js';
export { AUTHKIT_BRIDGE_KEY } from '../shared/ipc-channels.js';

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
      // non-cloneable value sneaks in. Both are setup bugs the developer must
      // fix, so fail loudly at the source rather than letting the renderer hit a
      // confusing "window.__authkit_electron is undefined" error later.
      throw new Error(
        '[authkit-electron] failed to expose the preload bridge via contextBridge. ' +
          'Call exposeAuthKit() once at preload top level, before the context is established.',
        { cause: error },
      );
    }
  } else {
    (globalThis as unknown as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY] = bridge;
  }
}
