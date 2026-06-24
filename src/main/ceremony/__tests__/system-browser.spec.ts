import { describe, expect, it, vi } from 'vitest';
import type { AuthKitElectronConfig } from '../../../shared/types.js';
import { createCeremony } from '../index.js';
import { createSystemBrowserCeremony } from '../system-browser.js';

// The ceremonies import `shell`/`BrowserWindow` from electron; tests inject
// their own, so this mock only prevents the native binding from loading.
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, BrowserWindow: vi.fn() }));

const config: AuthKitElectronConfig = {
  clientId: 'client_test',
  redirectUri: 'workos-auth://callback',
};

describe('createSystemBrowserCeremony', () => {
  it('opens the URL via shell.openExternal', async () => {
    const openExternal = vi.fn(async () => {});
    const ceremony = createSystemBrowserCeremony({ shell: { openExternal } });

    await ceremony.open('https://api.workos.com/authorize?x=1');

    expect(openExternal).toHaveBeenCalledWith('https://api.workos.com/authorize?x=1');
  });

  it('onCallback is a no-op returning an unsubscribe (callbacks arrive via deep link)', () => {
    const ceremony = createSystemBrowserCeremony({ shell: { openExternal: vi.fn() } });
    const unsubscribe = ceremony.onCallback(() => {
      throw new Error('should never be called');
    });
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('createCeremony', () => {
  it('selects the system-browser ceremony by default', async () => {
    const openExternal = vi.fn(async () => {});
    const ceremony = createCeremony(config, { shell: { openExternal } });
    await ceremony.open('https://example.com');
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('selects the window ceremony when window mode is requested (Phase 4)', async () => {
    const openExternal = vi.fn(async () => {});
    const createWindow = vi.fn(() => ({
      webContents: { on: vi.fn() },
      loadURL: vi.fn(async () => {}),
      close: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
    }));
    const ceremony = createCeremony(
      { ...config, ceremony: { mode: 'window' } },
      { shell: { openExternal }, createWindow },
    );
    await ceremony.open('https://example.com');
    // Window mode opens an in-app BrowserWindow, NOT the system browser.
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
