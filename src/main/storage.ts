/**
 * Electron-native session persistence.
 *
 * At-rest encryption is provided by the OS keychain via Electron's
 * `safeStorage`, NOT by the core's `encryptSession`. The stored value is the
 * `Session` JSON encrypted by `safeStorage`. The per-install `cookiePassword`
 * is also persisted (safeStorage-encrypted) and is stable across launches so an
 * app quit mid-sign-in can still verify the PKCE state in Phase 2.
 */

import { randomBytes } from 'node:crypto';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';
import type { Session, TokenStorage } from '../shared/types.js';

export type { TokenStorage } from '../shared/types.js';

/** Number of random bytes used to generate a per-install cookie password. */
const COOKIE_PASSWORD_BYTES = 32;

/** electron-store keys. Values are safeStorage-encrypted base64 strings. */
const SESSION_KEY = 'session';
const COOKIE_PASSWORD_KEY = 'cookiePassword';

/**
 * Thrown when `safeStorage` cannot encrypt (e.g. Linux without a keyring, or a
 * locked keychain) and the caller has not opted into plaintext storage. The SDK
 * refuses to persist secrets unencrypted by default.
 */
export class EncryptionUnavailableError extends Error {
  constructor(
    message = 'OS encryption (safeStorage) is unavailable, so the session ' +
      'cannot be persisted securely. On Linux this usually means no keyring is ' +
      'running. Pass `allowPlaintext: true` to store data unencrypted (NOT ' +
      'recommended outside development).',
  ) {
    super(message);
    this.name = 'EncryptionUnavailableError';
  }
}

/**
 * Minimal surface of Electron's `safeStorage` we depend on. Declared locally so
 * the module is injectable (and mockable) without importing Electron's full
 * typings into tests.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Minimal key/value surface of `electron-store` we depend on. */
export interface KeyValueStoreLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface CreateStorageOptions {
  /** electron-store file name (without extension). Default: `authkit-session`. */
  name?: string;
  /**
   * Allow persisting data UNENCRYPTED when `safeStorage` is unavailable.
   * Off by default; intended only for development on machines without a
   * keyring. When false (default), writes throw {@link EncryptionUnavailableError}.
   */
  allowPlaintext?: boolean;
  /** Injectable for tests. Defaults to Electron's `safeStorage`. */
  safeStorage?: SafeStorageLike;
  /** Injectable for tests. Defaults to a new `electron-store` instance. */
  store?: KeyValueStoreLike;
}

/** Marker prefix distinguishing plaintext fallback values from encrypted ones. */
const PLAINTEXT_PREFIX = 'plain:';
const ENCRYPTED_PREFIX = 'enc:';

/**
 * Create the default `electron-store` + `safeStorage` token storage.
 *
 * Reads/writes guard on `safeStorage.isEncryptionAvailable()`; when encryption
 * is unavailable and `allowPlaintext` is false, writes throw
 * {@link EncryptionUnavailableError} and nothing is persisted.
 */
export function createDefaultStorage(opts: CreateStorageOptions = {}): TokenStorage {
  const ss: SafeStorageLike = opts.safeStorage ?? safeStorage;
  const store: KeyValueStoreLike =
    opts.store ?? new ElectronStore({ name: opts.name ?? 'authkit-session' });
  const allowPlaintext = opts.allowPlaintext ?? false;

  /** Encrypt a string for storage, honoring the safeStorage guard. */
  function encrypt(value: string): string {
    if (ss.isEncryptionAvailable()) {
      return ENCRYPTED_PREFIX + ss.encryptString(value).toString('base64');
    }
    if (allowPlaintext) {
      return PLAINTEXT_PREFIX + value;
    }
    throw new EncryptionUnavailableError();
  }

  /** Decrypt a stored string; returns null on any failure (treat as absent). */
  function decrypt(stored: unknown): string | null {
    if (typeof stored !== 'string') {
      return null;
    }
    try {
      if (stored.startsWith(ENCRYPTED_PREFIX)) {
        const buf = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
        return ss.decryptString(buf);
      }
      if (stored.startsWith(PLAINTEXT_PREFIX)) {
        return stored.slice(PLAINTEXT_PREFIX.length);
      }
      return null;
    } catch {
      // Corrupt / undecryptable (e.g. keychain rotated): treat as no value.
      return null;
    }
  }

  return {
    getSession(): Session | null {
      const decrypted = decrypt(store.get(SESSION_KEY));
      if (!decrypted) {
        return null;
      }
      try {
        return JSON.parse(decrypted) as Session;
      } catch {
        return null;
      }
    },

    setSession(session: Session): void {
      store.set(SESSION_KEY, encrypt(JSON.stringify(session)));
    },

    clearSession(): void {
      store.delete(SESSION_KEY);
    },

    getOrCreateCookiePassword(): string {
      const existing = decrypt(store.get(COOKIE_PASSWORD_KEY));
      if (existing) {
        return existing;
      }
      const generated = randomBytes(COOKIE_PASSWORD_BYTES).toString('base64url');
      store.set(COOKIE_PASSWORD_KEY, encrypt(generated));
      return generated;
    },
  };
}
