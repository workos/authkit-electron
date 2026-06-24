# Implementation Spec: @workos/authkit-electron - Phase 2 (Ceremony, deep-link & IPC)

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Phase 2 makes sign-in actually happen. It adds the `system-browser` ceremony, the cross-platform deep-link capture matrix, the callback re-orchestration, the IPC surface, and the preload bridge — then assembles everything behind `createAuthKit()`. This is the highest-risk phase: the deep-link matrix and the callback re-orchestration are exactly the pieces `electron-authkit-example` got subtly wrong (it sends no `state` and stores a raw `codeVerifier`).

**Callback re-orchestration (blocker fix).** `AuthService.handleCallback` is unusable here — it is cookie/`SessionStorage`-bound (`AuthService.ts:350`). So we re-orchestrate using core primitives: at sign-in, `AuthOperations.createAuthorization()` returns `{ url, sealedState }` and embeds `state=sealedState` in the URL (`generateAuthorizationUrl.ts:112`); we persist `sealedState` main-side (electron-store, single-use, 10-min TTL — **not** a cookie). At callback, we feed the deep-link `state` back to `AuthKitCore.verifyCallbackState({ stateFromUrl, cookieValue: storedSealedState })` (a constant-time byte-compare + unseal), then call `client.userManagement.authenticateWithCode({ code, clientId, codeVerifier })`, build the `Session`, persist via the Phase 1 storage, and broadcast.

**Deep-link matrix.** `registerProtocol()` wraps `app.setAsDefaultProtocolClient(scheme)` with the `process.defaultApp` dev-mode `argv` branch, acquires the single-instance lock, and wires `open-url` (macOS) + `second-instance` (Windows/Linux, parsing the URL out of `argv`). All callback URLs route to `sessionManager.completeCallback`.

**IPC + preload.** The SDK owns the channel names in `src/shared/ipc-channels.ts` (Phase 1) — preload imports them, never redeclares. IPC results are discriminated unions so errors survive `ipcRenderer.invoke` rejection-flattening. Auth changes broadcast to every window's `webContents`.

**Pattern to follow**: `electron-authkit-example/src/main/auth/deep-link-handler.ts` (the matrix, minus its no-`state` bug) and `ipc-handlers.ts` (the IPC shape, minus the channel duplication). For discriminated IPC results, `@clerk/electron`'s `PasskeyIpcResult`.

## Feedback Strategy

**Inner-loop command**: `pnpm vitest run callback deeplink ipc`

**Playground**: Test suite for the logic (URL parsing, callback orchestration, IPC payload shape against a mocked `ipcMain`/`webContents`); a manual smoke for the real browser hop.

**Why this approach**: The risky logic (state round-trip, URL parsing, payload shape) is unit-testable and must be; only the actual `shell.openExternal` hop needs eyes-on, and that is one manual check.

## File Changes

### New Files

| File Path | Purpose |
|---|---|
| `src/main/ceremony/index.ts` | `Ceremony` interface (`open(url)`, `onCallback(cb)`) + mode selection |
| `src/main/ceremony/system-browser.ts` | `shell.openExternal(url)`; callbacks arrive via the deep-link handler |
| `src/main/deep-link.ts` | `registerProtocol()`, single-instance lock, `open-url`/`second-instance`, URL parse → `completeCallback` |
| `src/main/ipc-handlers.ts` | Register `ipcMain.handle` for each channel; `broadcastAuthChange()`; strip `refreshToken` from payloads |
| `src/main/create-auth-kit.ts` | `createAuthKit(config)` assembly → `{ registerProtocol, cleanup }` |
| `src/preload/index.ts` | `exposeAuthKit()` contextBridge bridge using shared channel names |
| `src/main/__tests__/callback.spec.ts` | Callback re-orchestration tests |
| `src/main/__tests__/deep-link.spec.ts` | URL parse matrix tests |
| `src/main/__tests__/ipc-handlers.spec.ts` | Channel registration + payload-shape (no `refreshToken`) tests |
| `src/preload/__tests__/index.spec.ts` | Bridge shape + contextIsolated branch |

### Modified Files

| File Path | Changes |
|---|---|
| `src/main/session-manager.ts` | Add `beginSignIn(opts)` and `completeCallback(code, state)` |
| `src/main/storage.ts` | Add `setPendingVerifier`/`takePendingVerifier` (single-use, TTL) |
| `src/index.ts` | Export `createAuthKit` |

## Implementation Details

### Sign-in + callback (`session-manager.ts`)

**Overview**: The two methods that own the OAuth round-trip without `AuthService`.

```typescript
async beginSignIn(opts?: { screenHint?: 'sign-in' | 'sign-up'; organizationId?: string }): Promise<void> {
  const { url, sealedState } = await this.operations.createAuthorization(opts);
  this.storage.setPendingVerifier(sealedState, sealedState); // key = value = sealedState; single-use + TTL
  await this.ceremony.open(url);                              // system-browser: shell.openExternal
}

async completeCallback(code: string, stateFromUrl: string | undefined): Promise<AuthResult> {
  const stored = stateFromUrl ? this.storage.takePendingVerifier(stateFromUrl) : null;
  const { codeVerifier } = await this.core.verifyCallbackState({ stateFromUrl, cookieValue: stored ?? undefined });
  const res = await this.client.userManagement.authenticateWithCode({ code, clientId: this.config.clientId, codeVerifier });
  const session = { accessToken: res.accessToken, refreshToken: res.refreshToken, user: res.user, impersonator: res.impersonator };
  this.storage.setSession(session);
  return authResultFromSession(session); // shape matching core's AuthResult
}
```

**Key decisions**:
- Pending verifier keyed by `sealedState` (single-use `take`, 10-min TTL matching the core's PKCE TTL). Supports concurrent sign-ins from multiple windows.
- On any callback error (missing/!match state, exchange failure), delete the pending verifier and surface a typed error; never persist a partial session.

**Feedback loop**:
- **Playground**: `callback.spec.ts` with a mocked WorkOS `authenticateWithCode` and a real `verifyCallbackState` (drive it with a `sealedState` produced by a real `createAuthorization`).
- **Experiment**: (a) happy path → session persisted; (b) `state` absent → throws, nothing persisted; (c) `state` mismatch → throws; (d) `authenticateWithCode` rejects → verifier cleared, throws; (e) two concurrent flows resolve independently.
- **Check command**: `pnpm vitest run callback`

### Deep-link capture (`deep-link.ts`)

**Pattern to follow**: `electron-authkit-example/src/main/auth/deep-link-handler.ts`

```typescript
export function registerProtocol(scheme: string): void;        // setAsDefaultProtocolClient + dev argv branch
export function wireDeepLinks(onUrl: (url: string) => void): () => void; // open-url + second-instance; returns cleanup
export function parseCallback(url: string): { code?: string; state?: string; error?: string };
```

**Implementation steps**:
1. `registerProtocol`: `process.defaultApp && argv.length>=2` → `setAsDefaultProtocolClient(scheme, execPath, [resolve(argv[1])])`, else `setAsDefaultProtocolClient(scheme)`.
2. `app.requestSingleInstanceLock()`; if not acquired, `app.quit()`.
3. `app.on('open-url', (e,url)=>{ e.preventDefault(); onUrl(url) })` (macOS); `app.on('second-instance', (_e,argv)=>{ const u=argv.find(a=>a.startsWith(scheme+'://')); if(u) onUrl(u); focusWindow() })`.
4. `parseCallback` reads `code`/`state`/`error` from the URL search params.

**Feedback loop**:
- **Playground**: `deep-link.spec.ts` — unit-test `parseCallback` (no Electron needed); mock `app` for the handler wiring.
- **Experiment**: parse URLs with `code+state`, `error`, neither, extra params; assert `second-instance` argv extraction finds the `scheme://` arg among noise.
- **Check command**: `pnpm vitest run deeplink`

### IPC handlers + broadcast (`ipc-handlers.ts`)

```typescript
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export function registerIpcHandlers(sm: SessionManager): () => void; // signIn, signOut, getUser, getAccessToken, switchOrg
export function broadcastAuthChange(user: RendererUser | null): void; // webContents of all windows
```

**Key decisions**:
- Every renderer-facing payload is built by a `toRendererPayload(authResult)` that **omits `refreshToken`** (the load-bearing security property — Phase 3 consumes it, Phase 1/2 enforce it).
- Errors are caught and returned as `{ ok: false, error }`, never thrown across `invoke`.
- Broadcast iterates `BrowserWindow.getAllWindows()` → `webContents.send(ON_AUTH_CHANGE, payload)`.

**Feedback loop**:
- **Playground**: `ipc-handlers.spec.ts` with a fake `ipcMain` capturing handlers and a stub `SessionManager`.
- **Experiment**: invoke each channel; assert `getUser`/`getAccessToken` payloads have **no `refreshToken`** key; assert a thrown SM error becomes `{ ok:false }`.
- **Check command**: `pnpm vitest run ipc`

### Preload bridge (`preload/index.ts`)

```typescript
import { AUTH_CHANNELS } from '../shared/ipc-channels'; // no redeclaration
export function exposeAuthKit(): void; // contextBridge.exposeInMainWorld('__authkit_electron', api) with contextIsolated branch
```

### Assembly (`create-auth-kit.ts`)

```typescript
export function createAuthKit(config: AuthKitElectronConfig): {
  registerProtocol(): void;   // call in app.whenReady()
  cleanup(): void;            // remove ipc handlers + deep-link listeners
};
```

## Data Model

### IPC contract (`src/shared/ipc-channels.ts`)
```typescript
export const AUTH_CHANNELS = {
  signIn: 'authkit:sign-in', signOut: 'authkit:sign-out',
  getUser: 'authkit:get-user', getAccessToken: 'authkit:get-access-token',
  switchOrganization: 'authkit:switch-org', onAuthChange: 'authkit:on-auth-change',
} as const;
```
### Renderer-facing payload (no refresh token)
```typescript
interface RendererAuth { user: User | null; sessionId?: string; organizationId?: string;
  role?: string; roles?: string[]; permissions?: string[]; entitlements?: string[]; featureFlags?: string[]; }
```

## Testing Requirements

### Unit Tests
| Test File | Coverage |
|---|---|
| `callback.spec.ts` | state round-trip, exchange, error cleanup, concurrent flows |
| `deep-link.spec.ts` | `parseCallback` matrix, `second-instance` argv extraction |
| `ipc-handlers.spec.ts` | channel registration, `refreshToken` absent, error → `{ok:false}` |
| `preload/index.spec.ts` | bridge shape, contextIsolated branch |

### Manual Testing
- [ ] `pnpm --filter ./example dev`, click sign-in → system browser opens AuthKit, authenticate, app receives the deep link, user appears in all open windows.
- [ ] Quit the app mid-flow, relaunch, retry → sign-in succeeds (per-install `cookiePassword` survived).

## Error Handling

| Error Scenario | Handling Strategy |
|---|---|
| Callback missing `state` | Throw `OAuthStateMismatchError` path; clear nothing to persist; surface `{ok:false}` to renderer |
| `state` mismatch / tampered seal | `verifyCallbackState` throws; delete pending verifier; `{ok:false}` |
| `authenticateWithCode` fails | Delete pending verifier; `{ok:false}` with code |
| Protocol not OS-registered (packaged) | Document `electron-builder` `protocols` config; `registerProtocol` covers runtime only |
| Second instance can't get lock | First instance handles the URL via `second-instance`; second quits |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Deep link | Protocol unregistered at install | Missing `electron-builder.protocols` in packaged app | Callback never returns to app | Document the build-config requirement; add to example's `electron-builder.yml` |
| Deep link | Lost callback on cold start | App not running when OS dispatches the URL | Sign-in appears to hang | `second-instance`/`open-url` fire post-`whenReady`; buffer a URL received before handlers attach |
| Callback | Stranded verifier | App quit after `take` but before exchange | One failed sign-in | Single-use + 10-min TTL; user retries |
| IPC | Refresh token leak | A future payload forgets to strip it | Credential exposure in renderer | Centralize in `toRendererPayload`; payload-shape test asserts absence |
| Broadcast | Window destroyed mid-send | `webContents.send` to a closed window | Throw/no-op | Guard with `!wc.isDestroyed()` |

## Validation Commands

```bash
pnpm tsc --noEmit
pnpm lint
pnpm vitest run --coverage
pnpm build
```

## Open Items

- [ ] Confirm whether a callback URL can arrive before `whenReady`/handlers attach on Windows cold start, and buffer if so.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
