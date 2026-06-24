/**
 * @workos/authkit-electron — main-process entry.
 *
 * Phase 1 ships the framework-agnostic session engine. The `createAuthKit()`
 * assembly (wiring `BrowserWindow`, `ipcMain`, and the deep-link protocol)
 * arrives in Phase 2. For now we re-export the building blocks so they can be
 * composed and tested.
 */

// Config: public WorkOS client + internal AuthKitConfig construction.
export { MIN_COOKIE_PASSWORD_LENGTH, createPublicWorkOS, toAuthKitConfig } from './main/config.js';

// Storage: safeStorage-backed electron-store persistence.
export { EncryptionUnavailableError, createDefaultStorage } from './main/storage.js';
export type { CreateStorageOptions, KeyValueStoreLike, SafeStorageLike } from './main/storage.js';

// Session manager: the orchestrator over the core + operations + storage.
export { createSessionManager } from './main/session-manager.js';
export type { SessionManager, SessionManagerDeps } from './main/session-manager.js';

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
