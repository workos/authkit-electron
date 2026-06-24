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

describe('createDefaultStorage — default electron bindings', () => {
  it('constructs without injected deps (uses mocked electron + electron-store)', () => {
    // Exercises the default `safeStorage` / `new ElectronStore()` branch.
    const storage = createDefaultStorage({ name: 'test-store' });
    storage.setSession(session);
    expect(storage.getSession()).toEqual(session);
  });
});
