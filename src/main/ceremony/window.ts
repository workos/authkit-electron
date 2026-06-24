/**
 * In-app window sign-in ceremony.
 *
 * Instead of handing the user off to the OS browser (the system-browser
 * ceremony), this opens a child `BrowserWindow` pointed at the hosted AuthKit
 * authorization URL and captures the callback by INTERCEPTING navigation to the
 * `redirectUri` — `preventDefault()`-ing it BEFORE it escapes to the OS and
 * re-triggers the custom-protocol deep-link handler (the double-handle hazard).
 *
 * Everything after capture reuses the Phase 2 orchestration unchanged: the
 * captured callback URL is pushed to the `Ceremony.onCallback` subscribers,
 * which `createAuthKit` wires to the same `completeCallback` path the
 * deep-link handler uses. This phase only swaps HOW the URL is opened and HOW
 * `code`/`state` are intercepted.
 *
 * Because the hosted AuthKit page loads at a real `https://` origin inside the
 * window, WebAuthn/passkeys work without any native module. The one caveat:
 * macOS Touch ID inside a `BrowserWindow` requires Electron >= 42 +
 * `app.configureWebAuthn` — a non-issue in system-browser mode, which remains
 * the fallback.
 */

import { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { parseCallback } from '../deep-link.js';
import type { Ceremony } from './index.js';

/** Minimal `webContents` surface the window ceremony listens on (injectable). */
export interface WebContentsLike {
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (details: { url: string; preventDefault(): void }) => void,
  ): void;
}

/** Minimal `BrowserWindow` surface this ceremony depends on (injectable). */
export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  loadURL(url: string): Promise<void>;
  close(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): void;
}

/** Constructs a `BrowserWindow`. Injectable so tests need no real Electron. */
export type BrowserWindowFactory = (opts: {
  parent?: BrowserWindowLike;
  modal: boolean;
}) => BrowserWindowLike;

export interface CreateWindowCeremonyOptions {
  /** The redirect URI to intercept; a navigation to it carries the callback. */
  redirectUri: string;
  /** Optional parent window; when given the auth window is modal to it. */
  parent?: BrowserWindowLike;
  /** Injectable for tests; defaults to constructing an Electron `BrowserWindow`. */
  createWindow?: BrowserWindowFactory;
}

/**
 * Does `url` begin the navigation that carries the OAuth callback?
 *
 * Pure (no Electron) so it is trivially unit-testable. Matches on the
 * `redirectUri` prefix, mirroring the deep-link handler's `scheme://` prefix
 * check — an unrelated AuthKit URL (an interstitial, the authorize page itself)
 * does NOT match, so only the final redirect is intercepted. A malformed `url`
 * never matches (and never throws).
 */
export function isCallbackNavigation(url: string, redirectUri: string): boolean {
  return url.startsWith(redirectUri);
}

const defaultCreateWindow: BrowserWindowFactory = ({ parent, modal }) =>
  new ElectronBrowserWindow({
    parent: parent as unknown as ElectronBrowserWindow | undefined,
    modal,
    width: 480,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      // The auth window loads the hosted AuthKit page only; it needs no bridge
      // to the app, so keep it isolated with no node integration.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

export function createWindowCeremony(opts: CreateWindowCeremonyOptions): Ceremony {
  const { redirectUri } = opts;
  const createWindow = opts.createWindow ?? defaultCreateWindow;

  const subscribers = new Set<(url: string) => void>();
  const emit = (url: string): void => {
    for (const cb of subscribers) {
      cb(url);
    }
  };

  return {
    async open(url: string): Promise<void> {
      const win = createWindow({ parent: opts.parent, modal: opts.parent !== undefined });

      // True once we've intercepted the callback, so the `closed` handler can
      // tell a completed flow (window closes because we closed it) from a
      // user-cancelled one (user closed the window before authenticating).
      let captured = false;

      const closeWindow = (): void => {
        if (!win.isDestroyed()) {
          win.close();
        }
      };

      const onNavigate = (details: { url: string; preventDefault(): void }): void => {
        // Capture once. A single navigation can surface as both `will-navigate`
        // and `will-redirect`; the first to match wins and the rest are inert.
        if (captured) {
          return;
        }
        if (!isCallbackNavigation(details.url, redirectUri)) {
          return;
        }
        const parsed = parseCallback(details.url);
        // A `will-redirect` whose URL is unparseable into a callback leaves the
        // window open so the user can retry or close it.
        if (parsed.code === undefined && parsed.error === undefined) {
          return;
        }
        // Stop the navigation BEFORE it commits so the `workos-auth://` (or
        // http) redirect never reaches the OS — no double-handle with the
        // deep-link handler.
        details.preventDefault();
        captured = true;
        try {
          emit(details.url);
        } finally {
          closeWindow();
        }
      };

      win.webContents.on('will-navigate', onNavigate);
      win.webContents.on('will-redirect', onNavigate);

      // User closed the window before completing: surface a cancellation
      // through the SAME callback path (a synthetic `error` URL) so the
      // renderer's `signIn` promise settles instead of hanging. The Phase 2
      // orchestrator already treats an `error` param as a non-fatal denial.
      win.on('closed', () => {
        if (!captured) {
          emit(`${redirectUri}?error=window_closed`);
        }
      });

      try {
        await win.loadURL(url);
      } catch (err) {
        // Failed to load the authorization page — close the window (finally, to
        // avoid a leak) and surface a cancellation so `signIn` settles.
        closeWindow();
        throw err;
      }
    },
    onCallback(cb: (url: string) => void): () => void {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}
