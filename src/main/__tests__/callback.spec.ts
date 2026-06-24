import { type WorkOS, createWorkOS } from '@workos-inc/node';
import {
  AuthKitCore,
  AuthOperations,
  OAuthStateMismatchError,
  PKCECookieMissingError,
  sessionEncryption,
} from '@workos/authkit-session';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ceremony } from '../ceremony/index.js';
import { createDefaultStorage } from '../storage.js';
import { createSessionManager } from '../session-manager.js';
import type { AuthKitConfig } from '@workos/authkit-session';
import type { KeyValueStoreLike, SafeStorageLike } from '../storage.js';

/**
 * Callback re-orchestration tests.
 *
 * The headline-risk logic is the PKCE state round-trip + code exchange. We
 * exercise it with HIGH fidelity: a REAL public WorkOS client (its `pkce` +
 * `getAuthorizationUrl` are local — no network), a REAL `AuthKitCore` /
 * `AuthOperations` so `createAuthorization` and `verifyCallbackState` run the
 * actual authkit-session seal/unseal, and only `authenticateWithCode` mocked.
 * This catches state-mismatch and missing-state regressions for real, not
 * against a stubbed verifier.
 */

const COOKIE_PASSWORD = 'x'.repeat(32);
const CLIENT_ID = 'client_test';
const REDIRECT_URI = 'workos-auth://callback';

const config: AuthKitConfig = {
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  cookiePassword: COOKIE_PASSWORD,
  apiKey: '',
  apiHttps: true,
  cookieMaxAge: 1000,
  cookieName: 'wos-session',
};

const fakeUser = { id: 'user_1', email: 'a@b.com' } as unknown as Awaited<
  ReturnType<WorkOS['userManagement']['authenticateWithCode']>
>['user'];

/** A real public client + real core/operations sharing one encryption. */
function makeRealComposition(): {
  core: AuthKitCore;
  operations: AuthOperations;
  client: WorkOS;
} {
  const client = createWorkOS({ clientId: CLIENT_ID }) as unknown as WorkOS;
  const core = new AuthKitCore(config, client, sessionEncryption);
  const operations = new AuthOperations(core, client, config, sessionEncryption);
  return { core, operations, client };
}

/** In-memory safeStorage + store, so the real default storage works in node. */
function makeStorage(): ReturnType<typeof createDefaultStorage> {
  const map = new Map<string, unknown>();
  const store: KeyValueStoreLike = {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    delete: (k) => {
      map.delete(k);
    },
  };
  const safeStorage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => b.toString('utf8'),
  };
  return createDefaultStorage({ store, safeStorage });
}

function makeCeremony(): Ceremony {
  return { open: vi.fn(async () => {}), onCallback: () => () => {} };
}

/** Drive a real sign-in to obtain the sealedState the callback will receive. */
async function beginAndCaptureState(
  operations: AuthOperations,
  storage: ReturnType<typeof createDefaultStorage>,
): Promise<string> {
  const { sealedState } = await operations.createAuthorization({ screenHint: 'sign-in' });
  storage.setPendingVerifier(sealedState, sealedState);
  return sealedState;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('completeCallback — happy path', () => {
  it('verifies state, exchanges the code, and persists the session', async () => {
    const { core, operations, client } = makeRealComposition();
    const storage = makeStorage();
    const authenticateWithCode = vi
      .spyOn(client.userManagement, 'authenticateWithCode')
      .mockResolvedValue({
        user: fakeUser,
        accessToken: 'access_new',
        refreshToken: 'refresh_new',
      } as Awaited<ReturnType<WorkOS['userManagement']['authenticateWithCode']>>);
    // Claims are parsed from the access token; stub the local parse.
    vi.spyOn(core, 'parseTokenClaims').mockReturnValue({
      sid: 'session_new',
      org_id: 'org_1',
    });

    const manager = createSessionManager({
      core,
      operations,
      storage,
      client,
      clientId: CLIENT_ID,
      ceremony: makeCeremony(),
    });

    const state = await beginAndCaptureState(operations, storage);
    const auth = await manager.completeCallback('auth_code_123', state);

    expect(authenticateWithCode).toHaveBeenCalledWith({
      code: 'auth_code_123',
      clientId: CLIENT_ID,
      codeVerifier: expect.any(String),
    });
    expect(auth.user).toEqual(fakeUser);
    if (auth.user) {
      expect(auth.accessToken).toBe('access_new');
      expect(auth.sessionId).toBe('session_new');
      expect(auth.organizationId).toBe('org_1');
      // The full main-side AuthResult still carries the refresh token; the IPC
      // layer strips it (asserted in ipc-handlers.spec.ts), not here.
      expect(auth.refreshToken).toBe('refresh_new');
    }
    // Session persisted, and the pending verifier was consumed.
    expect(storage.getSession()?.accessToken).toBe('access_new');
    expect(storage.takePendingVerifier(state)).toBeNull();
  });
});

describe('completeCallback — error paths', () => {
  it('throws OAuthStateMismatchError when state is absent and persists nothing', async () => {
    const { core, operations, client } = makeRealComposition();
    const storage = makeStorage();
    const authenticateWithCode = vi.spyOn(client.userManagement, 'authenticateWithCode');

    const manager = createSessionManager({
      core,
      operations,
      storage,
      client,
      clientId: CLIENT_ID,
      ceremony: makeCeremony(),
    });

    await expect(manager.completeCallback('code', undefined)).rejects.toBeInstanceOf(
      OAuthStateMismatchError,
    );
    expect(authenticateWithCode).not.toHaveBeenCalled();
    expect(storage.getSession()).toBeNull();
  });

  it('throws when state does not match the persisted verifier', async () => {
    const { core, operations, client } = makeRealComposition();
    const storage = makeStorage();
    const authenticateWithCode = vi.spyOn(client.userManagement, 'authenticateWithCode');

    const manager = createSessionManager({
      core,
      operations,
      storage,
      client,
      clientId: CLIENT_ID,
      ceremony: makeCeremony(),
    });

    // A valid sealed state exists, but the callback presents a different one.
    await beginAndCaptureState(operations, storage);

    await expect(
      manager.completeCallback('code', 'a-totally-different-state'),
    ).rejects.toBeInstanceOf(PKCECookieMissingError);
    expect(authenticateWithCode).not.toHaveBeenCalled();
    expect(storage.getSession()).toBeNull();
  });

  it('clears the verifier and throws when authenticateWithCode rejects', async () => {
    const { core, operations, client } = makeRealComposition();
    const storage = makeStorage();
    vi.spyOn(client.userManagement, 'authenticateWithCode').mockRejectedValue(
      new Error('invalid_grant'),
    );

    const manager = createSessionManager({
      core,
      operations,
      storage,
      client,
      clientId: CLIENT_ID,
      ceremony: makeCeremony(),
    });

    const state = await beginAndCaptureState(operations, storage);

    await expect(manager.completeCallback('code', state)).rejects.toThrow('invalid_grant');
    // Nothing persisted, and the verifier was consumed (single-use take ran
    // before the exchange), so a replay finds no verifier.
    expect(storage.getSession()).toBeNull();
    expect(storage.takePendingVerifier(state)).toBeNull();
  });
});

describe('completeCallback — concurrent flows', () => {
  it('resolves two independent sign-ins by their own state', async () => {
    const { core, operations, client } = makeRealComposition();
    const storage = makeStorage();

    // Two sign-ins → two distinct sealed states / verifiers.
    const stateA = await beginAndCaptureState(operations, storage);
    const stateB = await beginAndCaptureState(operations, storage);
    expect(stateA).not.toBe(stateB);

    vi.spyOn(client.userManagement, 'authenticateWithCode').mockImplementation(
      async ({ code }) =>
        ({
          user: fakeUser,
          accessToken: `access_${code}`,
          refreshToken: `refresh_${code}`,
        }) as Awaited<ReturnType<WorkOS['userManagement']['authenticateWithCode']>>,
    );
    vi.spyOn(core, 'parseTokenClaims').mockReturnValue({ sid: 'session_x' });

    const manager = createSessionManager({
      core,
      operations,
      storage,
      client,
      clientId: CLIENT_ID,
      ceremony: makeCeremony(),
    });

    // Completing flow A must not invalidate flow B's verifier.
    const authA = await manager.completeCallback('code_a', stateA);
    const authB = await manager.completeCallback('code_b', stateB);

    expect(authA.user && authA.accessToken).toBe('access_code_a');
    expect(authB.user && authB.accessToken).toBe('access_code_b');
  });
});
