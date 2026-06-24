import type { User } from '@workos-inc/node';
import { describe, expect, it } from 'vitest';
import type { AuthResult, BaseTokenClaims } from '../types.js';
import { toRendererAuthPayload } from '../types.js';

const fakeUser = { id: 'user_1', email: 'a@b.com' } as unknown as User;

const claims: BaseTokenClaims = {
  sid: 'session_1',
  org_id: 'org_1',
  role: 'admin',
  roles: ['admin'],
  permissions: ['read'],
  entitlements: ['feature_x'],
  feature_flags: ['flag_y'],
};

describe('toRendererAuthPayload', () => {
  it('passes through { user: null } unchanged', () => {
    expect(toRendererAuthPayload({ user: null })).toEqual({ user: null });
  });

  it('STRIPS the refresh token from a signed-in auth result', () => {
    const auth: AuthResult = {
      user: fakeUser,
      sessionId: 'session_1',
      accessToken: 'access_1',
      refreshToken: 'refresh_SECRET',
      claims,
      organizationId: 'org_1',
    };

    const payload = toRendererAuthPayload(auth);

    // The single most important guarantee: no refresh token crosses IPC.
    expect(payload).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(payload)).not.toContain('refresh_SECRET');
  });

  it('preserves the renderer-safe fields', () => {
    const auth: AuthResult = {
      user: fakeUser,
      sessionId: 'session_1',
      accessToken: 'access_1',
      refreshToken: 'refresh_1',
      claims,
      organizationId: 'org_1',
      role: 'admin',
      roles: ['admin'],
      permissions: ['read'],
      entitlements: ['feature_x'],
      featureFlags: ['flag_y'],
    };

    const payload = toRendererAuthPayload(auth);

    expect(payload).toMatchObject({
      user: fakeUser,
      sessionId: 'session_1',
      accessToken: 'access_1',
      organizationId: 'org_1',
      role: 'admin',
      roles: ['admin'],
      permissions: ['read'],
      entitlements: ['feature_x'],
      featureFlags: ['flag_y'],
    });
  });

  it('carries through an impersonator when present', () => {
    const impersonator = { email: 'admin@workos.com', reason: 'support' };
    const auth: AuthResult = {
      user: fakeUser,
      sessionId: 'session_1',
      accessToken: 'access_1',
      refreshToken: 'refresh_1',
      claims,
      impersonator,
    };

    const payload = toRendererAuthPayload(auth);
    if (payload.user) {
      expect(payload.impersonator).toEqual(impersonator);
    }
  });
});
