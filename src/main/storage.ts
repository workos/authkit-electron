/**
 * Electron-native session persistence.
 *
 * At-rest encryption is provided by the OS keychain via Electron's
 * `safeStorage`, NOT by the core's `encryptSession`. The stored value is the
 * `Session` JSON encrypted by `safeStorage`. The per-install `cookiePassword`
 * is also persisted (safeStorage-encrypted) and is stable across launches so an
 * app quit mid-sign-in can still verify the PKCE state on the callback.
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
/** Namespace under which pending PKCE verifiers are stored (keyed by state). */
const PENDING_VERIFIER_KEY = 'pendingVerifiers';

/**
 * TTL for an in-flight PKCE verifier, in milliseconds. Matches the 600s the
 * core embeds in the sealed state — once the seal expires, `verifyCallbackState`
 * would reject it anyway, so we drop ours on the same clock.
 */
const PENDING_VERIFIER_TTL_MS = 10 * 60 * 1000;

/** Stored shape of a single pending verifier: the value plus its expiry. */
interface PendingVerifierEntry {
  value: string;
  expiresAt: number;
}

/** Drop entries whose TTL has elapsed; mutates the map in place. */
function pruneExpiredVerifiers(map: Record<string, PendingVerifierEntry>): void {
  const now = Date.now();
  for (const [k, entry] of Object.entries(map)) {
    if (!entry || entry.expiresAt <= now) {
      delete map[k];
    }
  }
}

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
        // Mirror the write-path policy: the SDK only ever writes a plaintext
        // value when `allowPlaintext` is enabled. Rejecting `plain:` otherwise
        // prevents a local file writer from injecting a value the SDK would
        // never have produced (forged session / cookiePassword / verifiers).
        if (!allowPlaintext) {
          return null;
        }
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

    setPendingVerifier(key: string, value: string): void {
      const map = readPendingVerifiers();
      pruneExpiredVerifiers(map);
      map[key] = { value, expiresAt: Date.now() + PENDING_VERIFIER_TTL_MS };
      writePendingVerifiers(map);
    },

    takePendingVerifier(key: string): string | null {
      const map = readPendingVerifiers();
      const entry = map[key];
      // Always remove the key we were asked for (single-use), even if expired.
      if (key in map) {
        delete map[key];
      }
      const wasExpired = !!entry && entry.expiresAt <= Date.now();
      pruneExpiredVerifiers(map);
      writePendingVerifiers(map);
      if (!entry || wasExpired) {
        return null;
      }
      return entry.value;
    },
  };

  /** Decrypt + parse the pending-verifier map; an absent/corrupt store is {}. */
  function readPendingVerifiers(): Record<string, PendingVerifierEntry> {
    const decrypted = decrypt(store.get(PENDING_VERIFIER_KEY));
    if (!decrypted) {
      return {};
    }
    try {
      const parsed = JSON.parse(decrypted) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, PendingVerifierEntry>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Persist the pending-verifier map (encrypted), or clear the key if empty. */
  function writePendingVerifiers(map: Record<string, PendingVerifierEntry>): void {
    if (Object.keys(map).length === 0) {
      store.delete(PENDING_VERIFIER_KEY);
      return;
    }
    store.set(PENDING_VERIFIER_KEY, encrypt(JSON.stringify(map)));
  }
}
