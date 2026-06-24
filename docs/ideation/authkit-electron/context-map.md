# Context Map — Phase 5 (Example app + automated e2e)

_Scout agent tool unavailable in this headless workflow (no `Agent`/`TaskCreate`); produced via inline exploration per skill fallback. Extends the Phase 2 map (retained below)._

## Phase 5 Scout Confidence: 82/100 — GO

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 17/20 | All files known: seed `example/` from `electron-authkit-example`, delete its `src/main/auth/*` + `useAuth.ts`, rewire to `createAuthKit`/`exposeAuthKit`/`<AuthKitProvider>`. Add `tests/e2e/*`, `playwright.config.ts`, `.github/workflows/ci.yml`, `pnpm-workspace.yaml`. The one soft spot: e2e cannot run green here (no WorkOS test creds, no real browser-drive). |
| Pattern familiarity | 18/20 | Read every SDK public surface + the full example app + tanstack workspace/CI. SDK API verified against source, not guessed. |
| Dependency awareness | 18/20 | Example consumes ONLY the public API (`createAuthKit`, `exposeAuthKit`, `<AuthKitProvider>`, `useAuth`, guards). No internal SDK file changes needed. Workspace `workspace:*` resolves the built `dist`. |
| Edge case coverage | 15/20 | Known: vitest/Playwright `.spec.ts` collision; `isLoading` vs `loading` rename in components; `window.auth`→`window.__authkit_electron`; ceremony toggle. |
| Test strategy | 14/20 | vitest gate already green (with format fix). Playwright+Electron specs authored to spec; they will SKIP without `E2E_*` creds rather than hard-fail, with a clear message (spec Error Handling: "fail fast with a clear message; document the required secrets"). |

## Phase 5 Key Findings (verified — avoid re-reading)

### SDK public API the example must consume (from built `dist`)
- **Main**: `createAuthKit(config: AuthKitElectronConfig, opts?)` → `{ registerProtocol(): void; cleanup(): void }`. `config = { clientId, redirectUri, cookiePassword?, ceremony?: { mode?: 'system-browser' | 'window' }, storage? }`. Call `registerProtocol()` inside `app.whenReady()` (it runs `setAsDefaultProtocolClient` + wires deep links). `requestSingleInstanceLock()` stays in app code (SDK does not own it).
- **Preload**: `exposeAuthKit(): void` exposes `window.__authkit_electron` (key const `AUTHKIT_BRIDGE_KEY`). Renderer must declare `Window.__authkit_electron` typing (import `AuthKitBridge` from `@workos/authkit-electron/preload`).
- **React** (`@workos/authkit-electron/react`): `<AuthKitProvider>` (props: `children` only), `useAuth()` → `{ user, isLoading, signIn(opts?), signOut(opts?), switchToOrganization, getAccessToken, ...claims }`, `useAccessToken()`, `<SignedIn>` / `<SignedOut>`.
- **Rename trap**: old example hook returned `loading`; SDK uses **`isLoading`**. `user` is `@workos-inc/node` `User` (has `firstName`, `lastName`, `email`, `id`, `profilePictureUrl`).
- `signIn`/`signOut` throw on failure (provider unwraps `IpcResult`); components calling them directly should be fine since old code ignored the result.

### Example seed (`electron-authkit-example`) facts
- electron-vite app. `src/main/index.ts` calls `registerProtocol()` + `setupDeepLinkHandling` + `setupAuthIpcHandlers` + `getUser` — ALL replaced by 1 `createAuthKit` + `registerProtocol()`. Preload point: `join(__dirname, '../preload/index.mjs')`.
- `src/preload/index.ts` exposes `electronAPI` (`@electron-toolkit/preload`) + a hand-wired `authApi`. Replace `authApi` with `exposeAuthKit()`; keep `electronAPI` expose (harmless, used by template).
- Renderer: `main.tsx` renders `<App/>`; wrap in `<AuthKitProvider>`. `App.tsx` + `Home`/`Account`/`SignInButton` import the local `useAuth` from `./hooks/useAuth` → repoint to `@workos/authkit-electron/react` and rename `loading`→`isLoading`.
- `@workos-inc/node` is pinned `8.0.0-rc.10` → bump to `^10.4.0` (SDK peer). `electron` `^39` → keep (SDK peer `>=30`); align to repo's installed major if simpler.
- electron-vite externalizes deps by default; the SDK + `@workos-inc/node` resolve from `node_modules` (workspace symlink to built `dist`).

### Tooling / repo state (SDK repo @ `/Users/nicknisi/Developer/authkit-electron`)
- **No `pnpm-workspace.yaml` yet** — must add (`packages: ['.', 'example/']`), mirroring tanstack.
- **`publint`/`attw`/`@playwright/test`/`playwright` NOT installed.** Validation cmds reference them; add as devDeps. `attw` package is `@arethetypeswrong/cli`; `publint` is `publint`.
- `electron@42.5.0` installed at root (devDep). vitest gate currently green AFTER `oxfmt --write` on 3 pre-existing drifted files (`ipc-handlers.ts`, `session-manager.ts`, `deep-link.spec.ts`) — included since this phase adds a `format:check` CI gate.
- **vitest collision**: `vitest.config.ts` `include` has `tests/**/*.spec.ts`. Playwright e2e specs live at `tests/e2e/*.spec.ts` — MUST exclude `tests/e2e/**` from vitest `include`/add `exclude`, else vitest tries to run Playwright specs.
- `pnpm lint` exits 0 (only a pre-existing `no-underscore-dangle` warning in `context.ts`). `pnpm format:check` was exit 1 pre-fix.
- pnpm 10.27, node 24.

### e2e reality (spec Open Items + Error Handling)
- Playwright Electron via `import { _electron as electron } from '@playwright/test'`; `electron.launch({ args: [exampleMain] })`; first window via `app.firstWindow()`.
- system-browser mode drives the OS browser — Playwright cannot drive an external browser window it didn't launch; spec Open Item flags this. Approach: each test guards on `E2E_WORKOS_*` creds and **skips with a clear message** when absent (matches "fail fast with a clear message; document the required secrets" and "treat persistent failure as a real gate failure, not a skip" applies to flake, not missing-cred bootstrap). Without creds the suite is a no-op-skip, not a false pass; CI documents the required secrets.
- The two ceremony specs are separate files so dropping one fails the gate (success criterion 7).

## Phase 5 Risks
- **vitest picks up Playwright specs** → exclude `tests/e2e/**` in `vitest.config.ts`. (Mitigated in build.)
- **Example resolves SDK `src` not `dist`** → depend on `workspace:*`; electron-vite externalizes; no path alias to SDK src. Build SDK first.
- **e2e can't go green without creds/browser-drive** → tests skip-with-message; documented as the phase's known limitation. Not a false PASS.
- **`oxfmt`/`oxlint` over `example/`** → root `.oxfmtrc`/`.oxlintrc` ignore `dist`/`node_modules`; example source will be linted/formatted by the root config once under the repo. Keep example code formatted.

---

# Context Map — Phase 2 (Ceremony, deep-link & IPC) [retained]

## Scope Clarity: READY

Phase 1 (committed `ce5589a`) shipped the framework-agnostic session engine: `config.ts`, `storage.ts`, `session-manager.ts`, `shared/types.ts`, `shared/ipc-channels.ts`, `index.ts`. Phase 2 adds the ceremony (`shell.openExternal`), the cross-platform deep-link capture matrix, the callback re-orchestration (state round-trip outside `AuthService`), the IPC surface + broadcast, the preload bridge, and the `createAuthKit()` assembly.

## Readiness Gates: 5/5 READY — GO

- **Scope clarity**: READY — spec + contract explicit; Phase 1 primitives present and tested.
- **Pattern availability**: READY — example at `/Users/nicknisi/Developer/electron-authkit-example/src/main/auth/deep-link-handler.ts` (matrix, with the no-`state` bug to fix) and `ipc-handlers.ts`/`preload/index.ts` (IPC shape + channel-dup bug to fix). authkit-session core APIs verified in installed `dist`.
- **Dependency availability**: READY — `AuthKitCore.verifyCallbackState`, `AuthOperations.createAuthorization`, `WorkOS.userManagement.authenticateWithCode` all verified in installed types.
- **Test approach**: READY — vitest (node env), mock `electron`. `parseCallback` is pure; deep-link wiring + IPC drive fakes for `app`/`ipcMain`/`BrowserWindow`/`webContents`.
- **Convention clarity**: READY — NodeNext ESM, `.js` import extensions, `verbatimModuleSyntax` (`import type`), oxlint/oxfmt, 80% coverage, `*.spec.ts` colocated.

## Key Patterns (verified — avoid re-reading)

### authkit-session APIs (installed `@workos/authkit-session@0.6.0`)
- `AuthOperations.createAuthorization(options?: GetAuthorizationUrlOptions)` → `Promise<GeneratedAuthorizationUrl>` where `GeneratedAuthorizationUrl = { url, sealedState, cookieName, cookieOptions }`. The URL already embeds `state=sealedState`.
- `AuthKitCore.verifyCallbackState({ stateFromUrl; cookieValue })` → `Promise<PKCEState>`. Constant-time byte-compare BEFORE decrypt. Throws `OAuthStateMismatchError`, `PKCECookieMissingError`, `SessionEncryptionError`.
- Error classes exported from package root.

### Phase 1 surfaces to reuse (do NOT re-implement)
- `src/shared/types.ts`: `toRendererAuthPayload(auth)` strips `refreshToken` via allowlist destructure. `RendererAuthPayload` is the renderer-facing union.
- `src/shared/ipc-channels.ts`: `IPC_CHANNELS` is the SDK-owned channel map. Keys: `getUser, getAccessToken, signIn, signOut, switchToOrganization, authChanged`.
- `src/main/session-manager.ts`: factory `createSessionManager(deps)`.
- `src/main/storage.ts`: `createDefaultStorage(opts)` → `TokenStorage`.
- `src/main/config.ts`: `createPublicWorkOS(clientId)`; `toAuthKitConfig`; `MIN_COOKIE_PASSWORD_LENGTH = 32`.

## Conventions
- ESM-only, NodeNext; relative imports end in `.js`. `import type` for type-only (verbatimModuleSyntax).
- `noUncheckedIndexedAccess`, `strict`. oxlint correctness=error. oxfmt singleQuote.
- Tests colocated `*.spec.ts`; vitest globals; mock `electron`. 80% coverage thresholds (global).
- New files must build under `tsconfig.build.json` (excludes `*.spec.ts`).
