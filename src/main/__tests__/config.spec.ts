import { describe, expect, it } from 'vitest';
import type { AuthKitElectronConfig } from '../../shared/types.js';
import { MIN_COOKIE_PASSWORD_LENGTH, createPublicWorkOS, toAuthKitConfig } from '../config.js';

const base: AuthKitElectronConfig = {
  clientId: 'client_test_123',
  redirectUri: 'workos-auth://callback',
};

const validPassword = 'a'.repeat(MIN_COOKIE_PASSWORD_LENGTH);

describe('toAuthKitConfig', () => {
  it('sets apiKey to the empty string (public client, never read)', () => {
    const config = toAuthKitConfig(base, validPassword);
    expect(config.apiKey).toBe('');
  });

  it('passes through clientId and redirectUri', () => {
    const config = toAuthKitConfig(base, validPassword);
    expect(config.clientId).toBe('client_test_123');
    expect(config.redirectUri).toBe('workos-auth://callback');
  });

  it('fills the core defaults (apiHttps, cookieName, cookieMaxAge)', () => {
    const config = toAuthKitConfig(base, validPassword);
    expect(config.apiHttps).toBe(true);
    expect(config.cookieName).toBe('wos-session');
    expect(config.cookieMaxAge).toBeGreaterThan(0);
  });

  it('accepts an explicit >= 32 char password', () => {
    const explicit = 'x'.repeat(40);
    const config = toAuthKitConfig(base, explicit);
    expect(config.cookiePassword).toBe(explicit);
    expect(config.cookiePassword.length).toBeGreaterThanOrEqual(MIN_COOKIE_PASSWORD_LENGTH);
  });

  it('accepts a freshly generated 32-byte base64url password', () => {
    // base64url of 32 random bytes is ~43 chars — comfortably over the floor.
    const generated = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
    const config = toAuthKitConfig(base, generated);
    expect(config.cookiePassword.length).toBeGreaterThanOrEqual(MIN_COOKIE_PASSWORD_LENGTH);
  });

  it('throws a descriptive error for a too-short password', () => {
    const short = 'a'.repeat(10);
    expect(() => toAuthKitConfig(base, short)).toThrowError(/at least 32 characters/);
  });

  it('accepts a lazy resolver and defers calling it until cookiePassword is read', () => {
    // Lets createAuthKit() defer the OS-keychain read (safeStorage) until the core
    // first dereferences cookiePassword at sign-in seal time — i.e. after app ready.
    let calls = 0;
    const config = toAuthKitConfig(base, () => {
      calls += 1;
      return validPassword;
    });
    expect(calls).toBe(0); // not resolved at build time
    expect(config.cookiePassword).toBe(validPassword); // resolved on first read
    expect(config.cookiePassword).toBe(validPassword); // memoized
    expect(calls).toBe(1);
  });

  it('validates a lazily resolved password on first read', () => {
    const config = toAuthKitConfig(base, () => 'a'.repeat(10));
    expect(() => config.cookiePassword).toThrowError(/at least 32 characters/);
  });

  it('throws at exactly one char below the minimum', () => {
    const justUnder = 'a'.repeat(MIN_COOKIE_PASSWORD_LENGTH - 1);
    expect(() => toAuthKitConfig(base, justUnder)).toThrow();
  });

  it('does not throw at exactly the minimum length', () => {
    const exact = 'a'.repeat(MIN_COOKIE_PASSWORD_LENGTH);
    expect(() => toAuthKitConfig(base, exact)).not.toThrow();
  });
});

describe('createPublicWorkOS', () => {
  it('constructs a WorkOS client from a clientId with no API key', () => {
    const client = createPublicWorkOS('client_test_123');
    expect(client).toBeDefined();
    // The client exposes the userManagement surface the core relies on.
    expect(client.userManagement).toBeDefined();
  });
});
