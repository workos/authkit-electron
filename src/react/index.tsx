/**
 * `@workos/authkit-electron/react` — the renderer surface.
 *
 * A thin, framework-idiomatic wrapper over the IPC bridge exposed by
 * `exposeAuthKit()` on `window.__authkit_electron`. It holds only
 * renderer-safe state (`user` + claims + the short-lived access token) and
 * never the refresh token — that token has no IPC channel.
 *
 * Field and method names mirror the web SDK `@workos/authkit-react` so a
 * developer moving between web and desktop sees the same surface, plus the
 * Electron-specific extras (`sessionId`, `entitlements`, `claims`) the renderer
 * payload carries.
 */

export { AuthKitProvider } from './auth-kit-provider.js';
export type { AuthKitProviderProps } from './auth-kit-provider.js';

export { useAuth } from './use-auth.js';
export { useAccessToken } from './use-access-token.js';
export type { UseAccessTokenResult } from './use-access-token.js';

export { SignedIn, SignedOut } from './guards.js';

export type { AuthKitContextValue } from './context.js';

// Re-export the renderer-relevant types so consumers can annotate without
// reaching into deep paths. (User/claims originate from @workos-inc/node.)
export type {
  AuthErrorPayload,
  AuthKitClaims,
  Impersonator,
  RendererAuthPayload,
  User,
} from '../shared/types.js';
export type { SignInOptions } from '../shared/ipc.js';
