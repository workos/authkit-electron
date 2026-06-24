// @vitest-environment jsdom

/**
 * <SignedIn> / <SignedOut> guard tests.
 *
 * Renders both guards inside AuthKitProvider with a mocked bridge and asserts
 * which children show for signed-in vs signed-out state, that neither renders
 * while loading, and that a sign-out push flips them.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthKitBridge } from '../../preload/index.js';
import type { IpcResult } from '../../main/ipc-handlers.js';
import type { RendererAuthPayload, User } from '../../shared/types.js';
import { AUTHKIT_BRIDGE_KEY } from '../../preload/index.js';
import { AuthKitProvider } from '../auth-kit-provider.js';
import { SignedIn, SignedOut } from '../guards.js';

const fakeUser = { id: 'user_123', email: 'ada@example.com' } as unknown as User;

function signedInPayload(): RendererAuthPayload {
  return {
    user: fakeUser,
    sessionId: 'sess_1',
    accessToken: 'tok_abc',
    claims: { sub: 'user_123' } as never,
  } as RendererAuthPayload;
}

function makeBridge(getUserResult: IpcResult<RendererAuthPayload>): {
  bridge: AuthKitBridge;
  emit: (p: RendererAuthPayload) => void;
} {
  const listeners = new Set<(p: RendererAuthPayload) => void>();
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
  };
}

function installBridge(bridge: AuthKitBridge): void {
  (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY] = bridge;
}

function Guarded(): React.JSX.Element {
  return (
    <AuthKitProvider>
      <SignedIn>
        <span data-testid="in">welcome</span>
      </SignedIn>
      <SignedOut>
        <span data-testid="out">please sign in</span>
      </SignedOut>
    </AuthKitProvider>
  );
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[AUTHKIT_BRIDGE_KEY];
  vi.clearAllMocks();
});

describe('SignedIn / SignedOut', () => {
  it('renders neither while loading', () => {
    const { bridge } = makeBridge({ ok: true, data: signedInPayload() });
    installBridge(bridge);
    render(<Guarded />);
    // First synchronous render: still loading, so both guards render null.
    expect(screen.queryByTestId('in')).toBeNull();
    expect(screen.queryByTestId('out')).toBeNull();
  });

  it('renders SignedIn children when a user is present', async () => {
    const { bridge } = makeBridge({ ok: true, data: signedInPayload() });
    installBridge(bridge);
    render(<Guarded />);

    await waitFor(() => expect(screen.queryByTestId('in')).not.toBeNull());
    expect(screen.queryByTestId('out')).toBeNull();
  });

  it('renders SignedOut children when no user is present', async () => {
    const { bridge } = makeBridge({ ok: true, data: { user: null } });
    installBridge(bridge);
    render(<Guarded />);

    await waitFor(() => expect(screen.queryByTestId('out')).not.toBeNull());
    expect(screen.queryByTestId('in')).toBeNull();
  });

  it('flips from SignedIn to SignedOut on an auth-change push', async () => {
    const { bridge, emit } = makeBridge({ ok: true, data: signedInPayload() });
    installBridge(bridge);
    render(<Guarded />);

    await waitFor(() => expect(screen.queryByTestId('in')).not.toBeNull());

    act(() => emit({ user: null }));
    await waitFor(() => expect(screen.queryByTestId('out')).not.toBeNull());
    expect(screen.queryByTestId('in')).toBeNull();
  });
});
