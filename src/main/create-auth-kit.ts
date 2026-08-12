/**
 * `createAuthKit()` — the one-call main-process assembly.
 *
 * Wires every piece into a working auth runtime:
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
import { assertValidClientId, createPublicWorkOS, toAuthKitConfig } from './config.js';
import {
  type AppLike,
  isWebScheme,
  registerProtocol as registerProtocolImpl,
  wireDeepLinks,
} from './deep-link.js';
import {
  type BrowserWindowsLike,
  type IpcMainLike,
  broadcastAuthChange,
  broadcastAuthError,
  registerIpcHandlers,
} from './ipc-handlers.js';
import { createSessionManager } from './session-manager.js';
import { createDefaultStorage } from './storage.js';
import {
  type AuthErrorPayload,
  type AuthKitElectronConfig,
  type RendererAuthPayload,
  type TokenStorage,
  toRendererAuthPayload,
} from '../shared/types.js';

export interface CreateAuthKitResult {
  /**
   * Register the app as the OS handler for the redirect-URI protocol and wire
   * the deep-link capture matrix. Call inside `app.whenReady()` (or before the
   * first `BrowserWindow`). Idempotent: calling it more than once is a no-op
   * after the first call (the listeners are wired exactly once), so it never
   * leaks duplicate `open-url`/`second-instance` handlers. The deep-link
   * listeners are removed by {@link CreateAuthKitResult.cleanup}.
   *
   * With an `http(s)` `redirectUri` there is no custom protocol to register:
   * in `ceremony.mode: 'window'` (which captures its callback in-window) this
   * is a no-op, and in `system-browser` mode it throws, because nothing would
   * ever capture the callback.
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
  // Fail fast, before any storage/client assembly, so a misconfigured clientId
  // surfaces at startup rather than as a broken authorization URL at sign-in.
  assertValidClientId(config.clientId);

  const storage: TokenStorage = opts.storage ?? config.storage ?? createDefaultStorage();

  // Resolve the sealing secret lazily so createAuthKit() can be called before
  // app.whenReady(): an explicit cookiePassword is validated up front, otherwise
  // we defer storage.getOrCreateCookiePassword() (an OS-keychain read via
  // safeStorage, unavailable until `ready` on macOS) until the core first
  // dereferences it at sign-in seal time. `toAuthKitConfig` enforces the >= 32
  // char minimum either way.
  const authKitConfig = toAuthKitConfig(
    config,
    config.cookiePassword ?? (() => storage.getOrCreateCookiePassword()),
  );

  const client: WorkOS = opts.client ?? createPublicWorkOS(config.clientId);
  const core = new AuthKitCore(authKitConfig, client, sessionEncryption);
  const operations = new AuthOperations(core, client, authKitConfig, sessionEncryption);
  const ceremony: Ceremony =
    opts.ceremony ??
    createCeremony(config, {
      shell: opts.shell,
      createWindow: opts.createWindow,
      parent: opts.parent,
    });

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

  // Companion path for sign-in failures: a denied/cancelled ceremony, a failed
  // code exchange, or a sign-in window that can't load the auth server has no
  // auth-change to broadcast, so surface a safe error payload (code + message,
  // never tokens) the renderer can observe.
  const broadcastError = (error: AuthErrorPayload): void =>
    broadcastAuthError(error, { browserWindow: opts.browserWindow });

  const removeIpcHandlers = registerIpcHandlers(sessionManager, {
    ipcMain: opts.ipcMain,
    broadcast,
    broadcastError,
  });

  const scheme = schemeFromRedirectUri(config.redirectUri);
  let removeDeepLinks: (() => void) | null = null;
  let protocolRegistered = false;

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
      // Provider-side denial/error (or a window-ceremony cancellation, which
      // arrives as `?error=window_closed`) — nothing to exchange. Surface it so
      // the renderer can react instead of silently staying signed out.
      const description = params.get('error_description') ?? undefined;
      console.error('[authkit-electron] OAuth callback error:', error, description ?? '');
      broadcastError({ code: error, message: description ?? error });
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
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof Error ? err.name : 'CallbackError';
      broadcastError({ code: errorCode, message });
    }
  }

  // Window-ceremony callbacks arrive here (the ceremony intercepts navigation
  // to `redirectUri` in-window and pushes the captured URL through `onCallback`)
  // rather than via the OS protocol handler — so they reuse the SAME completion
  // path as deep links with no double-handle. For the system-browser ceremony
  // `onCallback` is a no-op, so this subscription is inert.
  const removeCeremonyCallback = ceremony.onCallback((url) => {
    void handleCallbackUrl(url);
  });

  function registerProtocol(): void {
    // Idempotent: wiring the deep-link listeners twice would leak the first set
    // (and double-handle every callback). Register exactly once; subsequent
    // calls are a no-op until `cleanup()` resets the flag.
    if (protocolRegistered) {
      return;
    }
    // An http(s) redirectUri is not a deep link. The window ceremony captures
    // it in-window, so registration is simply unnecessary there; the
    // system-browser ceremony has no other way to hear the callback, so a
    // silent no-op would strand every sign-in — fail loudly instead.
    if (isWebScheme(scheme)) {
      if (config.ceremony?.mode === 'window') {
        return;
      }
      throw new Error(
        `redirectUri "${config.redirectUri}" uses the "${scheme}" scheme, which the OS ` +
          `hands to the default browser, not to this app — the system-browser ceremony ` +
          `would never receive the callback. Use a custom-protocol redirect URI ` +
          `(e.g. "workos-auth://callback") and register it in the WorkOS Dashboard, or ` +
          `switch to ceremony: { mode: 'window' }, which captures an https redirect in-app.`,
      );
    }
    registerProtocolImpl(scheme, { app: opts.app, process: opts.process });
    removeDeepLinks = wireDeepLinks(
      scheme,
      (url) => {
        void handleCallbackUrl(url);
      },
      { app: opts.app, process: opts.process, onSecondInstance: opts.onSecondInstance },
    );
    protocolRegistered = true;
  }

  function cleanup(): void {
    removeIpcHandlers();
    removeCeremonyCallback();
    removeDeepLinks?.();
    removeDeepLinks = null;
    protocolRegistered = false;
  }

  return { registerProtocol, cleanup };
}
