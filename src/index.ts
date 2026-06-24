/**
 * @workos/authkit-electron — main-process entry.
 *
 * Phase 1 shipped the framework-agnostic session engine; Phase 2 adds the
 * `createAuthKit()` assembly that wires the ceremony, the cross-platform
 * deep-link capture, the IPC surface, and the auth-change broadcast. Consumers
 * call `createAuthKit()` in the main process; the building blocks remain
 * exported for advanced composition and testing.
 */

// One-call assembly: ceremony + deep-link + IPC + broadcast.
export { createAuthKit, schemeFromRedirectUri } from './main/create-auth-kit.js';
export type { CreateAuthKitOptions, CreateAuthKitResult } from './main/create-auth-kit.js';

// Config: public WorkOS client + internal AuthKitConfig construction.
export { MIN_COOKIE_PASSWORD_LENGTH, createPublicWorkOS, toAuthKitConfig } from './main/config.js';

// Storage: safeStorage-backed electron-store persistence.
export { EncryptionUnavailableError, createDefaultStorage } from './main/storage.js';
export type { CreateStorageOptions, KeyValueStoreLike, SafeStorageLike } from './main/storage.js';

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
export { parseCallback, registerProtocol, wireDeepLinks } from './main/deep-link.js';
export type { AppLike, ProcessLike, WireDeepLinksOptions } from './main/deep-link.js';

// IPC handlers + auth-change broadcast.
export { broadcastAuthChange, registerIpcHandlers } from './main/ipc-handlers.js';
export type {
  BroadcastOptions,
  BrowserWindowsLike,
  IpcMainLike,
  IpcResult,
  RegisterIpcHandlersOptions,
} from './main/ipc-handlers.js';

// SDK-owned IPC channel names (consumed by preload + main in Phase 2).
export { IPC_CHANNELS } from './shared/ipc-channels.js';
export type { IpcChannel } from './shared/ipc-channels.js';

// Shared types (also surfaces @workos-inc/node's User/claims types).
export { toRendererAuthPayload } from './shared/types.js';
export type {
  AuthKitClaims,
  AuthKitElectronConfig,
  AuthResult,
  BaseTokenClaims,
  CustomClaims,
  Impersonator,
  RendererAuthPayload,
  Session,
  TokenStorage,
  User,
} from './shared/types.js';
