/**
 * Public-client configuration.
 *
 * Turns the consumer's public {@link AuthKitElectronConfig} into the internal
 * `AuthKitConfig` the core expects, plus a WorkOS client constructed WITHOUT an
 * API key. authkit-electron is a public OAuth client: only the `clientId` is
 * needed, so no secret ships in the binary. We deliberately bypass
 * authkit-session's `getWorkOS()` factory (which requires `apiKey`) and its
 * global `ConfigurationProvider`, building the config object ourselves.
 */

import { type WorkOS, createWorkOS } from '@workos-inc/node';
import type { AuthKitConfig } from '@workos/authkit-session';
import type { AuthKitElectronConfig } from '../shared/types.js';

/** The core requires a cookie password of at least this many characters. */
export const MIN_COOKIE_PASSWORD_LENGTH = 32;

/** Default session cookie max age (seconds): 400 days, matching AuthKit. */
const DEFAULT_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

/** Default session cookie name, matching authkit-session. */
const DEFAULT_COOKIE_NAME = 'wos-session';

/**
 * Construct a public WorkOS client for the given client ID.
 *
 * No API key is passed. Every code path authkit-electron uses
 * (`AuthKitCore`, `AuthOperations`, `generateAuthorizationUrl`) reads only the
 * injected client, `config.clientId`, and `config.cookiePassword` — never an
 * API key.
 *
 * Type note: in `@workos-inc/node` >= 10, `createWorkOS({ clientId })` (no
 * `apiKey`) returns the narrower `PublicWorkOS`, which lacks the admin-key
 * methods present on the full `WorkOS`. authkit-session's `AuthKitCore` /
 * `AuthOperations` are typed against the full `WorkOS`, but at runtime they call
 * ONLY the public subset (`userManagement.authenticateWithRefreshToken`,
 * `getJwksUrl`, `getLogoutUrl`, `authenticateWithCode`), all of which
 * `PublicWorkOS` implements. We therefore widen the type at this single,
 * documented boundary. (Upstream improvement: have the core accept a
 * `PublicWorkOS`-compatible client type.)
 */
export function createPublicWorkOS(clientId: string): WorkOS {
  return createWorkOS({ clientId }) as unknown as WorkOS;
}

/**
 * Assert the consumer passed a usable WorkOS Client ID.
 *
 * The #1 integration failure is a misnamed env var (`clientId: process.env.X`
 * where `X` is undefined), which without this check only surfaces once the
 * browser opens a broken authorization URL. Fail at construction instead,
 * with the expected `client_...` shape named in the message.
 *
 * @throws {Error} if `clientId` is not a non-blank string.
 */
export function assertValidClientId(clientId: unknown): asserts clientId is string {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error(
      `clientId is required — pass your WorkOS Client ID (it looks like ` +
        `"client_...", found in the WorkOS Dashboard). Received ${JSON.stringify(clientId)}. ` +
        `If you read it from an environment variable, make sure that variable is ` +
        `actually defined in the main process.`,
    );
  }
}

/**
 * Assert a cookie password meets the core's minimum length.
 *
 * @throws {Error} if shorter than {@link MIN_COOKIE_PASSWORD_LENGTH}.
 */
function assertValidCookiePassword(cookiePassword: string): void {
  if (cookiePassword.length < MIN_COOKIE_PASSWORD_LENGTH) {
    throw new Error(
      `cookiePassword must be at least ${MIN_COOKIE_PASSWORD_LENGTH} characters ` +
        `(received ${cookiePassword.length}). authkit-session requires this to ` +
        `seal the in-flight PKCE state.`,
    );
  }
}

/**
 * Build the internal `AuthKitConfig` from public config + a cookie password.
 *
 * The password may be a string (validated immediately) or a resolver thunk
 * (called lazily on first `cookiePassword` access, then validated and memoized).
 * The lazy form lets {@link createAuthKit} defer an OS-keychain read until the
 * core first seals/unseals PKCE state at sign-in — which is always after
 * `app.whenReady()`, when Electron's `safeStorage` is available. Both
 * `AuthKitCore` and `AuthOperations` store the config and only dereference
 * `cookiePassword` at seal/unseal time (never at construction), so a getter
 * suffices.
 *
 * `apiKey` is intentionally set to the empty string. It is NEVER read, because
 * we inject our own client (see {@link createPublicWorkOS}) rather than letting
 * authkit-session construct one from config. (Upstream improvement: make
 * `AuthKitConfig.apiKey` optional.)
 *
 * @throws {Error} if a string password is shorter than
 *   {@link MIN_COOKIE_PASSWORD_LENGTH} (a resolver throws on first read instead).
 */
export function toAuthKitConfig(
  config: AuthKitElectronConfig,
  cookiePassword: string | (() => string),
): AuthKitConfig {
  const base = {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    // Intentionally empty — never read because we inject our own client.
    apiKey: '',
    apiHttps: true,
    cookieMaxAge: DEFAULT_COOKIE_MAX_AGE,
    cookieName: DEFAULT_COOKIE_NAME,
  };

  if (typeof cookiePassword === 'string') {
    assertValidCookiePassword(cookiePassword);
    return { ...base, cookiePassword };
  }

  // Lazy resolver: defer the read (e.g. a safeStorage keychain hit) until the
  // core first dereferences cookiePassword. Validate + memoize on first access.
  let cached: string | undefined;
  return {
    ...base,
    get cookiePassword(): string {
      if (cached === undefined) {
        const resolved = cookiePassword();
        assertValidCookiePassword(resolved);
        cached = resolved;
      }
      return cached;
    },
  };
}
