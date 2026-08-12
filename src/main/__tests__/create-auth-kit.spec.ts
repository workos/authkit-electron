import { type User, type WorkOS, createWorkOS } from '@workos-inc/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ceremony } from '../ceremony/index.js';
import type { AppLike } from '../deep-link.js';
import type { BrowserWindowsLike, IpcMainLike } from '../ipc-handlers.js';
import { IPC_CHANNELS } from '../../shared/ipc-channels.js';
import type { TokenStorage } from '../../shared/types.js';
import { createAuthKit, schemeFromRedirectUri } from '../create-auth-kit.js';

// The assembly transitively imports electron (storage, deep-link, ipc). Inject
// fakes for every Electron-touching seam; this mock prevents the native load.
vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
  BrowserWindow: {},
  shell: {},
  contextBridge: {},
  ipcRenderer: {},
  safeStorage: { isEncryptionAvailable: () => true },
}));

const fakeUser = { id: 'user_1', email: 'a@b.com' } as unknown as User;

/**
 * Build an UNSIGNED JWT whose payload carries the given claims. `completeCallback`
 * decodes (does not verify) the access token via `parseTokenClaims`, so an
 * unsigned token with real claims is enough — no signing key needed.
 */
function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

function makeStorage(): TokenStorage {
  const pending = new Map<string, string>();
  let session: { accessToken: string; refreshToken: string; user: User } | null = null;
  return {
    getSession: () => session,
    setSession: (s) => {
      session = s as typeof session;
    },
    clearSession: () => {
      session = null;
    },
    getOrCreateCookiePassword: () => 'x'.repeat(32),
    setPendingVerifier: (k, v) => {
      pending.set(k, v);
    },
    takePendingVerifier: (k) => {
      const v = pending.get(k) ?? null;
      pending.delete(k);
      return v;
    },
  };
}

function makeIpcMain(): IpcMainLike & { handlers: Map<string, (...a: unknown[]) => unknown> } {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    handlers,
    handle: (c, l) => {
      handlers.set(c, l);
    },
    removeHandler: (c) => {
      handlers.delete(c);
    },
  };
}

/** Fake app capturing deep-link listeners. */
function makeApp(): AppLike & { listeners: Record<string, (...a: never[]) => void> } {
  const listeners: Record<string, (...a: never[]) => void> = {};
  return {
    listeners,
    setAsDefaultProtocolClient: vi.fn(() => true),
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    on: ((e: string, l: (...a: never[]) => void) => {
      listeners[e] = l;
    }) as AppLike['on'],
    removeListener: (() => {}) as AppLike['removeListener'],
  };
}

const config = { clientId: 'client_test', redirectUri: 'workos-auth://callback' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('schemeFromRedirectUri', () => {
  it('extracts the scheme from a custom-protocol URL', () => {
    expect(schemeFromRedirectUri('workos-auth://callback')).toBe('workos-auth');
    expect(schemeFromRedirectUri('my.app+x://cb')).toBe('my.app+x');
  });

  it('throws for a non-protocol URL', () => {
    expect(() => schemeFromRedirectUri('not-a-url')).toThrow();
  });
});

describe('createAuthKit — config validation', () => {
  it('throws at construction when clientId is missing', () => {
    expect(() =>
      createAuthKit(
        { clientId: undefined as unknown as string, redirectUri: 'workos-auth://callback' },
        {
          storage: makeStorage(),
          client: { userManagement: {} } as unknown as WorkOS,
          ipcMain: makeIpcMain(),
        },
      ),
    ).toThrow(/clientId/);
  });

  it('throws at construction when clientId is empty or blank', () => {
    for (const clientId of ['', '   ']) {
      expect(() =>
        createAuthKit(
          { clientId, redirectUri: 'workos-auth://callback' },
          {
            storage: makeStorage(),
            client: { userManagement: {} } as unknown as WorkOS,
            ipcMain: makeIpcMain(),
          },
        ),
      ).toThrow(/clientId/);
    }
  });

  it("names the expected 'client_' shape in the error so env-var mistakes are actionable", () => {
    expect(() =>
      createAuthKit(
        { clientId: undefined as unknown as string, redirectUri: 'workos-auth://callback' },
        {
          storage: makeStorage(),
          client: { userManagement: {} } as unknown as WorkOS,
          ipcMain: makeIpcMain(),
        },
      ),
    ).toThrow(/client_/);
  });
});

describe('createAuthKit — wiring', () => {
  it('registers all IPC handlers and exposes registerProtocol/cleanup', () => {
    const ipc = makeIpcMain();
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: { userManagement: {} } as unknown as WorkOS,
      ipcMain: ipc,
    });

    expect(ipc.handlers.has(IPC_CHANNELS.getUser)).toBe(true);
    expect(typeof kit.registerProtocol).toBe('function');
    expect(typeof kit.cleanup).toBe('function');
  });

  it('does not read cookiePassword at construction (deferred for before-whenReady use)', () => {
    // Regression: before app.whenReady() on macOS, safeStorage is unavailable and
    // storage.getOrCreateCookiePassword() throws. createAuthKit() must NOT call it
    // at construction — the core dereferences cookiePassword lazily, only at
    // sign-in seal time (always after `ready`). This reproduces the
    // EncryptionUnavailableError the example hit constructing the kit at module
    // top level.
    const storage = makeStorage();
    storage.getOrCreateCookiePassword = () => {
      throw new Error('safeStorage unavailable (called before app ready)');
    };

    expect(() =>
      createAuthKit(config, {
        storage,
        client: { userManagement: {} } as unknown as WorkOS,
        ipcMain: makeIpcMain(),
      }),
    ).not.toThrow();
  });

  it('registerProtocol calls setAsDefaultProtocolClient and wires listeners', () => {
    const app = makeApp();
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: { userManagement: {} } as unknown as WorkOS,
      ipcMain: makeIpcMain(),
      app,
      process: { argv: ['electron'], execPath: '/e' },
    });

    kit.registerProtocol();

    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('workos-auth');
    expect(typeof app.listeners['open-url']).toBe('function');
    expect(typeof app.listeners['second-instance']).toBe('function');
  });

  it('routes a deep-link callback through completeCallback and broadcasts', async () => {
    const app = makeApp();
    const ipc = makeIpcMain();
    const sendSpy = vi.fn();
    const browserWindow: BrowserWindowsLike = {
      getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: sendSpy } }],
    };

    // Capture the URL the ceremony was asked to open so we can replay its
    // `state` back as the deep-link callback — a true round-trip.
    let openedUrl = '';
    const ceremony: Ceremony = {
      open: vi.fn(async (url: string) => {
        openedUrl = url;
      }),
      endSession: vi.fn(async () => {}),
      onCallback: () => () => {},
    };

    // Real public client (real pkce + getAuthorizationUrl, no network); only
    // the code exchange is mocked.
    const client = createWorkOS({ clientId: 'client_test' }) as unknown as WorkOS;
    const accessJwt = makeJwt({ sid: 'session_cb', org_id: 'org_1' });
    const authenticateWithCode = vi
      .spyOn(client.userManagement, 'authenticateWithCode')
      .mockResolvedValue({
        user: fakeUser,
        accessToken: accessJwt,
        refreshToken: 'refresh_SECRET',
      } as Awaited<ReturnType<WorkOS['userManagement']['authenticateWithCode']>>);

    const storage = makeStorage();
    const kit = createAuthKit(config, {
      storage,
      client,
      ceremony,
      ipcMain: ipc,
      app,
      browserWindow,
      process: { argv: ['electron'], execPath: '/e' },
    });
    kit.registerProtocol();

    // Begin a real sign-in via the signIn IPC handler → seeds a real
    // sealedState in storage and opens a URL carrying that same state.
    await (ipc.handlers.get(IPC_CHANNELS.signIn) as (...a: unknown[]) => Promise<unknown>)(
      {},
      undefined,
    );
    const state = new URL(openedUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    // Now deliver the callback (macOS open-url) carrying the real state.
    const listener = app.listeners['open-url'] as (e: unknown, url: string) => void;
    listener(
      { preventDefault: () => {} },
      `workos-auth://callback?code=auth_code&state=${encodeURIComponent(state as string)}`,
    );
    // The callback pipeline unseals real crypto state before the exchange, so
    // poll for its terminal event (the broadcast) instead of a fixed flush.
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(authenticateWithCode).toHaveBeenCalledWith({
      code: 'auth_code',
      clientId: 'client_test',
      codeVerifier: expect.any(String),
    });
    // Session persisted and a refresh-token-free payload broadcast to windows.
    expect(storage.getSession()?.accessToken).toBe(accessJwt);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe(IPC_CHANNELS.authChanged);
    expect(payload).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(payload)).not.toContain('refresh_SECRET');
  });

  it('a callback with an unknown state surfaces an auth-error, not an auth-change', async () => {
    const app = makeApp();
    const sendSpy = vi.fn();
    const authenticateWithCode = vi.fn();
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: {
        userManagement: { authenticateWithCode },
      } as unknown as WorkOS,
      ipcMain: makeIpcMain(),
      app,
      browserWindow: {
        getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: sendSpy } }],
      },
      process: { argv: ['electron'], execPath: '/e' },
    });
    kit.registerProtocol();

    const listener = app.listeners['open-url'] as (e: unknown, url: string) => void;
    listener({ preventDefault: () => {} }, 'workos-auth://callback?code=c&state=unknown');
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // State verification fails before the network, so the code is never
    // exchanged and no signed-in payload is broadcast — but the renderer is told
    // the attempt failed via a safe auth-error (no crash). The error broadcast
    // is the pipeline's terminal event, so the exchange provably never ran.
    expect(authenticateWithCode).not.toHaveBeenCalled();
    const [channel] = sendSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe(IPC_CHANNELS.authError);
  });

  it('broadcasts an auth-error (not an auth-change) for a callback error param', async () => {
    const app = makeApp();
    const sendSpy = vi.fn();
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: { userManagement: { authenticateWithCode: vi.fn() } } as unknown as WorkOS,
      ipcMain: makeIpcMain(),
      app,
      browserWindow: {
        getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: sendSpy } }],
      },
      process: { argv: ['electron'], execPath: '/e' },
    });
    kit.registerProtocol();

    const listener = app.listeners['open-url'] as (e: unknown, url: string) => void;
    listener(
      { preventDefault: () => {} },
      'workos-auth://callback?error=access_denied&error_description=User+said+no',
    );
    // No code to exchange → no auth-change broadcast, but the renderer learns of
    // the failure via a safe auth-error payload (code + message, no tokens).
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [channel, payload] = sendSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe(IPC_CHANNELS.authError);
    expect(payload).toEqual({ code: 'access_denied', message: 'User said no' });
  });

  it('broadcasts an auth-error when the code exchange fails', async () => {
    const app = makeApp();
    const ipc = makeIpcMain();
    const sendSpy = vi.fn();

    let openedUrl = '';
    const ceremony: Ceremony = {
      open: vi.fn(async (url: string) => {
        openedUrl = url;
      }),
      endSession: vi.fn(async () => {}),
      onCallback: () => () => {},
    };

    const client = createWorkOS({ clientId: 'client_test' }) as unknown as WorkOS;
    // `authenticateWithCode` lives on the shared prototype, so spy with a *once*
    // rejection and restore afterwards to avoid leaking into sibling specs.
    const spy = vi
      .spyOn(client.userManagement, 'authenticateWithCode')
      .mockRejectedValueOnce(
        Object.assign(new Error('code already used'), { name: 'OAuthException' }),
      );

    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client,
      ceremony,
      ipcMain: ipc,
      app,
      browserWindow: {
        getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: sendSpy } }],
      },
      process: { argv: ['electron'], execPath: '/e' },
    });
    kit.registerProtocol();

    await (ipc.handlers.get(IPC_CHANNELS.signIn) as (...a: unknown[]) => Promise<unknown>)(
      {},
      undefined,
    );
    const state = new URL(openedUrl).searchParams.get('state');

    const listener = app.listeners['open-url'] as (e: unknown, url: string) => void;
    listener(
      { preventDefault: () => {} },
      `workos-auth://callback?code=auth_code&state=${encodeURIComponent(state as string)}`,
    );
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const [channel, payload] = sendSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe(IPC_CHANNELS.authError);
    expect(payload).toEqual({ code: 'OAuthException', message: 'code already used' });

    spy.mockRestore();
  });

  it('broadcasts an auth-error when the ceremony fails to open, and the IPC result is ok: false', async () => {
    const app = makeApp();
    const ipc = makeIpcMain();
    const sendSpy = vi.fn();

    // The window ceremony's open() rejects when win.loadURL() fails (e.g. the
    // auth server is unreachable). The failure must BOTH reject the renderer's
    // signIn() promise (ok: false) AND broadcast an auth-error, so
    // useAuth().error is populated like every other failure mode.
    const ceremony: Ceremony = {
      open: vi.fn(async () => {
        throw Object.assign(new Error('ERR_NAME_NOT_RESOLVED'), { name: 'SignInOpenError' });
      }),
      endSession: vi.fn(async () => {}),
      onCallback: () => () => {},
    };

    const client = createWorkOS({ clientId: 'client_test' }) as unknown as WorkOS;
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client,
      ceremony,
      ipcMain: ipc,
      app,
      browserWindow: {
        getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: sendSpy } }],
      },
      process: { argv: ['electron'], execPath: '/e' },
    });
    kit.registerProtocol();

    const result = (await (
      ipc.handlers.get(IPC_CHANNELS.signIn) as (...a: unknown[]) => Promise<unknown>
    )({}, undefined)) as { ok: boolean; error?: { code: string; message: string } };

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'SignInOpenError', message: 'ERR_NAME_NOT_RESOLVED' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [channel, payload] = sendSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe(IPC_CHANNELS.authError);
    expect(payload).toEqual({ code: 'SignInOpenError', message: 'ERR_NAME_NOT_RESOLVED' });
  });

  it('registerProtocol is idempotent — repeated calls do not re-wire listeners', () => {
    const app = makeApp();
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: { userManagement: {} } as unknown as WorkOS,
      ipcMain: makeIpcMain(),
      app,
      process: { argv: ['electron'], execPath: '/e' },
    });

    kit.registerProtocol();
    kit.registerProtocol();
    kit.registerProtocol();

    // setAsDefaultProtocolClient + the single deep-link wiring happen exactly
    // once, so duplicate open-url/second-instance listeners can't leak.
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
  });

  // Regression: schemeFromRedirectUri happily returns "https", which used to
  // flow into setAsDefaultProtocolClient('https') — a request to become the
  // user's default browser, and a callback that never arrives.
  it('registerProtocol throws for an https redirectUri in system-browser mode', () => {
    const app = makeApp();
    const kit = createAuthKit(
      { clientId: 'client_test', redirectUri: 'https://auth.example.com/callback' },
      {
        storage: makeStorage(),
        client: { userManagement: {} } as unknown as WorkOS,
        ipcMain: makeIpcMain(),
        app,
        process: { argv: ['electron'], execPath: '/e' },
      },
    );

    expect(() => kit.registerProtocol()).toThrow(/workos-auth:\/\/callback|mode: 'window'/);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('registerProtocol is a no-op for an https redirectUri in window mode', () => {
    const app = makeApp();
    const kit = createAuthKit(
      {
        clientId: 'client_test',
        redirectUri: 'https://auth.example.com/callback',
        ceremony: { mode: 'window' },
      },
      {
        storage: makeStorage(),
        client: { userManagement: {} } as unknown as WorkOS,
        ipcMain: makeIpcMain(),
        ceremony: { open: vi.fn(), endSession: vi.fn(), onCallback: () => () => {} } as Ceremony,
        app,
        process: { argv: ['electron'], execPath: '/e' },
      },
    );

    // The window ceremony intercepts the redirect in-window, so there is no
    // protocol to claim and no deep-link listener to wire.
    expect(() => kit.registerProtocol()).not.toThrow();
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(app.listeners['open-url']).toBeUndefined();
  });

  it('cleanup removes handlers without throwing', () => {
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: { userManagement: {} } as unknown as WorkOS,
      ipcMain: makeIpcMain(),
      app: makeApp(),
      process: { argv: ['electron'], execPath: '/e' },
    });
    kit.registerProtocol();
    expect(() => kit.cleanup()).not.toThrow();
  });
});
