import type { User } from '@workos-inc/node';
import type { AuthKitCore, AuthOperations } from '@workos/authkit-session';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthResult, BaseTokenClaims, Session, TokenStorage } from '../../shared/types.js';
import { createSessionManager } from '../session-manager.js';

/**
 * Unit-test the session-manager's orchestration against FAKE `core` /
 * `operations` test doubles.
 *
 * Rationale: the session-manager depends on `AuthKitCore` / `AuthOperations` by
 * interface. Driving it through the real composition would require a live JWKS
 * endpoint (the core verifies the access token's signature over the network),
 * and pnpm's nested module layout prevents a module mock from intercepting the
 * verification library imported by authkit-session's pre-built `dist`. Faking
 * the two collaborators tests exactly this phase's logic (decrypt ->
 * validate/refresh -> persist, signOut, switchToOrganization) deterministically
 * and in milliseconds. See the implementation notes for the full reasoning.
 */

const fakeUser = { id: 'user_1', email: 'a@b.com' } as unknown as User;

function claims(overrides: Partial<BaseTokenClaims> = {}): BaseTokenClaims {
  return { sid: 'session_1', ...overrides };
}

/** Build a `core` test double with controllable behavior. */
function makeCore(behavior: {
  validateAndRefresh?: ReturnType<typeof vi.fn>;
  parseTokenClaims?: ReturnType<typeof vi.fn>;
}): {
  core: AuthKitCore;
  validateAndRefresh: ReturnType<typeof vi.fn>;
  parseTokenClaims: ReturnType<typeof vi.fn>;
} {
  const validateAndRefresh = behavior.validateAndRefresh ?? vi.fn();
  const parseTokenClaims = behavior.parseTokenClaims ?? vi.fn(() => claims());
  return {
    core: { validateAndRefresh, parseTokenClaims } as unknown as AuthKitCore,
    validateAndRefresh,
    parseTokenClaims,
  };
}

/** Build an `operations` test double. */
function makeOperations(behavior: {
  getLogoutUrl?: ReturnType<typeof vi.fn>;
  switchOrganization?: ReturnType<typeof vi.fn>;
}): {
  operations: AuthOperations;
  getLogoutUrl: ReturnType<typeof vi.fn>;
  switchOrganization: ReturnType<typeof vi.fn>;
} {
  const getLogoutUrl =
    behavior.getLogoutUrl ??
    vi.fn((sid: string) => `https://api.workos.com/logout?session_id=${sid}`);
  const switchOrganization = behavior.switchOrganization ?? vi.fn();
  return {
    operations: {
      getLogoutUrl,
      switchOrganization,
    } as unknown as AuthOperations,
    getLogoutUrl,
    switchOrganization,
  };
}

/** In-memory TokenStorage with spies. */
function makeStorage(initial: Session | null): TokenStorage & {
  setSession: ReturnType<typeof vi.fn>;
  clearSession: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const setSession = vi.fn((s: Session) => {
    current = s;
  });
  const clearSession = vi.fn(() => {
    current = null;
  });
  return {
    getSession: () => current,
    setSession,
    clearSession,
    getOrCreateCookiePassword: () => 'x'.repeat(32),
  };
}

const session: Session = {
  accessToken: 'access_1',
  refreshToken: 'refresh_1',
  user: fakeUser,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUser', () => {
  it('returns { user: null } when there is no stored session', async () => {
    const { core } = makeCore({});
    const { operations } = makeOperations({});
    const storage = makeStorage(null);
    const manager = createSessionManager({ core, operations, storage });

    const auth = await manager.getUser();
    expect(auth.user).toBeNull();
  });

  it('returns the user without persisting when the token is still valid', async () => {
    const validateAndRefresh = vi.fn(async () => ({
      valid: true,
      refreshed: false,
      session,
      claims: claims({ org_id: 'org_1' }),
    }));
    const { core } = makeCore({ validateAndRefresh });
    const { operations } = makeOperations({});
    const storage = makeStorage(session);
    const manager = createSessionManager({ core, operations, storage });

    const auth = await manager.getUser();

    expect(validateAndRefresh).toHaveBeenCalledTimes(1);
    expect(storage.setSession).not.toHaveBeenCalled();
    expect(auth.user).toEqual(fakeUser);
    if (auth.user) {
      expect(auth.accessToken).toBe('access_1');
      expect(auth.sessionId).toBe('session_1');
      expect(auth.organizationId).toBe('org_1');
    }
  });

  it('persists the refreshed session exactly once on the refresh path', async () => {
    const refreshedSession: Session = {
      accessToken: 'access_2',
      refreshToken: 'refresh_2',
      user: fakeUser,
    };
    const validateAndRefresh = vi.fn(async () => ({
      valid: true,
      refreshed: true,
      session: refreshedSession,
      claims: claims({ sid: 'session_2', org_id: 'org_2' }),
    }));
    const { core } = makeCore({ validateAndRefresh });
    const { operations } = makeOperations({});
    const storage = makeStorage(session);
    const manager = createSessionManager({ core, operations, storage });

    const auth = await manager.getUser();

    expect(validateAndRefresh).toHaveBeenCalledTimes(1);
    expect(storage.setSession).toHaveBeenCalledTimes(1);
    expect(storage.setSession).toHaveBeenCalledWith(refreshedSession);
    expect(auth.user).toEqual(fakeUser);
    if (auth.user) {
      expect(auth.accessToken).toBe('access_2');
      expect(auth.sessionId).toBe('session_2');
    }
  });

  it('clears the session and returns { user: null } when refresh throws', async () => {
    const validateAndRefresh = vi.fn(async () => {
      throw new Error('invalid_grant');
    });
    const { core } = makeCore({ validateAndRefresh });
    const { operations } = makeOperations({});
    const storage = makeStorage(session);
    const manager = createSessionManager({ core, operations, storage });

    const auth = await manager.getUser();

    expect(auth.user).toBeNull();
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
  });
});

describe('getAccessToken', () => {
  it('returns the access token when signed in', async () => {
    const validateAndRefresh = vi.fn(async () => ({
      valid: true,
      refreshed: false,
      session,
      claims: claims(),
    }));
    const { core } = makeCore({ validateAndRefresh });
    const { operations } = makeOperations({});
    const manager = createSessionManager({
      core,
      operations,
      storage: makeStorage(session),
    });

    expect(await manager.getAccessToken()).toBe('access_1');
  });

  it('returns null when signed out', async () => {
    const { core } = makeCore({});
    const { operations } = makeOperations({});
    const manager = createSessionManager({
      core,
      operations,
      storage: makeStorage(null),
    });

    expect(await manager.getAccessToken()).toBeNull();
  });

  it('returns null when the refresh path fails', async () => {
    const validateAndRefresh = vi.fn(async () => {
      throw new Error('invalid_grant');
    });
    const { core } = makeCore({ validateAndRefresh });
    const { operations } = makeOperations({});
    const manager = createSessionManager({
      core,
      operations,
      storage: makeStorage(session),
    });

    expect(await manager.getAccessToken()).toBeNull();
  });
});

describe('signOut', () => {
  it('returns the WorkOS logout URL (keyed by sid) and clears the session', async () => {
    const parseTokenClaims = vi.fn(() => claims({ sid: 'session_xyz' }));
    const getLogoutUrl = vi.fn((sid: string) => `https://api.workos.com/logout?session_id=${sid}`);
    const { core } = makeCore({ parseTokenClaims });
    const { operations } = makeOperations({ getLogoutUrl });
    const storage = makeStorage(session);
    const manager = createSessionManager({ core, operations, storage });

    const { logoutUrl } = await manager.signOut();

    expect(getLogoutUrl).toHaveBeenCalledWith('session_xyz', {
      returnTo: undefined,
    });
    expect(logoutUrl).toContain('session_id=session_xyz');
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
  });

  it('forwards returnTo to getLogoutUrl', async () => {
    const getLogoutUrl = vi.fn(() => 'https://api.workos.com/logout');
    const { core } = makeCore({});
    const { operations } = makeOperations({ getLogoutUrl });
    const manager = createSessionManager({
      core,
      operations,
      storage: makeStorage(session),
    });

    await manager.signOut({ returnTo: 'https://app.example.com' });

    expect(getLogoutUrl).toHaveBeenCalledWith('session_1', {
      returnTo: 'https://app.example.com',
    });
  });

  it('clears the session and returns an empty URL when signed out', async () => {
    const { core } = makeCore({});
    const { operations, getLogoutUrl } = makeOperations({});
    const storage = makeStorage(null);
    const manager = createSessionManager({ core, operations, storage });

    const { logoutUrl } = await manager.signOut();

    expect(logoutUrl).toBe('');
    expect(getLogoutUrl).not.toHaveBeenCalled();
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
  });

  it('still clears the session when the access token cannot be parsed', async () => {
    const parseTokenClaims = vi.fn(() => {
      throw new Error('malformed token');
    });
    const { core } = makeCore({ parseTokenClaims });
    const { operations, getLogoutUrl } = makeOperations({});
    const storage = makeStorage(session);
    const manager = createSessionManager({ core, operations, storage });

    const { logoutUrl } = await manager.signOut();

    expect(logoutUrl).toBe('');
    expect(getLogoutUrl).not.toHaveBeenCalled();
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
  });
});

describe('switchToOrganization', () => {
  it('persists the new org-scoped session reconstructed from the auth result', async () => {
    const auth: AuthResult = {
      user: fakeUser,
      sessionId: 'session_1',
      accessToken: 'access_org2',
      refreshToken: 'refresh_org2',
      claims: claims({ org_id: 'org_2' }),
      organizationId: 'org_2',
    };
    const switchOrganization = vi.fn(async () => ({
      auth,
      encryptedSession: 'sealed-blob',
    }));
    const { core } = makeCore({});
    const { operations } = makeOperations({ switchOrganization });
    const storage = makeStorage(session);
    const manager = createSessionManager({ core, operations, storage });

    const result = await manager.switchToOrganization('org_2');

    expect(switchOrganization).toHaveBeenCalledWith(session, 'org_2');
    expect(storage.setSession).toHaveBeenCalledWith({
      accessToken: 'access_org2',
      refreshToken: 'refresh_org2',
      user: fakeUser,
      impersonator: undefined,
    });
    expect(result.user).toEqual(fakeUser);
    if (result.user) {
      expect(result.organizationId).toBe('org_2');
    }
  });

  it('returns { user: null } and persists nothing when signed out', async () => {
    const { core } = makeCore({});
    const { operations, switchOrganization } = makeOperations({});
    const storage = makeStorage(null);
    const manager = createSessionManager({ core, operations, storage });

    const result = await manager.switchToOrganization('org_2');

    expect(result.user).toBeNull();
    expect(switchOrganization).not.toHaveBeenCalled();
    expect(storage.setSession).not.toHaveBeenCalled();
  });
});
