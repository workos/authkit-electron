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

/** Let a chain of awaited promises (incl. the crypto unseal) fully settle. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 5));
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
    await flushAsync();

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

  it('swallows a callback with an unknown state (no broadcast, no crash)', async () => {
    const app = makeApp();
    const sendSpy = vi.fn();
    const kit = createAuthKit(config, {
      storage: makeStorage(),
      client: {
        userManagement: { authenticateWithCode: vi.fn() },
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
    await flushAsync();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('ignores a callback URL carrying an error param (no throw, no broadcast)', async () => {
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
    listener({ preventDefault: () => {} }, 'workos-auth://callback?error=access_denied');
    await flushAsync();

    expect(sendSpy).not.toHaveBeenCalled();
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
