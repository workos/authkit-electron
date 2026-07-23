import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc-channels.js';

describe('IPC_CHANNELS', () => {
  it('exposes the SDK-owned channel names', () => {
    expect(IPC_CHANNELS.getUser).toBe('authkit:get-user');
    expect(IPC_CHANNELS.getAccessToken).toBe('authkit:get-access-token');
    expect(IPC_CHANNELS.signIn).toBe('authkit:sign-in');
    expect(IPC_CHANNELS.signOut).toBe('authkit:sign-out');
    expect(IPC_CHANNELS.switchToOrganization).toBe('authkit:switch-organization');
    expect(IPC_CHANNELS.authChanged).toBe('authkit:auth-changed');
    expect(IPC_CHANNELS.authError).toBe('authkit:auth-error');
  });

  it('namespaces every channel under "authkit:" and keeps them unique', () => {
    const names = Object.values(IPC_CHANNELS);
    for (const name of names) {
      expect(name.startsWith('authkit:')).toBe(true);
    }
    // No duplicate channel names — they are the single source of truth.
    expect(new Set(names).size).toBe(names.length);
  });
});
