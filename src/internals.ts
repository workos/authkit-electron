/**
 * @workos/authkit-electron/internals — lower-level building blocks.
 *
 * `createAuthKit()` (the root entry) wires these together for you. Import from
 * here only for advanced composition — bespoke wiring, non-React renderer
 * bindings, or tests. This surface is intentionally less stable than the root
 * entry; prefer `createAuthKit()` unless you specifically need a piece of it.
 */

// Custom-protocol scheme derivation.
export { schemeFromRedirectUri } from './main/create-auth-kit.js';

// Config: public WorkOS client + internal AuthKitConfig construction.
export { MIN_COOKIE_PASSWORD_LENGTH, createPublicWorkOS, toAuthKitConfig } from './main/config.js';

// Storage dependency-injection seams.
export type { KeyValueStoreLike, SafeStorageLike } from './main/storage.js';

// Session manager: the orchestrator over the core + operations + storage.
export { createSessionManager } from './main/session-manager.js';
export type {
  BeginSignInOptions,
  SessionManager,
  SessionManagerDeps,
} from './main/session-manager.js';

// Ceremony: sign-in flow abstraction (system-browser default).
export { createCeremony } from './main/ceremony/index.js';
export type { Ceremony, CreateCeremonyOptions, ShellLike } from './main/ceremony/index.js';

// Deep-link capture matrix + callback URL parsing.
export { isWebScheme, parseCallback, registerProtocol, wireDeepLinks } from './main/deep-link.js';
export type { AppLike, ProcessLike, WireDeepLinksOptions } from './main/deep-link.js';

// IPC handlers + auth-change / auth-error broadcast.
export {
  broadcastAuthChange,
  broadcastAuthError,
  registerIpcHandlers,
} from './main/ipc-handlers.js';
export type {
  BroadcastOptions,
  BrowserWindowsLike,
  IpcMainLike,
  RegisterIpcHandlersOptions,
} from './main/ipc-handlers.js';

// SDK-owned IPC channel names (the single source of truth for preload + main).
export { IPC_CHANNELS } from './shared/ipc-channels.js';
export type { IpcChannel } from './shared/ipc-channels.js';
