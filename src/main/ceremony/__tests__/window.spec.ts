import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindowLike, WebContentsLike } from '../window.js';
import { createWindowCeremony, isCallbackNavigation } from '../window.js';

// The ceremony imports `BrowserWindow` from electron; tests inject their own
// window factory, so this mock only prevents the native binding from loading.
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

const REDIRECT_URI = 'workos-auth://callback';

type NavListener = (details: { url: string; preventDefault(): void }) => void;

/**
 * A fake `BrowserWindow` that records its navigation/closed listeners so a test
 * can drive them, and tracks `close()`/`isDestroyed()`.
 */
function makeWindow(): BrowserWindowLike & {
  navListeners: NavListener[];
  closedListeners: Array<() => void>;
  close: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  /** Drive a navigation event; returns whether it was prevented. */
  navigate(url: string): boolean;
  /** Drive the `closed` event. */
  fireClosed(): void;
} {
  const navListeners: NavListener[] = [];
  const closedListeners: Array<() => void> = [];
  const webContents: WebContentsLike = {
    on: (_event, listener) => {
      navListeners.push(listener as NavListener);
    },
  };
  const win = {
    navListeners,
    closedListeners,
    destroyed: false,
    webContents,
    loadURL: vi.fn(async () => {}),
    close: vi.fn(function close(this: { destroyed: boolean }) {
      win.destroyed = true;
    }),
    isDestroyed: () => win.destroyed,
    on: (_event: 'closed', listener: () => void) => {
      closedListeners.push(listener);
    },
    navigate(url: string): boolean {
      let prevented = false;
      const details = {
        url,
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const l of navListeners) {
        l(details);
      }
      return prevented;
    },
    fireClosed() {
      for (const l of closedListeners) {
        l();
      }
    },
  };
  return win;
}

describe('isCallbackNavigation', () => {
  it('matches a navigation to the redirect URI', () => {
    expect(isCallbackNavigation('workos-auth://callback?code=abc&state=xyz', REDIRECT_URI)).toBe(
      true,
    );
  });

  it('does NOT match an unrelated AuthKit URL (interstitial / authorize page)', () => {
    expect(isCallbackNavigation('https://api.workos.com/sso/authorize', REDIRECT_URI)).toBe(false);
    expect(isCallbackNavigation('https://your-app.authkit.app/interstitial', REDIRECT_URI)).toBe(
      false,
    );
  });

  it('does not throw and does not match on a malformed URL', () => {
    expect(isCallbackNavigation('not a url', REDIRECT_URI)).toBe(false);
  });
});

describe('createWindowCeremony', () => {
  function setup() {
    const win = makeWindow();
    const createWindow = vi.fn(() => win);
    const ceremony = createWindowCeremony({ redirectUri: REDIRECT_URI, createWindow });
    return { win, createWindow, ceremony };
  }

  it('opens a window and loads the authorization URL', async () => {
    const { win, ceremony } = setup();
    await ceremony.open('https://api.workos.com/authorize?x=1');
    expect(win.loadURL).toHaveBeenCalledWith('https://api.workos.com/authorize?x=1');
  });

  it('intercepts the callback navigation, extracts code/state, and closes the window', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    ceremony.onCallback(onCallback);

    await ceremony.open('https://api.workos.com/authorize');
    const prevented = win.navigate('workos-auth://callback?code=the_code&state=the_state');

    expect(prevented).toBe(true);
    expect(onCallback).toHaveBeenCalledWith('workos-auth://callback?code=the_code&state=the_state');
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('does NOT intercept navigation to an unrelated interstitial URL', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    ceremony.onCallback(onCallback);

    await ceremony.open('https://api.workos.com/authorize');
    const prevented = win.navigate('https://your-app.authkit.app/interstitial');

    expect(prevented).toBe(false);
    expect(onCallback).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });

  it('surfaces an error param through the callback and closes the window', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    ceremony.onCallback(onCallback);

    await ceremony.open('https://api.workos.com/authorize');
    const prevented = win.navigate('workos-auth://callback?error=access_denied');

    expect(prevented).toBe(true);
    expect(onCallback).toHaveBeenCalledWith('workos-auth://callback?error=access_denied');
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('leaves the window open when a callback navigation has neither code nor error', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    ceremony.onCallback(onCallback);

    await ceremony.open('https://api.workos.com/authorize');
    // A redirect to the redirect URI but with no code/error/state (unparseable
    // into a callback) should not be intercepted — let the user retry or close.
    const prevented = win.navigate('workos-auth://callback');

    expect(prevented).toBe(false);
    expect(onCallback).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });

  it('emits a cancellation when the user closes the window before completing', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    ceremony.onCallback(onCallback);

    await ceremony.open('https://api.workos.com/authorize');
    win.fireClosed();

    expect(onCallback).toHaveBeenCalledTimes(1);
    const arg = onCallback.mock.calls[0]?.[0] as string;
    expect(arg.startsWith(REDIRECT_URI)).toBe(true);
    expect(arg).toContain('error=');
  });

  it('does NOT emit a cancellation when the window closes AFTER a successful capture', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    ceremony.onCallback(onCallback);

    await ceremony.open('https://api.workos.com/authorize');
    win.navigate('workos-auth://callback?code=c&state=s');
    // The ceremony called `close()`, which in the real runtime fires `closed`.
    win.fireClosed();

    // Exactly one emit: the captured callback, not an additional cancellation.
    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(onCallback).toHaveBeenCalledWith('workos-auth://callback?code=c&state=s');
  });

  it('unsubscribe stops further callbacks', async () => {
    const { win, ceremony } = setup();
    const onCallback = vi.fn();
    const unsubscribe = ceremony.onCallback(onCallback);
    unsubscribe();

    await ceremony.open('https://api.workos.com/authorize');
    win.navigate('workos-auth://callback?code=c&state=s');

    expect(onCallback).not.toHaveBeenCalled();
  });

  it('closes the window (no leak) and rethrows when loadURL fails', async () => {
    const win = makeWindow();
    win.loadURL.mockRejectedValueOnce(new Error('net::ERR_FAILED'));
    const ceremony = createWindowCeremony({
      redirectUri: REDIRECT_URI,
      createWindow: () => win,
    });

    await expect(ceremony.open('https://api.workos.com/authorize')).rejects.toThrow(
      'net::ERR_FAILED',
    );
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('passes a parent and makes the window modal when a parent is given', async () => {
    const parent = makeWindow();
    const child = makeWindow();
    const createWindow = vi.fn(() => child);
    const ceremony = createWindowCeremony({
      redirectUri: REDIRECT_URI,
      parent,
      createWindow,
    });

    await ceremony.open('https://api.workos.com/authorize');

    expect(createWindow).toHaveBeenCalledWith({ parent, modal: true });
  });

  it('makes the window non-modal when no parent is given', async () => {
    const { createWindow, ceremony } = setup();
    await ceremony.open('https://api.workos.com/authorize');
    expect(createWindow).toHaveBeenCalledWith({ parent: undefined, modal: false });
  });
});
