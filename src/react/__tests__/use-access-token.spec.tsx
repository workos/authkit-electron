// @vitest-environment jsdom

/**
 * useAccessToken tests.
 *
 * Renders a probe inside AuthKitProvider with a mocked bridge and asserts:
 * initial fetch, null-when-signed-out, refresh returning a rotated token,
 * error surfaced from an `{ ok: false }` result, and the race guard (a token
 * resolving AFTER a sign-out push must not be written).
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthKitBridge } from '../../preload/index.js';
import type { IpcResult } from '../../shared/ipc.js';
import type { RendererAuthPayload, User } from '../../shared/types.js';
import { AUTHKIT_BRIDGE_KEY } from '../../preload/index.js';
import { AuthKitProvider } from '../auth-kit-provider.js';
import { useAccessToken } from '../use-access-token.js';

const fakeUser = { id: 'user_123', email: 'ada@example.com' } as unknown as User;

function signedInPayload(): RendererAuthPayload {
  return {
    user: fakeUser,
    sessionId: 'sess_1',
    accessToken: 'tok_abc',
    claims: { sub: 'user_123' } as never,
  } as RendererAuthPayload;
}

/** A mock typed to the bridge's getAccessToken signature. */
type GetAccessTokenMock = ReturnType<typeof vi.fn<AuthKitBridge['getAccessToken']>>;

interface BridgeHandle {
  bridge: AuthKitBridge;
  emit: (p: RendererAuthPayload) => void;
  getAccessToken: GetAccessTokenMock;
}

/**
 * Build a bridge whose getUser is signed-in (so the provider settles) and whose
 * getAccessToken behavior is supplied per test. A deferred variant lets a test
 * control resolution timing for the race guard.
 */
function makeBridge(getAccessToken: GetAccessTokenMock): BridgeHandle {
  // Both the provider AND useAccessToken subscribe, so the mock must fan out to
  // every listener — not just the most recent one.
  const listeners = new Set<(p: RendererAuthPayload) => void>();
  const bridge: AuthKitBridge = {
    signIn: vi.fn(async () => ({ ok: true as const, data: null })),
    signOut: vi.fn(async () => ({ ok: true as const, data: { logoutUrl: 'https://logout' } })),
    getUser: vi.fn(
      async () => ({ ok: true, data: signedInPayload() }) as IpcResult<RendererAuthPayload>,
    ),
    getAccessToken,
    switchToOrganization: vi.fn(async () => ({ ok: true as const, data: signedInPayload() })),
    onAuthChange: vi.fn((cb: (p: RendererAuthPayload) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    onAuthError: vi.fn(() => () => {}),
  };
  return {
    bridge,
    emit: (p) => {
      for (const cb of listeners) {
        cb(p);
      }
    },
    getAccessToken,
  };
}

function installBridge(bridge: AuthKitBridge): void {
  (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY] = bridge;
}

/** Probe exposing the hook result + a button that calls refresh(). */
function TokenProbe(): React.JSX.Element {
  const { accessToken, isLoading, error, refresh } = useAccessToken();
  return (
    <div>
      <span data-testid="token">{accessToken ?? 'null'}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="error">{error ? error.message : 'none'}</span>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <AuthKitProvider>
      <TokenProbe />
    </AuthKitProvider>,
  );
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY];
  vi.clearAllMocks();
});

describe('useAccessToken', () => {
  it('fetches the token on mount', async () => {
    const { bridge, getAccessToken } = makeBridge(
      vi.fn(async () => ({ ok: true, data: 'tok_abc' }) as IpcResult<string | null>),
    );
    installBridge(bridge);

    renderProbe();

    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('tok_abc'));
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(getAccessToken).toHaveBeenCalled();
  });

  it('exposes null when the token is null (signed out)', async () => {
    const { bridge } = makeBridge(
      vi.fn(async () => ({ ok: true, data: null }) as IpcResult<string | null>),
    );
    installBridge(bridge);

    renderProbe();

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('token').textContent).toBe('null');
  });

  it('refresh() returns and stores a rotated token', async () => {
    let call = 0;
    const { bridge } = makeBridge(
      vi.fn(async () => {
        call += 1;
        return { ok: true, data: call === 1 ? 'tok_1' : 'tok_2' } as IpcResult<string | null>;
      }),
    );
    installBridge(bridge);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('tok_1'));

    await act(async () => {
      screen.getByText('refresh').click();
    });
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('tok_2'));
  });

  it('surfaces an error from an { ok: false } result', async () => {
    const { bridge } = makeBridge(
      vi.fn(
        async () =>
          ({ ok: false, error: { code: 'TokenError', message: 'expired' } }) as IpcResult<
            string | null
          >,
      ),
    );
    installBridge(bridge);

    renderProbe();

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('expired'));
    expect(screen.getByTestId('token').textContent).toBe('null');
  });

  it('re-fetches the token on an onAuthChange (org switch / refresh)', async () => {
    let call = 0;
    const { bridge, emit } = makeBridge(
      vi.fn(async () => {
        call += 1;
        return { ok: true, data: `tok_${call}` } as IpcResult<string | null>;
      }),
    );
    installBridge(bridge);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('tok_1'));

    act(() => emit(signedInPayload()));
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('tok_2'));
  });

  it('clears the token on an onAuthChange sign-out', async () => {
    const { bridge, emit } = makeBridge(
      vi.fn(async () => ({ ok: true, data: 'tok_abc' }) as IpcResult<string | null>),
    );
    installBridge(bridge);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('tok_abc'));

    act(() => emit({ user: null }));
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('null'));
  });

  it('ignores a token that resolves AFTER a sign-out (race guard)', async () => {
    // A deferred getAccessToken we resolve manually, to interleave with sign-out.
    let resolveToken!: (r: IpcResult<string | null>) => void;
    const deferred = new Promise<IpcResult<string | null>>((res) => {
      resolveToken = res;
    });
    let firstCall = true;
    const { bridge, emit } = makeBridge(
      vi.fn(() => {
        if (firstCall) {
          firstCall = false;
          return deferred;
        }
        return Promise.resolve({ ok: true, data: null } as IpcResult<string | null>);
      }),
    );
    installBridge(bridge);

    renderProbe();
    // Mount fetch is in flight (deferred, unresolved). Sign out arrives first.
    act(() => emit({ user: null }));
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('null'));

    // Now the in-flight fetch resolves with a (now stale) token. It must NOT
    // overwrite the signed-out null state.
    await act(async () => {
      resolveToken({ ok: true, data: 'stale_tok' });
      await deferred;
    });
    expect(screen.getByTestId('token').textContent).toBe('null');
  });
});
