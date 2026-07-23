/**
 * Sign-in ceremony abstraction.
 *
 * A "ceremony" is how the user is taken to AuthKit to authenticate. Two modes
 * ship: the default `system-browser` ceremony (opens the OS browser via
 * `shell.openExternal`) and the in-app `window` ceremony. Both deliver their
 * callback through the same completion path, so the `Ceremony` interface only
 * needs to know how to `open` an authorization URL.
 *
 * `onCallback` lets a ceremony that captures its own callback (window mode, via
 * navigation interception) push the callback URL back to the orchestrator. The
 * system-browser ceremony does NOT use it — its callbacks arrive out-of-band
 * through the custom-protocol deep link — so the default implementation is a
 * no-op that returns an unsubscribe.
 */

import type { AuthKitElectronConfig } from '../../shared/types.js';
import { createSystemBrowserCeremony } from './system-browser.js';
import {
  type BrowserWindowFactory,
  type BrowserWindowLike,
  createWindowCeremony,
} from './window.js';

export interface Ceremony {
  /** Take the user to the authorization URL to begin authentication. */
  open(url: string): Promise<void>;
  /**
   * End the hosted AuthKit session by delivering the WorkOS logout URL to
   * wherever that session's cookie lives: the OS browser (system-browser mode)
   * or the ceremony window's Electron session (window mode). Without this,
   * "sign out" only clears the app-local session and the next sign-in silently
   * re-authenticates against the still-live hosted session.
   */
  endSession(logoutUrl: string): Promise<void>;
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
  /** Injectable for tests; defaults to Electron's `shell` (system-browser mode). */
  shell?: ShellLike;
  /** Injectable `BrowserWindow` factory for tests (window mode). */
  createWindow?: BrowserWindowFactory;
  /** Optional parent for the auth window; makes it modal (window mode). */
  parent?: BrowserWindowLike;
}

/**
 * Select and construct the ceremony for the given config.
 *
 * Defaults to `system-browser`. `config.ceremony.mode: 'window'` selects the
 * in-app `BrowserWindow` ceremony, which captures its callback by intercepting
 * navigation to `config.redirectUri` rather than via the OS protocol handler.
 */
export function createCeremony(
  config: AuthKitElectronConfig,
  opts: CreateCeremonyOptions = {},
): Ceremony {
  if (config.ceremony?.mode === 'window') {
    return createWindowCeremony({
      redirectUri: config.redirectUri,
      parent: opts.parent,
      createWindow: opts.createWindow,
    });
  }
  return createSystemBrowserCeremony(opts);
}
