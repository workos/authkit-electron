import type { User } from '@workos-inc/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  EncryptionUnavailableError,
  type KeyValueStoreLike,
  type SafeStorageLike,
  createDefaultStorage,
} from '../storage.js';

// Mock the `electron` module so importing `safeStorage` does not pull in the
// real native binding. Individual tests inject their own SafeStorageLike, so
// this just needs to exist.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

// Mock electron-store so `new ElectronStore()` never touches the filesystem.
vi.mock('electron-store', () => ({
  default: class {
    private map = new Map<string, unknown>();
    get(key: string): unknown {
      return this.map.get(key);
    }
    set(key: string, value: unknown): void {
      this.map.set(key, value);
    }
    delete(key: string): void {
      this.map.delete(key);
    }
  },
}));

const fakeUser = { id: 'user_1', email: 'a@b.com' } as unknown as User;

const session: Session = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: fakeUser,
};

/** In-memory store shared between storage instances within a test. */
function makeStore(): KeyValueStoreLike & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: (key) => raw.get(key),
    set: (key, value) => {
      raw.set(key, value);
    },
    delete: (key) => {
      raw.delete(key);
    },
  };
}

/** safeStorage stub: wraps the string in a reversible marker. */
function makeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`ENC(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const wrapped = b.toString('utf8');
      const match = /^ENC\((.*)\)$/s.exec(wrapped);
      if (!match) {
        throw new Error('cannot decrypt');
      }
      return match[1] as string;
    },
  };
}

describe('createDefaultStorage — session round-trip', () => {
  it('persists and rehydrates a session with full equality', () => {
    const store = makeStore();
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(),
    });

    expect(storage.getSession()).toBeNull();

    storage.setSession(session);
    expect(storage.getSession()).toEqual(session);
  });

  it('stores the session encrypted, not as plaintext JSON', () => {
    const store = makeStore();
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(),
    });

    storage.setSession(session);
    const stored = store.raw.get('session');
    expect(typeof stored).toBe('string');
    // The raw refresh token must not be readable in the stored value.
    expect(stored as string).not.toContain('refresh-token');
    expect(stored as string).toContain('enc:');
  });

  it('clears the session', () => {
    const store = makeStore();
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(),
    });

    storage.setSession(session);
    storage.clearSession();
    expect(storage.getSession()).toBeNull();
  });

  it('treats a corrupt/undecryptable stored value as no session', () => {
    const store = makeStore();
    store.raw.set('session', 'enc:not-valid-base64-or-cipher');
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(),
    });
    expect(storage.getSession()).toBeNull();
  });

  it('treats malformed JSON (post-decrypt) as no session', () => {
    const store = makeStore();
    const ss = makeSafeStorage();
    // Encrypt a non-JSON payload directly into the store.
    store.raw.set('session', `enc:${ss.encryptString('not json').toString('base64')}`);
    const storage = createDefaultStorage({ store, safeStorage: ss });
    expect(storage.getSession()).toBeNull();
  });
});

describe('createDefaultStorage — cookie password', () => {
  it('generates a >= 32 char password on first use', () => {
    const storage = createDefaultStorage({
      store: makeStore(),
      safeStorage: makeSafeStorage(),
    });
    const password = storage.getOrCreateCookiePassword();
    expect(password.length).toBeGreaterThanOrEqual(32);
  });

  it('is stable across two storage instances sharing the same store', () => {
    const store = makeStore();
    const ss = makeSafeStorage();

    const first = createDefaultStorage({ store, safeStorage: ss });
    const a = first.getOrCreateCookiePassword();

    const second = createDefaultStorage({ store, safeStorage: ss });
    const b = second.getOrCreateCookiePassword();

    expect(b).toBe(a);
  });

  it('returns the same value on repeated calls', () => {
    const storage = createDefaultStorage({
      store: makeStore(),
      safeStorage: makeSafeStorage(),
    });
    expect(storage.getOrCreateCookiePassword()).toBe(storage.getOrCreateCookiePassword());
  });
});

describe('createDefaultStorage — safeStorage unavailable', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it('throws EncryptionUnavailableError on setSession and persists nothing', () => {
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(false),
    });

    expect(() => storage.setSession(session)).toThrow(EncryptionUnavailableError);
    expect(store.raw.has('session')).toBe(false);
  });

  it('throws EncryptionUnavailableError on getOrCreateCookiePassword', () => {
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(false),
    });

    expect(() => storage.getOrCreateCookiePassword()).toThrow(EncryptionUnavailableError);
    expect(store.raw.has('cookiePassword')).toBe(false);
  });

  it('persists plaintext (with marker) when allowPlaintext is true', () => {
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(false),
      allowPlaintext: true,
    });

    storage.setSession(session);
    expect(storage.getSession()).toEqual(session);
    expect(store.raw.get('session') as string).toContain('plain:');
  });
});

describe('createDefaultStorage — pending verifiers', () => {
  it('round-trips a pending verifier and takes it once (single-use)', () => {
    const storage = createDefaultStorage({
      store: makeStore(),
      safeStorage: makeSafeStorage(),
    });

    storage.setPendingVerifier('state-abc', 'sealed-blob');
    expect(storage.takePendingVerifier('state-abc')).toBe('sealed-blob');
    // Second take returns null — the verifier was consumed.
    expect(storage.takePendingVerifier('state-abc')).toBeNull();
  });

  it('returns null for an unknown key', () => {
    const storage = createDefaultStorage({
      store: makeStore(),
      safeStorage: makeSafeStorage(),
    });
    expect(storage.takePendingVerifier('nope')).toBeNull();
  });

  it('stores the verifier encrypted, not as plaintext', () => {
    const store = makeStore();
    const storage = createDefaultStorage({ store, safeStorage: makeSafeStorage() });

    storage.setPendingVerifier('state-abc', 'super-secret-seal');
    const stored = store.raw.get('pendingVerifiers') as string;
    expect(typeof stored).toBe('string');
    expect(stored).toContain('enc:');
    expect(stored).not.toContain('super-secret-seal');
  });

  it('supports concurrent pending verifiers under different keys', () => {
    const storage = createDefaultStorage({
      store: makeStore(),
      safeStorage: makeSafeStorage(),
    });

    storage.setPendingVerifier('state-1', 'seal-1');
    storage.setPendingVerifier('state-2', 'seal-2');

    expect(storage.takePendingVerifier('state-1')).toBe('seal-1');
    // Taking one leaves the other intact.
    expect(storage.takePendingVerifier('state-2')).toBe('seal-2');
  });

  it('treats an expired verifier as absent (TTL)', () => {
    const store = makeStore();
    const ss = makeSafeStorage();
    const storage = createDefaultStorage({ store, safeStorage: ss });

    const now = 1_000_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    storage.setPendingVerifier('state-old', 'seal-old');

    // Jump past the 10-minute TTL.
    nowSpy.mockReturnValue(now + 10 * 60 * 1000 + 1);
    expect(storage.takePendingVerifier('state-old')).toBeNull();

    nowSpy.mockRestore();
  });

  it('clears the store key once the last verifier is taken', () => {
    const store = makeStore();
    const storage = createDefaultStorage({ store, safeStorage: makeSafeStorage() });

    storage.setPendingVerifier('only', 'seal');
    storage.takePendingVerifier('only');
    expect(store.raw.has('pendingVerifiers')).toBe(false);
  });
});

describe('createDefaultStorage — read-path plaintext policy (SEC-1592)', () => {
  // Models a local, same-user attacker who can write the electron-store JSON
  // file but has no OS-keychain access: they inject `plain:`-prefixed values the
  // SDK would never write while encryption is available and allowPlaintext=false.
  const forgedSession: Session = {
    accessToken: 'eyJATTACKER',
    refreshToken: 'rt_ATTACKER',
    user: { id: 'user_ATTACKER', email: 'attacker@evil.example' } as unknown as User,
  };

  it('rejects an injected plain: session when encryption is available', () => {
    const store = makeStore();
    store.raw.set('session', `plain:${JSON.stringify(forgedSession)}`);
    const storage = createDefaultStorage({ store, safeStorage: makeSafeStorage(true) });
    expect(storage.getSession()).toBeNull();
  });

  it('ignores an injected plain: cookiePassword and generates a fresh one', () => {
    const store = makeStore();
    const attackerKnown = 'A'.repeat(32);
    store.raw.set('cookiePassword', `plain:${attackerKnown}`);
    const storage = createDefaultStorage({ store, safeStorage: makeSafeStorage(true) });
    expect(storage.getOrCreateCookiePassword()).not.toBe(attackerKnown);
  });

  it('rejects injected plain: pending verifiers', () => {
    const store = makeStore();
    store.raw.set(
      'pendingVerifiers',
      `plain:${JSON.stringify({
        'attacker-state': { value: 'sealed', expiresAt: Date.now() + 600000 },
      })}`,
    );
    const storage = createDefaultStorage({ store, safeStorage: makeSafeStorage(true) });
    expect(storage.takePendingVerifier('attacker-state')).toBeNull();
  });

  it('still honors plain: values when allowPlaintext is enabled', () => {
    const store = makeStore();
    store.raw.set('session', `plain:${JSON.stringify(session)}`);
    const storage = createDefaultStorage({
      store,
      safeStorage: makeSafeStorage(false),
      allowPlaintext: true,
    });
    expect(storage.getSession()).toEqual(session);
  });
});

describe('createDefaultStorage — default electron bindings', () => {
  it('constructs without injected deps (uses mocked electron + electron-store)', () => {
    // Exercises the default `safeStorage` / `new ElectronStore()` branch.
    const storage = createDefaultStorage({ name: 'test-store' });
    storage.setSession(session);
    expect(storage.getSession()).toEqual(session);
  });
});
