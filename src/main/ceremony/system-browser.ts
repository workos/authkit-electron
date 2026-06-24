/**
 * System-browser sign-in ceremony (the default).
 *
 * Opens the authorization URL in the user's OS default browser via
 * `shell.openExternal`. The callback does NOT come back through this ceremony —
 * AuthKit redirects to the app's custom protocol (e.g. `workos-auth://callback`)
 * which the deep-link handler captures. Hence `onCallback` is a no-op here.
 *
 * Opening in the real system browser (rather than an in-app window) is the
 * recommended OAuth flow for native apps: it reuses the user's existing browser
 * session and keeps the OAuth flow out of an embedded webview.
 */

import { shell as electronShell } from 'electron';
import type { Ceremony, CreateCeremonyOptions, ShellLike } from './index.js';

export function createSystemBrowserCeremony(opts: CreateCeremonyOptions = {}): Ceremony {
  const shell: ShellLike = opts.shell ?? electronShell;

  return {
    async open(url: string): Promise<void> {
      await shell.openExternal(url);
    },
    // System-browser callbacks arrive via the deep-link handler, not here.
    onCallback(): () => void {
      return () => {};
    },
  };
}
