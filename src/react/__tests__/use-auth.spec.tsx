// @vitest-environment jsdom

/**
 * AuthKitProvider + useAuth tests.
 *
 * Renders the provider with a mocked `window.__authkit_electron` and asserts:
 * the on-mount `getUser` fetch, the `onAuthChange` push update (including a
 * sign-out from "another window"), unsubscribe on unmount, and the
 * missing-bridge error from `useBridge()`.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthKitBridge } from '../../preload/index.js';
import type { IpcResult } from '../../shared/ipc.js';
import type { RendererAuthPayload, User } from '../../shared/types.js';
import { AuthKitProvider } from '../auth-kit-provider.js';
import { AUTHKIT_BRIDGE_KEY } from '../../preload/index.js';
import { useAuth } from '../use-auth.js';

const fakeUser = { id: 'user_123', email: 'ada@example.com' } as unknown as User;

function signedInPayload(overrides: Partial<RendererAuthPayload> = {}): RendererAuthPayload {
  return {
    user: fakeUser,
    sessionId: 'sess_1',
    accessToken: 'tok_abc',
    claims: { sub: 'user_123' } as never,
    organizationId: 'org_1',
    role: 'admin',
    roles: ['admin'],
    permissions: ['widgets:read'],
    entitlements: ['pro'],
    featureFlags: ['beta'],
    ...overrides,
  } as RendererAuthPayload;
}

/** A controllable mock bridge. `emit` fires a main→renderer auth-change push. */
function makeBridge(getUserResult: IpcResult<RendererAuthPayload>): {
  bridge: AuthKitBridge;
  emit: (p: RendererAuthPayload) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(p: RendererAuthPayload) => void>();
  const unsubscribe = vi.fn(() => {});
  const bridge: AuthKitBridge = {
    signIn: vi.fn(async () => ({ ok: true as const, data: null })),
    signOut: vi.fn(async () => ({ ok: true as const, data: { logoutUrl: 'https://logout' } })),
    getUser: vi.fn(async () => getUserResult),
    getAccessToken: vi.fn(async () => ({ ok: true as const, data: 'tok_abc' })),
    switchToOrganization: vi.fn(async () => ({ ok: true as const, data: signedInPayload() })),
    onAuthChange: vi.fn((cb: (p: RendererAuthPayload) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        unsubscribe();
      };
    }),
  };
  return {
    bridge,
    emit: (p) => {
      for (const cb of listeners) {
        cb(p);
      }
    },
    unsubscribe,
  };
}

function installBridge(bridge: AuthKitBridge | undefined): void {
  if (bridge) {
    (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY] = bridge;
  } else {
    delete (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY];
  }
}

/** A consumer that renders the current auth snapshot for assertions. */
function AuthProbe(): React.JSX.Element {
  const { user, isLoading, organizationId, role } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user">{user ? user.email : 'none'}</span>
      <span data-testid="org">{organizationId ?? 'none'}</span>
      <span data-testid="role">{role ?? 'none'}</span>
    </div>
  );
}

afterEach(() => {
  installBridge(undefined);
  vi.clearAllMocks();
});

describe('AuthKitProvider + useAuth', () => {
  it('starts loading, then reflects a signed-in getUser result', async () => {
    const { bridge } = makeBridge({ ok: true, data: signedInPayload() });
    installBridge(bridge);

    render(
      <AuthKitProvider>
        <AuthProbe />
      </AuthKitProvider>,
    );

    // Initial render is the loading state.
    expect(screen.getByTestId('loading').textContent).toBe('true');

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('user').textContent).toBe('ada@example.com');
    expect(screen.getByTestId('org').textContent).toBe('org_1');
    expect(screen.getByTestId('role').textContent).toBe('admin');
    expect(bridge.getUser).toHaveBeenCalledTimes(1);
  });

  it('resolves to signed-out when getUser returns { user: null }', async () => {
    const { bridge } = makeBridge({ ok: true, data: { user: null } });
    installBridge(bridge);

    render(
      <AuthKitProvider>
        <AuthProbe />
      </AuthKitProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('resolves to signed-out when getUser returns an error result', async () => {
    const { bridge } = makeBridge({ ok: false, error: { code: 'Boom', message: 'nope' } });
    installBridge(bridge);

    render(
      <AuthKitProvider>
        <AuthProbe />
      </AuthKitProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('updates when onAuthChange pushes a sign-out from another window', async () => {
    const { bridge, emit } = makeBridge({ ok: true, data: signedInPayload() });
    installBridge(bridge);

    render(
      <AuthKitProvider>
        <AuthProbe />
      </AuthKitProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('ada@example.com'));

    // A second window signed out → this renderer should reflect it.
    act(() => emit({ user: null }));
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'));
  });

  it('updates when onAuthChange pushes a new signed-in payload', async () => {
    const { bridge, emit } = makeBridge({ ok: true, data: { user: null } });
    installBridge(bridge);

    render(
      <AuthKitProvider>
        <AuthProbe />
      </AuthKitProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('user').textContent).toBe('none');

    act(() => emit(signedInPayload({ organizationId: 'org_2' } as Partial<RendererAuthPayload>)));
    await waitFor(() => expect(screen.getByTestId('org').textContent).toBe('org_2'));
    expect(screen.getByTestId('user').textContent).toBe('ada@example.com');
  });

  it('unsubscribes from onAuthChange on unmount', async () => {
    const { bridge, unsubscribe } = makeBridge({ ok: true, data: signedInPayload() });
    installBridge(bridge);

    const { unmount } = render(
      <AuthKitProvider>
        <AuthProbe />
      </AuthKitProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('useAuth throws outside an AuthKitProvider', () => {
    // Render the probe with no provider; React surfaces the thrown error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<AuthProbe />)).toThrow(/must be used within an <AuthKitProvider>/);
    spy.mockRestore();
  });

  it('useBridge throws a clear error when the preload bridge is missing', () => {
    installBridge(undefined);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <AuthKitProvider>
          <AuthProbe />
        </AuthKitProvider>,
      ),
    ).toThrow(/window\.__authkit_electron is missing/);
    spy.mockRestore();
  });
});

/** Captures the action functions + token so a test can invoke them. */
let captured: ReturnType<typeof useAuth> | null = null;
function ActionProbe(): React.JSX.Element {
  captured = useAuth();
  return <span data-testid="ready">{captured.isLoading ? 'loading' : 'ready'}</span>;
}

describe('AuthKitProvider — actions', () => {
  afterEach(() => {
    captured = null;
  });

  async function mount(bridge: AuthKitBridge): Promise<void> {
    installBridge(bridge);
    render(
      <AuthKitProvider>
        <ActionProbe />
      </AuthKitProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('ready'));
  }

  it('signIn / signOut / switchToOrganization delegate to the bridge', async () => {
    const { bridge } = makeBridge({ ok: true, data: signedInPayload() });
    await mount(bridge);

    await captured!.signIn({ screenHint: 'sign-up' });
    expect(bridge.signIn).toHaveBeenCalledWith({ screenHint: 'sign-up' });

    await captured!.signOut({ returnTo: '/bye' });
    expect(bridge.signOut).toHaveBeenCalledWith({ returnTo: '/bye' });

    await captured!.switchToOrganization('org_9');
    expect(bridge.switchToOrganization).toHaveBeenCalledWith('org_9');
  });

  it('getAccessToken returns the token, or null on an error result', async () => {
    const { bridge } = makeBridge({ ok: true, data: signedInPayload() });
    await mount(bridge);

    await expect(captured!.getAccessToken()).resolves.toBe('tok_abc');

    (bridge.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { code: 'X', message: 'no token' },
    });
    await expect(captured!.getAccessToken()).resolves.toBeNull();
  });

  it('wraps a failed action in a thrown Error', async () => {
    const { bridge } = makeBridge({ ok: true, data: signedInPayload() });
    (bridge.signIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { code: 'CeremonyError', message: 'browser blocked' },
    });
    await mount(bridge);

    await expect(captured!.signIn()).rejects.toThrow(/signIn failed: browser blocked/);
  });
});
