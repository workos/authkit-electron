# Implementation Spec: @workos/authkit-electron - Phase 1 (Core session engine)

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 1 builds the main-process "session engine" — the framework-agnostic, Electron-window-free core every later phase depends on. It composes `@workos/authkit-session`'s exported `AuthKitCore` and `AuthOperations` with a WorkOS client we construct ourselves, plus Electron-native persistence. No `BrowserWindow`, `ipcMain`, or protocol code yet — that lands in Phase 2, so this phase is fully unit-testable against a mocked WorkOS client.

The defining decision is operating as a **public OAuth client**. We call `createWorkOS({ clientId })` (no API key) and inject that client into `new AuthKitCore(config, client, sessionEncryption)` and `new AuthOperations(core, client, config, sessionEncryption)`, deliberately bypassing `authkit-session`'s `getWorkOS()` factory (which requires `apiKey` — `client/workos.ts:11`) and its global `ConfigurationProvider`. We build a plain `AuthKitConfig` object directly; `apiKey` is set to `''` because none of the code paths we use read it (verified: `AuthKitCore`, `AuthOperations`, and `generateAuthorizationUrl` use only the injected `client`, `config.clientId`, and `config.cookiePassword`).

Persistence is Electron-native. An `electron-store` instance encrypted via `safeStorage` (OS keychain) holds the `Session` and a per-install `cookiePassword` generated on first run. We do **not** use `core.encryptSession` for at-rest storage — `safeStorage` is the at-rest protection; `cookiePassword` exists only to satisfy the core's sealing of PKCE state in Phase 2. The session manager exposes `getUser`/`getAccessToken`/`signOut`/`switchToOrganization` and wraps `core.validateAndRefresh`, inheriting its in-flight-dedup + rate-limit retry for free.

**Pattern to follow**: `authkit-session/src/service/AuthService.ts` shows how to compose `AuthKitCore` + `AuthOperations` — we replicate the composition WITHOUT the `SessionStorage`/cookie layer. The hand-rolled operations being replaced live in `electron-authkit-example/src/main/auth/auth.ts`.

## Feedback Strategy

**Inner-loop command**: `pnpm vitest run session-manager`

**Playground**: Test suite — Phase 1 is pure logic exercised against a mocked WorkOS client; tests run in milliseconds.

**Why this approach**: The whole phase is data/logic with no UI; a scoped vitest run is the tightest loop and mirrors how `authkit-session` tests its own core.

## File Changes

### New Files

| File Path | Purpose |
|---|---|
| `package.json` | ESM-only manifest; subpath exports (`.`, `./preload`, `./react`); deps `@workos/authkit-session`, `electron-store`; peers `@workos-inc/node@^10.4.0`, `electron`, `react`, `react-dom` (react* optional, for `./react`) |
| `tsconfig.json`, `tsconfig.build.json` | TS config mirroring `authkit-session` |
| `vitest.config.ts` | Vitest config with 80% coverage thresholds (authkit-session precedent) |
| `src/shared/types.ts` | Re-export `User`/`Impersonator`/claims from `@workos-inc/node`; define `AuthKitElectronConfig` and renderer-facing payload types (no `refreshToken`) |
| `src/shared/ipc-channels.ts` | SDK-owned IPC channel-name constants (single source of truth; consumed by preload + main in Phase 2) |
| `src/main/config.ts` | Construct public-client WorkOS instance + internal `AuthKitConfig`; generate/load per-install `cookiePassword` |
| `src/main/storage.ts` | `electron-store` + `safeStorage` persistence for session + secret; documented refusal when encryption unavailable |
| `src/main/session-manager.ts` | Compose `AuthKitCore`/`AuthOperations`; `getUser`/`getAccessToken`/`refresh`/`signOut`/`switchToOrganization` |
| `src/index.ts` | Main-process entry; re-exports config/types (the `createAuthKit` assembly arrives in Phase 2) |
| `src/main/__tests__/session-manager.spec.ts` | Unit tests against a mocked WorkOS client |
| `src/main/__tests__/storage.spec.ts` | Persistence + safeStorage-unavailable refusal tests |

### Modified Files

None — greenfield repo.

## Implementation Details

### Public-client config (`src/main/config.ts`)

**Overview**: Turns the consumer's public config into the internal `AuthKitConfig` + an injected WorkOS client, with no API key anywhere.

```typescript
import { createWorkOS } from '@workos-inc/node';
import type { AuthKitConfig } from '@workos/authkit-session';

export interface AuthKitElectronConfig {
  clientId: string;
  redirectUri: string;          // e.g. 'workos-auth://callback'
  cookiePassword?: string;      // optional override; else per-install generated
  ceremony?: { mode?: 'system-browser' | 'window' };
  storage?: TokenStorage;       // optional custom adapter (stretch); defaults to electron-store
}

// Build the config the core expects. apiKey is '' — never read because we inject our own client.
export function toAuthKitConfig(c: AuthKitElectronConfig, cookiePassword: string): AuthKitConfig;
export function createPublicWorkOS(clientId: string): WorkOS; // createWorkOS({ clientId })
```

**Key decisions**:
- `apiKey: ''` is intentional and documented; a comment must explain it is never read because the client is injected. (Upstream improvement: make `AuthKitConfig.apiKey` optional.)
- `cookiePassword` precedence: explicit config > per-install keychain secret (generated if absent).

**Implementation steps**:
1. `createPublicWorkOS` wraps `createWorkOS({ clientId })`.
2. `toAuthKitConfig` fills `clientId`, `redirectUri`, `cookiePassword`, `apiKey: ''`, and the core's other defaults (`apiHttps: true`, `cookieMaxAge`, `cookieName`).
3. Validate `cookiePassword.length >= 32` (core requirement); throw a clear error otherwise.

**Feedback loop**:
- **Playground**: `config.spec.ts` with a smoke test asserting `toAuthKitConfig` returns `apiKey === ''` and a 32+ char password.
- **Experiment**: build config with (a) explicit password, (b) generated password, (c) a 10-char password → expect throw.
- **Check command**: `pnpm vitest run config`

### Storage (`src/main/storage.ts`)

**Overview**: `safeStorage`-encrypted `electron-store` holding the session, the per-install `cookiePassword`, and (Phase 2) pending PKCE verifiers.

```typescript
import type { Session } from '@workos/authkit-session';

export interface TokenStorage {        // public seam (stretch tier swaps this)
  getSession(): Session | null;
  setSession(s: Session): void;
  clearSession(): void;
  getOrCreateCookiePassword(): string; // per-install, 32+ chars
  // Phase 2 adds: setPendingVerifier / takePendingVerifier
}

export function createDefaultStorage(opts?: { name?: string }): TokenStorage;
```

**Key decisions**:
- At-rest encryption is `safeStorage` (OS keychain), not `core.encryptSession`. The stored value is the `Session` JSON encrypted by `safeStorage`.
- `getOrCreateCookiePassword` generates 32 random bytes on first run and persists them (safeStorage-encrypted); stable across launches so an app quit mid-sign-in can still verify the PKCE state.
- **safeStorage unavailable** (e.g. Linux without a keyring): refuse to persist and throw a typed `EncryptionUnavailableError` by default. An explicit `allowPlaintext` opt-in is documented but off by default.

**Implementation steps**:
1. Wrap `electron-store`; on read/write, `safeStorage.encryptString`/`decryptString` the JSON.
2. `getOrCreateCookiePassword`: read; if absent, `crypto.randomBytes(32).toString('base64url')`, persist, return.
3. Guard every write with `safeStorage.isEncryptionAvailable()`; throw `EncryptionUnavailableError` if false.

**Feedback loop**:
- **Playground**: `storage.spec.ts` mocking `electron`'s `safeStorage` (available + unavailable).
- **Experiment**: round-trip a session; rehydrate and assert equality; flip `isEncryptionAvailable()` to false and assert the refusal throws.
- **Check command**: `pnpm vitest run storage`

### Session manager (`src/main/session-manager.ts`)

**Overview**: The orchestrator. Composes the core with the injected client + storage and exposes the operations the IPC layer (Phase 2) will call.

```typescript
import { AuthKitCore, AuthOperations, default as sessionEncryption } from '@workos/authkit-session';
import type { AuthResult, Session } from '@workos/authkit-session';

export interface SessionManager {
  getUser(): Promise<AuthResult>;                 // decrypt -> validateAndRefresh -> persist if refreshed
  getAccessToken(): Promise<string | null>;        // from getUser(); never returns refreshToken
  signOut(opts?: { returnTo?: string }): Promise<{ logoutUrl: string }>;
  switchToOrganization(orgId: string): Promise<AuthResult>;
  // Phase 2 adds: beginSignIn() and completeCallback(code, state)
}

export function createSessionManager(deps: {
  core: AuthKitCore; operations: AuthOperations; storage: TokenStorage; config: AuthKitConfig;
}): SessionManager;
```

**Key decisions**:
- `getUser` reads the stored `Session`, runs `core.validateAndRefresh(session)`, and on `refreshed: true` re-persists via `storage.setSession`. Returns the core's `AuthResult` (already omits nothing — the IPC layer strips `refreshToken`, not this method).
- `signOut` uses `operations.getLogoutUrl(sessionId)` then `storage.clearSession()`.
- `switchToOrganization` delegates to `operations.switchOrganization` (force refresh + new org), then persists.

**Implementation steps**:
1. Construct `core`/`operations` from injected client + config (in `config.ts` or a small factory).
2. Implement `getUser` with the decrypt→validate→refresh→persist flow.
3. Implement `getAccessToken` as a thin wrapper returning `auth.user ? auth.accessToken : null`.
4. Implement `signOut`, `switchToOrganization`.

**Feedback loop**:
- **Playground**: `session-manager.spec.ts` with a `MockWorkOS` exposing `userManagement.authenticateWithRefreshToken`, `getJwksUrl`, `getLogoutUrl`.
- **Experiment**: (a) valid token → returns user, no refresh; (b) expired token → refresh called once, new session persisted; (c) refresh throws → session cleared, `{ user: null }`; (d) `getAccessToken` returns null when signed out.
- **Check command**: `pnpm vitest run session-manager`

## Data Model

### Internal config passed to the core
```typescript
// apiKey '' is deliberate — never read because we inject the client.
{ clientId, redirectUri, cookiePassword, apiKey: '', apiHttps: true, cookieMaxAge, cookieName: 'wos-session' }
```

### Persisted (electron-store, safeStorage-encrypted)
```typescript
{ session: Session | null; cookiePassword: string; /* Phase 2 */ pendingVerifiers: Record<string, string> }
```

## Testing Requirements

### Unit Tests
| Test File | Coverage |
|---|---|
| `src/main/__tests__/session-manager.spec.ts` | getUser refresh paths, getAccessToken, signOut, switchToOrganization |
| `src/main/__tests__/storage.spec.ts` | session round-trip, cookiePassword generation/stability, safeStorage-unavailable refusal |
| `src/main/__tests__/config.spec.ts` | apiKey==='' , password precedence + length validation |

**Key test cases**:
- Expired access token triggers exactly one refresh (dedup), new session persisted.
- Refresh failure clears the session and returns `{ user: null }`.
- `safeStorage.isEncryptionAvailable() === false` → `EncryptionUnavailableError`, nothing persisted.
- `cookiePassword` is stable across two `createDefaultStorage` instances (same store).

## Error Handling

| Error Scenario | Handling Strategy |
|---|---|
| `cookiePassword` < 32 chars | Throw at config build with a message naming the requirement |
| `safeStorage` unavailable | Throw `EncryptionUnavailableError`; do not persist; documented `allowPlaintext` opt-in |
| Refresh token invalid/expired | `validateAndRefresh` throws → clear session, return `{ user: null }` |
| Corrupt/undecryptable stored session | Treat as no session; clear and return `{ user: null }` |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Storage | Keychain locked / unavailable | Linux without libsecret; locked keychain | Cannot persist session | Refuse with typed error; documented opt-in plaintext for dev |
| Session manager | Refresh storm | Many windows call `getUser` while token expired | Redundant refresh calls | `core.refreshTokens` already dedups in-flight by refresh token + org |
| Session manager | Clock skew | Device clock ahead/behind | Premature/late refresh | `core.isTokenExpiring` uses a buffer; rely on JWKS verify, not local exp alone |
| Config | Empty `apiKey` misread upstream | A future authkit-session reads `config.apiKey` | Broken auth | Pin `@workos-inc/node`/`authkit-session`; covered by integration test that asserts no network call needs a key |

## Validation Commands

```bash
pnpm tsc --noEmit
pnpm lint
pnpm vitest run --coverage
pnpm build
```

## Open Items

- [ ] Confirm the exact `@workos/authkit-session` version that exports `AuthKitCore`/`AuthOperations`/`sessionEncryption` and pin it.
- [ ] Decide `electron-store` major (it is ESM-only in recent majors — aligns with our ESM-only stance).

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
