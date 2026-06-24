/**
 * Sign-in ceremony abstraction.
 *
 * A "ceremony" is how the user is taken to AuthKit to authenticate. Phase 2
 * ships the default `system-browser` ceremony (opens the OS browser via
 * `shell.openExternal`); the in-app `window` ceremony arrives in Phase 4. Both
 * deliver their callback through the same deep-link handler, so the `Ceremony`
 * interface only needs to know how to `open` an authorization URL.
 *
 * `onCallback` lets a ceremony that captures its own callback (the future
 * window mode, via navigation interception) push the callback URL back to the
 * orchestrator. The system-browser ceremony does NOT use it — its callbacks
 * arrive out-of-band through the custom-protocol deep link — so the default
 * implementation is a no-op that returns an unsubscribe.
 */

import type { AuthKitElectronConfig } from '../../shared/types.js';
import { createSystemBrowserCeremony } from './system-browser.js';

export interface Ceremony {
  /** Take the user to the authorization URL to begin authentication. */
  open(url: string): Promise<void>;
  /**
   * Register a callback for ceremonies that capture their own callback URL
   * (window mode). Returns an unsubscribe function. The system-browser ceremony
   * never invokes the callback (its callback arrives via the deep-link handler).
   */
  onCallback(cb: (url: string) => void): () => void;
}

/** The minimal `shell` surface the system-browser ceremony depends on. */
export interface ShellLike {
  openExternal(url: string): Promise<void>;
}

export interface CreateCeremonyOptions {
  /** Injectable for tests; defaults to Electron's `shell`. */
  shell?: ShellLike;
}

/**
 * Select and construct the ceremony for the given config.
 *
 * Defaults to `system-browser`. The `window` mode is registered in Phase 4;
 * until then, selecting it falls back to the system browser.
 */
export function createCeremony(
  config: AuthKitElectronConfig,
  opts: CreateCeremonyOptions = {},
): Ceremony {
  // `config.ceremony?.mode` is reserved for the Phase 4 window ceremony; only
  // system-browser exists today, so every mode resolves to it.
  void config;
  return createSystemBrowserCeremony(opts);
}
