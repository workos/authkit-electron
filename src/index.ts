/**
 * @workos/authkit-electron — main-process entry (the supported surface).
 *
 * Call `createAuthKit()` in the main process to assemble the auth runtime. The
 * preload bridge lives at `@workos/authkit-electron/preload` and the React
 * renderer bindings at `@workos/authkit-electron/react`.
 *
 * Lower-level building blocks for advanced composition (custom renderer
 * bindings, bespoke wiring) are exported from
 * `@workos/authkit-electron/internals` — a deliberately smaller, less stable
 * surface that `createAuthKit()` assembles for you.
 */

// One-call assembly.
export { createAuthKit } from './main/create-auth-kit.js';
export type { CreateAuthKitOptions, CreateAuthKitResult } from './main/create-auth-kit.js';

// Default safeStorage-backed persistence: the factory + options, plus the error
// consumers catch when OS encryption is unavailable.
export { EncryptionUnavailableError, createDefaultStorage } from './main/storage.js';
export type { CreateStorageOptions } from './main/storage.js';

// The renderer↔main IPC result wrapper, for annotating bridge calls.
export type { IpcResult } from './shared/ipc.js';

// Shared types (also surfaces @workos-inc/node's User/claims types so consumers
// never redeclare them).
export { toRendererAuthPayload } from './shared/types.js';
export type {
  AuthErrorPayload,
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
