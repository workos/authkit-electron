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
 * Build the internal `AuthKitConfig` from public config + a resolved cookie
 * password.
 *
 * `apiKey` is intentionally set to the empty string. It is NEVER read, because
 * we inject our own client (see {@link createPublicWorkOS}) rather than letting
 * authkit-session construct one from config. (Upstream improvement: make
 * `AuthKitConfig.apiKey` optional.)
 *
 * @throws {Error} if `cookiePassword` is shorter than
 *   {@link MIN_COOKIE_PASSWORD_LENGTH}.
 */
export function toAuthKitConfig(
  config: AuthKitElectronConfig,
  cookiePassword: string,
): AuthKitConfig {
  if (cookiePassword.length < MIN_COOKIE_PASSWORD_LENGTH) {
    throw new Error(
      `cookiePassword must be at least ${MIN_COOKIE_PASSWORD_LENGTH} characters ` +
        `(received ${cookiePassword.length}). authkit-session requires this to ` +
        `seal the in-flight PKCE state.`,
    );
  }

  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    cookiePassword,
    // Intentionally empty — never read because we inject our own client.
    apiKey: '',
    apiHttps: true,
    cookieMaxAge: DEFAULT_COOKIE_MAX_AGE,
    cookieName: DEFAULT_COOKIE_NAME,
  };
}
