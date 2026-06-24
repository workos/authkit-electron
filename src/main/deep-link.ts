/**
 * Cross-platform custom-protocol deep-link capture.
 *
 * AuthKit redirects the system browser to the app's custom protocol (e.g.
 * `workos-auth://callback?code=...&state=...`). Capturing that URL differs by
 * OS, and this is exactly the matrix the hand-wired example got subtly wrong:
 *
 * - macOS: the OS dispatches `app.on('open-url')`.
 * - Windows/Linux: the URL is appended to a SECOND instance's `argv`; the
 *   already-running first instance receives it via `app.on('second-instance')`.
 *
 * `registerProtocol` declares the app as the protocol's default client (with
 * the dev-mode `argv` branch so it works under `electron .`). `wireDeepLinks`
 * attaches both listeners and the single-instance lock, routing every callback
 * URL to one `onUrl` sink (the session manager's `completeCallback`).
 *
 * Cold-start buffering: a URL can arrive (Windows initial `argv`, or an
 * `open-url` fired before `whenReady`) before the consumer wires `onUrl`. We
 * stash such URLs and flush them as soon as the handler attaches, so a sign-in
 * started before the app was running is not silently lost.
 *
 * Window-ceremony interaction (no double-handle): in `ceremony.mode: 'window'`
 * the auth window intercepts the redirect with `preventDefault()` BEFORE it
 * commits, so the `redirectUri` navigation never escapes to the OS and these
 * listeners never fire for it. The window ceremony delivers the callback
 * directly via `Ceremony.onCallback`, so a window-mode callback is handled
 * exactly once. No change to this matrix is required for window mode.
 */

import { resolve } from 'node:path';
import { app as electronApp } from 'electron';

/** Minimal Electron `app` surface this module depends on (injectable). */
export interface AppLike {
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'open-url', listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: 'second-instance', listener: (event: unknown, argv: string[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

/** Minimal `process`-like surface (injectable for the dev-argv branch + tests). */
export interface ProcessLike {
  defaultApp?: boolean;
  argv: string[];
  execPath: string;
}

/**
 * Parse an OAuth callback URL into its `code` / `state` / `error` parts.
 *
 * Pure (no Electron). A malformed URL yields an empty object rather than
 * throwing, so a stray non-callback deep link cannot crash the handler.
 */
export function parseCallback(url: string): {
  code?: string;
  state?: string;
  error?: string;
} {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return {};
  }
  const result: { code?: string; state?: string; error?: string } = {};
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  if (code !== null) {
    result.code = code;
  }
  if (state !== null) {
    result.state = state;
  }
  if (error !== null) {
    result.error = error;
  }
  return result;
}

/**
 * Register the app as the default client for `scheme://` URLs.
 *
 * In dev (`process.defaultApp`, i.e. launched via `electron .`), the protocol
 * must point at the Electron binary plus the resolved entry script, otherwise
 * the OS re-launches a bare Electron. In a packaged app the no-arg form is
 * correct.
 */
export function registerProtocol(
  scheme: string,
  deps: { app?: AppLike; process?: ProcessLike } = {},
): boolean {
  const app = deps.app ?? (electronApp as unknown as AppLike);
  const proc = deps.process ?? (globalThis.process as unknown as ProcessLike);
  if (proc.defaultApp && proc.argv.length >= 2) {
    // argv[1] is the entry script under `electron <script>`.
    return app.setAsDefaultProtocolClient(scheme, proc.execPath, [resolve(proc.argv[1] as string)]);
  }
  return app.setAsDefaultProtocolClient(scheme);
}

export interface WireDeepLinksOptions {
  app?: AppLike;
  process?: ProcessLike;
  /** Called to focus/restore the main window on a `second-instance` event. */
  onSecondInstance?: () => void;
}

/**
 * Acquire the single-instance lock and wire the deep-link listeners.
 *
 * Returns a cleanup function that removes the listeners. If the single-instance
 * lock cannot be acquired, this process is a duplicate: the first instance will
 * receive the URL via `second-instance`, so we quit and return a no-op cleanup.
 *
 * Any `scheme://` URL present in the initial `argv` (Windows cold start) is
 * buffered and flushed to `onUrl` synchronously before returning.
 */
export function wireDeepLinks(
  scheme: string,
  onUrl: (url: string) => void,
  opts: WireDeepLinksOptions = {},
): () => void {
  const app = opts.app ?? (electronApp as unknown as AppLike);
  const proc = opts.process ?? (globalThis.process as unknown as ProcessLike);
  const prefix = `${scheme}://`;

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return () => {};
  }

  const openUrlListener = (event: { preventDefault(): void }, url: string): void => {
    event.preventDefault();
    if (url.startsWith(prefix)) {
      onUrl(url);
    }
  };
  const secondInstanceListener = (_event: unknown, argv: string[]): void => {
    const url = argv.find((arg) => arg.startsWith(prefix));
    if (url) {
      onUrl(url);
    }
    opts.onSecondInstance?.();
  };

  app.on('open-url', openUrlListener);
  app.on('second-instance', secondInstanceListener);

  // Cold start on Windows/Linux: the launching URL is in our own argv.
  const initialUrl = proc.argv.find((arg) => arg.startsWith(prefix));
  if (initialUrl) {
    onUrl(initialUrl);
  }

  return () => {
    app.removeListener('open-url', openUrlListener as (...args: unknown[]) => void);
    app.removeListener('second-instance', secondInstanceListener as (...args: unknown[]) => void);
  };
}
