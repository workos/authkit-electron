import type { User } from '@workos-inc/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/ipc-channels.js';
import type { AuthResult } from '../../shared/types.js';
import type { BrowserWindowsLike, IpcMainLike } from '../ipc-handlers.js';
import { broadcastAuthChange, broadcastAuthError, registerIpcHandlers } from '../ipc-handlers.js';
import type { SessionManager } from '../session-manager.js';

// Top-level import pulls `ipcMain`/`BrowserWindow` from electron; tests inject
// their own, so this mock only needs to exist.
vi.mock('electron', () => ({ ipcMain: {}, BrowserWindow: {} }));

const fakeUser = { id: 'user_1', email: 'a@b.com' } as unknown as User;

/** A signed-in AuthResult carrying a refresh token (must be stripped by IPC). */
const signedInAuth: AuthResult = {
  user: fakeUser,
  sessionId: 'session_1',
  accessToken: 'access_1',
  refreshToken: 'refresh_SECRET',
  claims: { sid: 'session_1', org_id: 'org_1' },
  organizationId: 'org_1',
  role: 'admin',
};

/** Fake ipcMain that records handlers by channel and can invoke them. */
function makeIpcMain(): IpcMainLike & {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  removed: string[];
  invoke(channel: string, arg?: unknown): Promise<unknown>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  return {
    handlers,
    removed,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      removed.push(channel);
      handlers.delete(channel);
    },
    // Mirror Electron: invoke passes (event, arg). We pass a dummy event.
    invoke(channel, arg) {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`no handler for ${channel}`);
      }
      return Promise.resolve(handler({}, arg));
    },
  };
}

function makeSessionManager(overrides: Partial<SessionManager> = {}): SessionManager {
  return {
    getUser: vi.fn(async () => ({ user: null })),
    getAccessToken: vi.fn(async () => null),
    signOut: vi.fn(async () => ({ logoutUrl: 'https://logout' })),
    switchToOrganization: vi.fn(async () => ({ user: null })),
    beginSignIn: vi.fn(async () => {}),
    completeCallback: vi.fn(async () => ({ user: null })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerIpcHandlers — registration', () => {
  it('registers a handler for every SDK channel and cleanup removes them all', () => {
    const ipc = makeIpcMain();
    const cleanup = registerIpcHandlers(makeSessionManager(), { ipcMain: ipc, broadcast: vi.fn() });

    for (const channel of [
      IPC_CHANNELS.signIn,
      IPC_CHANNELS.signOut,
      IPC_CHANNELS.getUser,
      IPC_CHANNELS.getAccessToken,
      IPC_CHANNELS.switchToOrganization,
    ]) {
      expect(ipc.handlers.has(channel)).toBe(true);
    }

    cleanup();
    expect(ipc.removed).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.signIn,
        IPC_CHANNELS.signOut,
        IPC_CHANNELS.getUser,
        IPC_CHANNELS.getAccessToken,
        IPC_CHANNELS.switchToOrganization,
      ]),
    );
  });
});

describe('registerIpcHandlers — refresh token never crosses IPC', () => {
  it('getUser payload omits refreshToken', async () => {
    const ipc = makeIpcMain();
    const sm = makeSessionManager({ getUser: vi.fn(async () => signedInAuth) });
    registerIpcHandlers(sm, { ipcMain: ipc, broadcast: vi.fn() });

    const result = (await ipc.invoke(IPC_CHANNELS.getUser)) as {
      ok: true;
      data: Record<string, unknown>;
    };

    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result.data)).not.toContain('refresh_SECRET');
    // But the safe fields are present.
    expect(result.data.accessToken).toBe('access_1');
    expect(result.data.sessionId).toBe('session_1');
  });

  it('switchToOrganization payload omits refreshToken and broadcasts', async () => {
    const ipc = makeIpcMain();
    const broadcast = vi.fn();
    const sm = makeSessionManager({
      switchToOrganization: vi.fn(async () => signedInAuth),
    });
    registerIpcHandlers(sm, { ipcMain: ipc, broadcast });

    const result = (await ipc.invoke(IPC_CHANNELS.switchToOrganization, 'org_2')) as {
      ok: true;
      data: Record<string, unknown>;
    };

    expect(result.data).not.toHaveProperty('refreshToken');
    expect(sm.switchToOrganization).toHaveBeenCalledWith('org_2');
    // Broadcast payload is also refresh-token-free.
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]?.[0]).not.toHaveProperty('refreshToken');
  });
});

describe('registerIpcHandlers — result shape', () => {
  it('returns { ok: false, error } when the session manager throws', async () => {
    const ipc = makeIpcMain();
    const sm = makeSessionManager({
      getUser: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    registerIpcHandlers(sm, { ipcMain: ipc, broadcast: vi.fn() });

    const result = (await ipc.invoke(IPC_CHANNELS.getUser)) as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('Error');
    expect(result.error.message).toBe('boom');
  });

  it('signIn forwards options and returns { ok: true }', async () => {
    const ipc = makeIpcMain();
    const sm = makeSessionManager();
    registerIpcHandlers(sm, { ipcMain: ipc, broadcast: vi.fn() });

    const result = (await ipc.invoke(IPC_CHANNELS.signIn, { screenHint: 'sign-up' })) as {
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(sm.beginSignIn).toHaveBeenCalledWith({ screenHint: 'sign-up' });
  });

  it('signOut returns the logout URL and broadcasts a signed-out change', async () => {
    const ipc = makeIpcMain();
    const broadcast = vi.fn();
    const sm = makeSessionManager();
    registerIpcHandlers(sm, { ipcMain: ipc, broadcast });

    const result = (await ipc.invoke(IPC_CHANNELS.signOut)) as {
      ok: true;
      data: { logoutUrl: string };
    };

    expect(result.data.logoutUrl).toBe('https://logout');
    expect(broadcast).toHaveBeenCalledWith({ user: null });
  });

  it('getAccessToken returns the token in the data field', async () => {
    const ipc = makeIpcMain();
    const sm = makeSessionManager({ getAccessToken: vi.fn(async () => 'access_xyz') });
    registerIpcHandlers(sm, { ipcMain: ipc, broadcast: vi.fn() });

    const result = (await ipc.invoke(IPC_CHANNELS.getAccessToken)) as {
      ok: true;
      data: string | null;
    };
    expect(result.data).toBe('access_xyz');
  });
});

describe('broadcastAuthChange', () => {
  it('sends to every live window and skips destroyed ones', () => {
    const live = { webContents: { isDestroyed: () => false, send: vi.fn() } };
    const dead = { webContents: { isDestroyed: () => true, send: vi.fn() } };
    const bw: BrowserWindowsLike = { getAllWindows: () => [live, dead] };

    broadcastAuthChange({ user: null }, { browserWindow: bw });

    expect(live.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.authChanged, {
      user: null,
    });
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});

describe('broadcastAuthError', () => {
  it('sends a safe error payload on the auth-error channel to every live window', () => {
    const live = { webContents: { isDestroyed: () => false, send: vi.fn() } };
    const dead = { webContents: { isDestroyed: () => true, send: vi.fn() } };
    const bw: BrowserWindowsLike = { getAllWindows: () => [live, dead] };

    broadcastAuthError({ code: 'access_denied', message: 'nope' }, { browserWindow: bw });

    expect(live.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.authError, {
      code: 'access_denied',
      message: 'nope',
    });
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});
