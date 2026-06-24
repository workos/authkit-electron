import { describe, expect, it, vi } from 'vitest';
import type { AppLike, ProcessLike } from '../deep-link.js';
import { parseCallback, registerProtocol, wireDeepLinks } from '../deep-link.js';

// The module imports `app` from electron at the top; tests inject their own
// `app`, so this mock just prevents the native binding from loading.
vi.mock('electron', () => ({ app: {} }));

const SCHEME = 'workos-auth';

/** A fake Electron `app` that records `.on` listeners by event name. */
function makeApp(lockAcquired = true): AppLike & {
  listeners: Record<string, (...args: never[]) => void>;
  setAsDefaultProtocolClient: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  removed: string[];
} {
  const listeners: Record<string, (...args: never[]) => void> = {};
  const removed: string[] = [];
  return {
    listeners,
    removed,
    setAsDefaultProtocolClient: vi.fn(() => true),
    requestSingleInstanceLock: () => lockAcquired,
    quit: vi.fn(() => {}),
    on: ((event: string, listener: (...args: never[]) => void) => {
      listeners[event] = listener;
    }) as AppLike['on'],
    removeListener: ((event: string, _listener: (...args: unknown[]) => void) => {
      removed.push(event);
    }) as AppLike['removeListener'],
  };
}

function proc(overrides: Partial<ProcessLike> = {}): ProcessLike {
  return { argv: ['electron'], execPath: '/path/to/electron', ...overrides };
}

describe('parseCallback — URL matrix', () => {
  it('extracts code and state', () => {
    expect(parseCallback('workos-auth://callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
  });

  it('extracts error', () => {
    const parsed = parseCallback('workos-auth://callback?error=access_denied');
    expect(parsed.error).toBe('access_denied');
    expect(parsed.code).toBeUndefined();
  });

  it('returns an empty object when no relevant params are present', () => {
    expect(parseCallback('workos-auth://callback')).toEqual({});
  });

  it('ignores extra params and keeps the relevant ones', () => {
    expect(
      parseCallback('workos-auth://callback?code=c&state=s&foo=bar&baz=1'),
    ).toEqual({ code: 'c', state: 's' });
  });

  it('returns an empty object for a malformed URL rather than throwing', () => {
    expect(parseCallback('not a url')).toEqual({});
  });

  it('preserves URL-encoded state intact', () => {
    const sealed = 'Fe26.2**abc==def';
    const url = `workos-auth://callback?code=c&state=${encodeURIComponent(sealed)}`;
    expect(parseCallback(url).state).toBe(sealed);
  });
});

describe('registerProtocol', () => {
  it('uses the dev-argv branch under process.defaultApp', () => {
    const app = makeApp();
    registerProtocol(SCHEME, {
      app,
      process: proc({ defaultApp: true, argv: ['electron', './main.js'], execPath: '/e' }),
    });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('workos-auth', '/e', [
      expect.stringContaining('main.js'),
    ]);
  });

  it('uses the no-arg form in a packaged app', () => {
    const app = makeApp();
    registerProtocol(SCHEME, { app, process: proc({ defaultApp: false }) });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('workos-auth');
  });
});

describe('wireDeepLinks', () => {
  it('routes an open-url (macOS) callback to onUrl after preventDefault', () => {
    const app = makeApp();
    const onUrl = vi.fn();
    wireDeepLinks(SCHEME, onUrl, { app, process: proc() });

    const preventDefault = vi.fn();
    app.listeners['open-url']?.(
      { preventDefault } as never,
      'workos-auth://callback?code=c&state=s' as never,
    );

    expect(preventDefault).toHaveBeenCalled();
    expect(onUrl).toHaveBeenCalledWith('workos-auth://callback?code=c&state=s');
  });

  it('ignores an open-url that is not our scheme', () => {
    const app = makeApp();
    const onUrl = vi.fn();
    wireDeepLinks(SCHEME, onUrl, { app, process: proc() });
    app.listeners['open-url']?.(
      { preventDefault: vi.fn() } as never,
      'https://example.com' as never,
    );
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('extracts the scheme:// arg from second-instance argv noise (Windows/Linux)', () => {
    const app = makeApp();
    const onUrl = vi.fn();
    const onSecondInstance = vi.fn();
    wireDeepLinks(SCHEME, onUrl, { app, process: proc(), onSecondInstance });

    app.listeners['second-instance']?.(
      {} as never,
      [
        '/path/to/electron',
        '--some-flag',
        'workos-auth://callback?code=c&state=s',
        'other-arg',
      ] as never,
    );

    expect(onUrl).toHaveBeenCalledWith('workos-auth://callback?code=c&state=s');
    expect(onSecondInstance).toHaveBeenCalled();
  });

  it('does not call onUrl when second-instance argv has no callback', () => {
    const app = makeApp();
    const onUrl = vi.fn();
    wireDeepLinks(SCHEME, onUrl, { app, process: proc(), onSecondInstance: vi.fn() });
    app.listeners['second-instance']?.({} as never, ['/electron', '--flag'] as never);
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('buffers and flushes a callback URL present in the initial argv (cold start)', () => {
    const app = makeApp();
    const onUrl = vi.fn();
    wireDeepLinks(SCHEME, onUrl, {
      app,
      process: proc({ argv: ['/electron', 'workos-auth://callback?code=cold&state=s'] }),
    });
    expect(onUrl).toHaveBeenCalledWith('workos-auth://callback?code=cold&state=s');
  });

  it('quits and wires nothing when the single-instance lock is not acquired', () => {
    const app = makeApp(false);
    const onUrl = vi.fn();
    const cleanup = wireDeepLinks(SCHEME, onUrl, { app, process: proc() });

    expect(app.quit).toHaveBeenCalled();
    expect(app.listeners['open-url']).toBeUndefined();
    // cleanup is a safe no-op.
    expect(() => cleanup()).not.toThrow();
  });

  it('cleanup removes both listeners', () => {
    const app = makeApp();
    const cleanup = wireDeepLinks(SCHEME, vi.fn(), { app, process: proc() });
    cleanup();
    expect(app.removed).toContain('open-url');
    expect(app.removed).toContain('second-instance');
  });
});
