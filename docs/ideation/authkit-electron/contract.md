# @workos/authkit-electron Contract

**Created**: 2026-06-24
**Readiness**: All 5 gates ready
**Status**: Approved
**Supersedes**: None
**Approved scope tier**: Full (MVP + Full)

## Problem Statement

WorkOS AuthKit has no Electron SDK. Integrating it today means hand-wiring the full OAuth and session lifecycle across Electron's three isolated process contexts — main, preload, and renderer — as the `electron-authkit-example` repo does across `src/main/auth/` (auth.ts, deep-link-handler.ts, ipc-handlers.ts), `src/preload/index.ts`, and the renderer's `src/renderer/src/hooks/useAuth.ts`.

That hand-wiring concentrates several error-prone, security-sensitive concerns in application code: PKCE generation and expiry, authorization-code exchange, JWT-exp parsing and token refresh, the cross-platform custom-protocol deep-link capture matrix (open-url on macOS, second-instance on Windows/Linux, the dev-mode argv branch), safeStorage-backed persistence behind a hardcoded key, and a private IPC contract whose channel names are duplicated between preload and main behind a fragile "must match" comment. The renderer additionally redefines its own `User` type, which drifts from `@workos-inc/node`'s.

Every team adopting AuthKit on Electron re-derives this same boilerplate and inherits the same latent bugs. WorkOS already ships `@workos/authkit-session` — the framework-agnostic core powering `@workos/authkit-tanstack-react-start` — whose `AuthKitCore` and `AuthOperations` are cookie-free and accept an injected WorkOS client, so the building blocks exist; there is simply no packaging of them for Electron's runtime model.

## Goals

1. Collapse the three-context integration to one call per context — `createAuthKit()` in main, `exposeAuthKit()` in preload, `<AuthKitProvider>` in the renderer — replacing the ~5 hand-wired files in `electron-authkit-example`.
2. Reuse `@workos/authkit-session`'s core (`AuthKitCore`, `AuthOperations`, `sessionEncryption`) for all security-sensitive logic — zero re-implemented crypto, PKCE, JWT verification, or token-refresh code — operating as a **public OAuth client**: construct the WorkOS client with `clientId` only (no API key shipped) and inject it into the core, bypassing the API-key-requiring `getWorkOS()` factory and the global `ConfigurationProvider`.
3. Confine the refresh token to the main process so it appears in no renderer-facing IPC payload, while exposing the short-lived access token through `getAccessToken()`.
4. Persist the session at rest via `safeStorage` (OS keychain), and seal the in-flight PKCE verifier with a per-install, ≥32-char `cookiePassword` generated on first run and stored in the keychain — no static secret ships in the binary.
5. Own the IPC contract inside the package so consumers never redeclare channel names, and surface `@workos-inc/node`'s `User`/claims types directly to eliminate type drift.
6. Support both sign-in ceremonies — system-browser (default) and in-app window — and the full cross-platform deep-link capture matrix out of the box.
7. Ship as a single ESM package with subpath exports (root for main, `/preload`, `/react`) that version in lockstep, plus an in-repo example app that consumes it.

## Success Criteria

- [ ] Coverage-gated unit/integration suite covers token refresh on expiry, callback code-exchange with PKCE state verification, the deep-link parse matrix, IPC payload shape, and the safeStorage-unavailable refusal path — check: `pnpm vitest run --coverage` — exits 0 against a configured threshold (80%, authkit-session precedent)
- [ ] The refresh token never appears in any renderer-facing IPC payload — check: `pnpm vitest run` (IPC payload-shape tests assert `refreshToken` is absent) — exits 0
- [ ] Security-sensitive crypto/PKCE/JWT/refresh logic is delegated to `@workos/authkit-session`, not re-implemented locally — check: CI grep guard — `grep -rnE 'jose|iron-webcrypto|jwtVerify|createRemoteJWKSet|generateCodeChallenge' src/` yields only import/re-export lines from `@workos/authkit-session` — exits 0
- [ ] Package exports resolve for main, `/preload`, and `/react` as ESM with correct type definitions — check: `pnpm publint && pnpm attw --pack --profile esm-only` — exits 0
- [ ] The library builds and typechecks cleanly — check: `pnpm build && pnpm tsc --noEmit` — exits 0
- [ ] Lint and format pass (oxlint/oxfmt, matching authkit-session) — check: `pnpm lint && pnpm format:check` — exits 0
- [ ] Automated end-to-end sign-in completes in BOTH ceremony modes against a real WorkOS test instance, each as its own passing test — check: `pnpm test:e2e` (Playwright + Electron; a passing test for system-browser AND window) — exits 0
- [ ] The in-repo example app typechecks against the SDK's BUILT public API — check: `pnpm --filter ./example build` — exits 0, example resolving `@workos/authkit-electron` from built `dist`, after the SDK is built first

## Scope Boundaries

### In Scope (MVP + Full)

- Public-client config: `createAuthKit({ clientId, redirectUri, cookiePassword })` constructs `createWorkOS({ clientId })` (no API key) and injects it into `authkit-session`'s `AuthKitCore`/`AuthOperations`
- Main-process session manager on the injected core: `getUser`/`getAccessToken`/`refresh` + `cleanup()`, with multi-window broadcast of auth changes
- Cross-platform deep-link capture: `registerProtocol()` + the open-url / second-instance / dev-argv matrix
- system-browser ceremony mode (default): `createAuthorization` → persist `sealedState` main-side → `shell.openExternal`; callback re-orchestrated outside `AuthService`
- preload `exposeAuthKit()` bridge with SDK-owned channel names
- `/react`: `AuthKitProvider` + `useAuth()` + `useAccessToken()`
- safeStorage-backed session persistence (refresh token confined to main) + per-install ≥32-char `cookiePassword` in the keychain
- `User`/claims types surfaced from `@workos-inc/node`
- window ceremony mode (in-app `BrowserWindow`) with navigation-intercept callback capture
- Guard components `<SignedIn>` / `<SignedOut>`
- `switchToOrganization()` via `AuthOperations`
- In-repo `example/` app evolved from `electron-authkit-example`
- Automated Playwright + Electron e2e covering both ceremony modes

### Out of Scope

- Native passkeys / WebAuthn module — AuthKit handles passkeys on its hosted page at a real https origin in both ceremony modes; no native module is needed (verified against WorkOS docs)
- Non-React renderer bindings (vanilla, Vue, Svelte) — main and preload are framework-agnostic, so bindings can follow later with no rework
- CJS output (dual ESM+CJS build) — `authkit-session` and the sibling SDKs are ESM-only; modern Electron supports ESM and the example bundles via electron-vite; CJS would require bundling an ESM-only dependency
- Admin Portal, Directory Sync, and org-management UI — not session/authentication concerns
- Auto-update, packaging, and code-signing helpers — general Electron concerns outside authentication

### Future Considerations

- Pluggable Electron storage adapter interface (swap electron-store for keytar or a custom backend) — distinct from authkit-session's cookie/HTTP-shaped `SessionStorage` seam
- `@workos/emulate` as the deterministic e2e backend
- Vanilla and Vue/Svelte renderer bindings
- Dual ESM+CJS output if a consumer needs it
- Documented window-mode Touch ID setup (Electron ≥ 42 + `app.configureWebAuthn`)

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Phase 1: Core session engine
  └── Phase 2: Ceremony, deep-link & IPC      (blocked by Phase 1)
        ├── Phase 3: React bindings            (blocked by Phase 2)
        └── Phase 4: In-app window ceremony    (blocked by Phase 2)
              └── Phase 5: Example app + e2e   (blocked by Phase 3 AND Phase 4)
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs the independent phases (3 & 4) in parallel, and gates on failure:

```bash
/ideation:autopilot docs/ideation/authkit-electron/contract.md
```

**Or run phases manually** in dependency order:

**Strategy**: Hybrid (sequential chain Phase 1 → Phase 2; parallel group Phase 3 + Phase 4; converge at Phase 5)

1. **Phase 1** — Core session engine _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/authkit-electron/spec-phase-1.md
   ```

2. **Phase 2** — Ceremony, deep-link & IPC _(blocked by Phase 1)_

   ```bash
   /ideation:execute-spec docs/ideation/authkit-electron/spec-phase-2.md
   ```

3. **Phases 3 & 4** — parallel after Phase 2 (see agent team prompt below, or run sequentially)

   ```bash
   /ideation:execute-spec docs/ideation/authkit-electron/spec-phase-3.md
   /ideation:execute-spec docs/ideation/authkit-electron/spec-phase-4.md
   ```

4. **Phase 5** — Example app + automated e2e _(blocked by Phases 3 and 4)_

   ```bash
   /ideation:execute-spec docs/ideation/authkit-electron/spec-phase-5.md
   ```

### Agent Team Prompt

```
Phase 3 (React bindings) and Phase 4 (In-app window ceremony mode) are independent and can run in parallel once Phase 2 (Ceremony, deep-link & IPC) is complete - both depend only on Phase 2. Spawn one teammate per phase: teammate A runs docs/ideation/authkit-electron/spec-phase-3.md (touches src/react/* and src/shared), teammate B runs docs/ideation/authkit-electron/spec-phase-4.md (touches src/main/ceremony/* and src/main/deep-link.ts). Coordinate on shared files (package.json) - only one teammate edits it at a time. Each must pass `pnpm vitest run --coverage` before converging on Phase 5 (Example app + automated e2e).
```

---

_This contract was generated from brain dump input via the ideation interview. Approved at Full scope on 2026-06-24._
