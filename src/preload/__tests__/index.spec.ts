import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/ipc-channels.js';

/**
 * Preload bridge tests.
 *
 * The preload imports `contextBridge` / `ipcRenderer` from electron at module
 * load. We mock those and assert: (1) `exposeAuthKit` exposes under the right
 * key via `contextBridge` when `process.contextIsolated` is true; (2) it falls
 * back to `window`/`globalThis` when isolation is off; (3) the bridge methods
 * call `ipcRenderer.invoke` on the SHARED channel names (no redeclaration).
 */

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, data: null }));
const on = vi.fn((..._args: unknown[]) => {});
const removeListener = vi.fn((..._args: unknown[]) => {});
const exposeInMainWorld = vi.fn((..._args: unknown[]) => {});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (...args: unknown[]) => exposeInMainWorld(...args),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (...args: unknown[]) => on(...args),
    removeListener: (...args: unknown[]) => removeListener(...args),
  },
}));

import { AUTHKIT_BRIDGE_KEY, type AuthKitBridge, exposeAuthKit } from '../index.js';

/** Capture the bridge object handed to whichever exposure path ran. */
function exposedBridge(): AuthKitBridge {
  return exposeInMainWorld.mock.calls[0]?.[1] as AuthKitBridge;
}

const originalContextIsolated = process.contextIsolated;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, 'contextIsolated', {
    value: originalContextIsolated,
    configurable: true,
  });
  delete (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY];
});

describe('exposeAuthKit — contextIsolated branch', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true });
  });

  it('exposes the bridge via contextBridge under the SDK key', () => {
    exposeAuthKit();
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe(AUTHKIT_BRIDGE_KEY);
    const bridge = exposedBridge();
    expect(typeof bridge.signIn).toBe('function');
    expect(typeof bridge.signOut).toBe('function');
    expect(typeof bridge.getUser).toBe('function');
    expect(typeof bridge.getAccessToken).toBe('function');
    expect(typeof bridge.switchToOrganization).toBe('function');
    expect(typeof bridge.onAuthChange).toBe('function');
  });

  it('throws a clear error when contextBridge exposure fails', () => {
    exposeInMainWorld.mockImplementationOnce(() => {
      throw new Error('already set up');
    });
    // A failed expose is a setup bug — fail loudly at the source rather than
    // letting the renderer hit an undefined bridge later.
    expect(() => exposeAuthKit()).toThrow(/failed to expose the preload bridge/);
  });
});

describe('exposeAuthKit — no context isolation', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'contextIsolated', { value: false, configurable: true });
  });

  it('falls back to assigning the bridge on globalThis/window', () => {
    exposeAuthKit();
    expect(exposeInMainWorld).not.toHaveBeenCalled();
    const bridge = (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY] as AuthKitBridge;
    expect(typeof bridge.getUser).toBe('function');
  });
});

describe('bridge methods → ipcRenderer on shared channels', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true });
    exposeAuthKit();
  });

  it('invokes the correct shared channel for each method', async () => {
    const bridge = exposedBridge();

    await bridge.signIn({ screenHint: 'sign-in' });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.signIn, { screenHint: 'sign-in' });

    await bridge.signOut({ returnTo: 'x' });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.signOut, { returnTo: 'x' });

    await bridge.getUser();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getUser);

    await bridge.getAccessToken();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getAccessToken);

    await bridge.switchToOrganization('org_2');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.switchToOrganization, 'org_2');
  });

  it('onAuthChange subscribes on the auth-changed channel and returns an unsubscribe', () => {
    const bridge = exposedBridge();
    const cb = vi.fn();
    const unsubscribe = bridge.onAuthChange(cb);

    expect(on).toHaveBeenCalledWith(IPC_CHANNELS.authChanged, expect.any(Function));
    // Simulate a main→renderer push and assert the payload is forwarded.
    const listener = on.mock.calls[0]?.[1] as (e: unknown, p: unknown) => void;
    listener({}, { user: null });
    expect(cb).toHaveBeenCalledWith({ user: null });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.authChanged, expect.any(Function));
  });
});
