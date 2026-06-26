/**
 * SDK-owned IPC channel names — the single source of truth.
 *
 * Both the preload bridge and the main-process handlers import these constants,
 * so channel names are never duplicated behind a fragile "these must match"
 * comment as they were in the hand-wired example.
 *
 * The `authkit:` prefix namespaces our channels to avoid collisions with a
 * consumer's own IPC traffic.
 */
export const IPC_CHANNELS = {
  /** Renderer -> main: resolve the current auth state (with refresh). */
  getUser: 'authkit:get-user',
  /** Renderer -> main: return the current short-lived access token. */
  getAccessToken: 'authkit:get-access-token',
  /** Renderer -> main: begin a sign-in ceremony. */
  signIn: 'authkit:sign-in',
  /** Renderer -> main: sign out and return the logout URL. */
  signOut: 'authkit:sign-out',
  /** Renderer -> main: switch the active organization. */
  switchToOrganization: 'authkit:switch-organization',
  /** Main -> renderer: broadcast that the auth state changed. */
  authChanged: 'authkit:auth-changed',
  /** Main -> renderer: broadcast that a sign-in / callback attempt failed. */
  authError: 'authkit:auth-error',
} as const;

/** Union of every SDK-owned IPC channel name. */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * The `window` global the bridge is exposed under by `exposeAuthKit()`.
 *
 * Lives here (not in the preload module) so renderer code and the types-only
 * globals.d.ts can derive the key without importing anything electron-loading.
 */
export const AUTHKIT_BRIDGE_KEY = '__authkit_electron';
