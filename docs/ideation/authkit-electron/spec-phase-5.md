# Implementation Spec: @workos/authkit-electron - Phase 5 (Example app + automated e2e)

**Contract**: ./contract.md
**Estimated Effort**: M/L

## Technical Approach

Phase 5 proves the SDK in a real app and locks in the success criteria. It seeds `example/` from `electron-authkit-example`, **deletes** that app's hand-wired `src/main/auth/` and renderer `useAuth.ts`, and rewires it to consume the published SDK (`createAuthKit` / `exposeAuthKit` / `<AuthKitProvider>` + hooks). The example resolves `@workos/authkit-electron` from its **built `dist`** (workspace dependency), so a broken public type fails the example's build — that is success criterion 8.

Automated e2e uses Playwright's Electron support: launch the built example, drive a sign-in for **each** ceremony mode against a real WorkOS test instance, and assert an authenticated user reaches the renderer. Each mode is its own test so dropping one fails the gate (success criterion 7). The WorkOS test backend is real now; the suite is structured so it can later point at `@workos/emulate` by swapping a base URL/fixture.

CI wires the full gate: `vitest --coverage`, the crypto-delegation grep guard, `publint` + `attw`, `tsc`, lint/format, the example build, and `test:e2e`.

**Pattern to follow**: `electron-authkit-example` for the app shell + `electron-builder.yml`; `authkit-tanstack-start`'s `example/` for the in-repo example layout and `tests/` for Playwright conventions.

## Feedback Strategy

**Inner-loop command**: `pnpm --filter ./example dev` (visual) + `pnpm test:e2e --grep system-browser` (scoped e2e)

**Playground**: The example app dev server for wiring, and the Playwright+Electron suite for the end-to-end gate.

**Why this approach**: This phase is integration; the only meaningful feedback is the app running and the e2e suite going green. Scope the e2e by `--grep` during development so each run is one mode, not both.

## File Changes

### New Files

| File Path | Purpose |
|---|---|
| `example/` (seeded) | Electron app consuming the SDK (from `electron-authkit-example`, rewired) |
| `example/src/main/index.ts` | Calls `createAuthKit({...})` + `registerProtocol()`; deletes the old `auth/` wiring |
| `example/src/preload/index.ts` | Calls `exposeAuthKit()` |
| `example/src/renderer/src/App.tsx` | Uses `<AuthKitProvider>` + `useAuth`/`useAccessToken` + guards |
| `example/electron-builder.yml` | Adds the custom-protocol registration (`protocols:`) |
| `tests/e2e/sign-in.system-browser.spec.ts` | Playwright+Electron: full sign-in, system-browser mode |
| `tests/e2e/sign-in.window.spec.ts` | Playwright+Electron: full sign-in, window mode |
| `tests/e2e/helpers.ts` | Launch built app, drive AuthKit hosted page, assert authed user |
| `.github/workflows/ci.yml` | Lint, format:check, vitest --coverage, grep guard, publint, attw, build, test:e2e |
| `playwright.config.ts` | Electron project config |

### Deleted Files (within the seeded example)

| File Path | Reason |
|---|---|
| `example/src/main/auth/*` | Replaced by the SDK (`createAuthKit`) |
| `example/src/renderer/src/hooks/useAuth.ts` | Replaced by `@workos/authkit-electron/react` |

## Implementation Details

### Example rewire

**Overview**: The diff that demonstrates the SDK's value — ~5 hand-wired files become 3 calls.

**Implementation steps**:
1. Copy `electron-authkit-example` into `example/`; add `@workos/authkit-electron` as a `workspace:*` dependency resolving to the built package.
2. Replace `src/main/auth/*` usage with `const authkit = createAuthKit({ clientId, redirectUri, ceremony })` + `authkit.registerProtocol()` in `whenReady`.
3. Replace preload body with `exposeAuthKit()`.
4. Wrap the renderer in `<AuthKitProvider>`; swap the local `useAuth` for the SDK hook; render guards.
5. Bump `@workos-inc/node` off `8.0.0-rc.10` to match the SDK's `^10.4.0` peer.

**Feedback loop**:
- **Playground**: `pnpm --filter ./example dev`.
- **Experiment**: sign in (system-browser), see user; sign out; toggle `ceremony.mode: 'window'`, sign in again; open a second window and confirm the broadcast updates it.
- **Check command**: `pnpm --filter ./example build` (typechecks against the built SDK)

### Playwright + Electron e2e

**Overview**: Launch the built app, automate the AuthKit hosted page, assert the authenticated user.

**Implementation steps**:
1. `_electron.launch({ args: [exampleMain] })`; get the first window.
2. Trigger sign-in; for system-browser mode, capture the auth URL and drive the hosted page (test credentials) → deep link returns; for window mode, drive the child window directly.
3. Assert the renderer shows the authenticated user (and `refreshToken` is absent from anything the renderer can read).

**Feedback loop**:
- **Playground**: the Playwright suite.
- **Experiment**: per mode — successful sign-in shows user; sign-out returns to signed-out; (optional) cancelled window-mode flow stays signed-out.
- **Check command**: `pnpm test:e2e --grep system-browser` (then `--grep window`)

## Testing Requirements

### E2E Tests
| Test File | Coverage |
|---|---|
| `tests/e2e/sign-in.system-browser.spec.ts` | Full sign-in via system browser + deep link |
| `tests/e2e/sign-in.window.spec.ts` | Full sign-in via in-app window |

### Manual Testing
- [ ] Package the example (`electron-builder`) and confirm the protocol is OS-registered and deep links resolve in the packaged build.

## Error Handling

| Error Scenario | Handling Strategy |
|---|---|
| e2e flake on hosted page | Retry once; pin selectors; treat persistent failure as a real gate failure, not a skip |
| Missing test credentials in CI | Fail fast with a clear message; document the required secrets |
| Example out of sync with SDK API | The `dist`-resolved build fails on a broken public type |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| e2e | Real-instance flakiness | Hosted page latency/changes | Red CI not caused by our code | Retry-once + tight selectors; planned move to `@workos/emulate` |
| Example | Resolves SDK `src` not `dist` | Path alias leaks in | Broken public types not caught | Depend on `workspace:*` built output; build SDK before example |
| CI | Coverage threshold gaming | Tests assert little | False confidence | Threshold + the crypto-delegation grep guard + payload-shape assertions |

## Validation Commands

```bash
# Full gate (mirrors CI)
pnpm lint && pnpm format:check
pnpm vitest run --coverage
grep -rnE 'jose|iron-webcrypto|jwtVerify|createRemoteJWKSet|generateCodeChallenge' src/   # expect only authkit-session imports
pnpm publint && pnpm attw --pack --profile esm-only
pnpm build
pnpm --filter ./example build
pnpm test:e2e
```

## Open Items

- [ ] Decide CI secret management for the WorkOS test instance (and the AuthKit custom domain needed for passkeys, if exercised).
- [ ] Confirm Playwright's Electron support drives the system-browser hop, or whether that mode's e2e stubs the external browser.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
