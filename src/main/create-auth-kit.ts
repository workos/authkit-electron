/**
 * `createAuthKit()` — the one-call main-process assembly.
 *
 * Wires every Phase 1 + Phase 2 piece into a working auth runtime:
 *
 *   storage -> cookiePassword -> AuthKitConfig -> public WorkOS client ->
 *   AuthKitCore + AuthOperations -> ceremony -> SessionManager ->
 *   IPC handlers + deep-link capture.
 *
 * The consumer calls this once and gets back `{ registerProtocol, cleanup }`.
 * `registerProtocol` is split out (rather than run here) because
 * `setAsDefaultProtocolClient` + the single-instance lock must run inside
 * `app.whenReady()` / before the first window — timing the SDK can't control.
 */

import { type WorkOS } from '@workos-inc/node';
import { AuthKitCore, AuthOperations, sessionEncryption } from '@workos/authkit-session';
import { type Ceremony, type CreateCeremonyOptions, createCeremony } from './ceremony/index.js';
import { createPublicWorkOS, toAuthKitConfig } from './config.js';
import {
  type AppLike,
  registerProtocol as registerProtocolImpl,
  wireDeepLinks,
} from './deep-link.js';
import {
  type BrowserWindowsLike,
  type IpcMainLike,
  broadcastAuthChange,
  registerIpcHandlers,
} from './ipc-handlers.js';
import { createSessionManager } from './session-manager.js';
import { createDefaultStorage } from './storage.js';
import {
  type AuthKitElectronConfig,
  type RendererAuthPayload,
  type TokenStorage,
  toRendererAuthPayload,
} from '../shared/types.js';

export interface CreateAuthKitResult {
  /**
   * Register the app as the OS handler for the redirect-URI protocol and wire
   * the deep-link capture matrix. Call inside `app.whenReady()` (or before the
   * first `BrowserWindow`). Returns the deep-link cleanup, also invoked by
   * {@link CreateAuthKitResult.cleanup}.
   */
  registerProtocol(): void;
  /** Remove IPC handlers and deep-link listeners. Call on app shutdown. */
  cleanup(): void;
}

/** Test seams; in production every collaborator defaults to the real one. */
export interface CreateAuthKitOptions extends CreateCeremonyOptions {
  storage?: TokenStorage;
  client?: WorkOS;
  ceremony?: Ceremony;
  ipcMain?: IpcMainLike;
  browserWindow?: BrowserWindowsLike;
  app?: AppLike;
  /** Override `process` for the deep-link dev-argv branch (tests). */
  process?: { defaultApp?: boolean; argv: string[]; execPath: string };
  /** Focus/restore the main window when a second instance forwards a URL. */
  onSecondInstance?: () => void;
}

/** Derive the custom-protocol scheme from a redirect URI (`scheme://...`). */
export function schemeFromRedirectUri(redirectUri: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(redirectUri);
  if (!match?.[1]) {
    throw new Error(
      `redirectUri "${redirectUri}" is not a custom-protocol URL (expected ` +
        `something like "workos-auth://callback").`,
    );
  }
  return match[1];
}

export function createAuthKit(
  config: AuthKitElectronConfig,
  opts: CreateAuthKitOptions = {},
): CreateAuthKitResult {
  const storage: TokenStorage = opts.storage ?? config.storage ?? createDefaultStorage();

  // Resolve the sealing secret: explicit override, else per-install keychain
  // value. `toAuthKitConfig` enforces the >= 32 char minimum.
  const cookiePassword = config.cookiePassword ?? storage.getOrCreateCookiePassword();
  const authKitConfig = toAuthKitConfig(config, cookiePassword);

  const client: WorkOS = opts.client ?? createPublicWorkOS(config.clientId);
  const core = new AuthKitCore(authKitConfig, client, sessionEncryption);
  const operations = new AuthOperations(core, client, authKitConfig, sessionEncryption);
  const ceremony: Ceremony = opts.ceremony ?? createCeremony(config, { shell: opts.shell });

  const sessionManager = createSessionManager({
    core,
    operations,
    storage,
    client,
    clientId: config.clientId,
    ceremony,
  });

  // One broadcast path shared by the IPC handlers and the deep-link callback,
  // so every auth change (sign-in, sign-out, org switch) reaches every window.
  const broadcast = (payload: RendererAuthPayload): void =>
    broadcastAuthChange(payload, { browserWindow: opts.browserWindow });

  const removeIpcHandlers = registerIpcHandlers(sessionManager, {
    ipcMain: opts.ipcMain,
    broadcast,
  });

  const scheme = schemeFromRedirectUri(config.redirectUri);
  let removeDeepLinks: (() => void) | null = null;

  /** Parse a deep-link callback URL and complete the OAuth round-trip. */
  async function handleCallbackUrl(url: string): Promise<void> {
    let params: URLSearchParams;
    try {
      params = new URL(url).searchParams;
    } catch {
      return;
    }
    const error = params.get('error');
    if (error) {
      // Provider-side denial/error — nothing to exchange. The renderer learns
      // via the absence of an auth change; surfacing richer errors is Phase 3.
      console.error('[authkit-electron] OAuth callback error:', error);
      return;
    }
    const code = params.get('code');
    if (!code) {
      return;
    }
    try {
      const auth = await sessionManager.completeCallback(code, params.get('state') ?? undefined);
      broadcast(toRendererAuthPayload(auth));
    } catch (err) {
      console.error('[authkit-electron] callback completion failed:', err);
    }
  }

  function registerProtocol(): void {
    registerProtocolImpl(scheme, { app: opts.app, process: opts.process });
    removeDeepLinks = wireDeepLinks(
      scheme,
      (url) => {
        void handleCallbackUrl(url);
      },
      { app: opts.app, process: opts.process, onSecondInstance: opts.onSecondInstance },
    );
  }

  function cleanup(): void {
    removeIpcHandlers();
    removeDeepLinks?.();
    removeDeepLinks = null;
  }

  return { registerProtocol, cleanup };
}
