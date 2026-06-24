# Electron + WorkOS AuthKit (example)

An example Electron app that authenticates with WorkOS AuthKit using
[`@workos/authkit-electron`](../). It is the in-repo consumer of the SDK: it
resolves `@workos/authkit-electron` from the built `dist` via a `workspace:*`
dependency, so a broken public type fails this app's build.

## What this demonstrates

The entire integration is **three calls**, one per Electron process context —
replacing the ~5 hand-wired files this example used to ship (a main-process
`auth/` module, a duplicated preload channel map, and a renderer `useAuth`
hook):

| Context  | Call                                          | File                                    |
| -------- | --------------------------------------------- | --------------------------------------- |
| Main     | `createAuthKit({...})` + `registerProtocol()` | `src/main/index.ts`                     |
| Preload  | `exposeAuthKit()`                             | `src/preload/index.ts`                  |
| Renderer | `<AuthKitProvider>` + `useAuth()`             | `src/renderer/src/main.tsx`, components |

The SDK owns the security-sensitive pieces — PKCE, JWT verification, token
refresh, the cross-platform deep-link capture matrix, `safeStorage`-backed
persistence, and the IPC contract — all delegated to
[`@workos/authkit-session`](https://www.npmjs.com/package/@workos/authkit-session).
The refresh token stays in the main process and never crosses IPC.

## Quick start

From the repository root, build the SDK first (the example resolves its built
output):

```bash
pnpm install
pnpm build                       # build the SDK
```

Create `example/.env`:

```bash
MAIN_VITE_WORKOS_CLIENT_ID=client_xxx
```

Add `workos-auth://callback` as a redirect URI in your
[WorkOS Dashboard](https://dashboard.workos.com), then run:

```bash
pnpm --filter ./example dev
```

### Switching ceremony mode

The app reads the sign-in ceremony from an env var so you can try both:

```bash
AUTHKIT_CEREMONY=system-browser pnpm --filter ./example dev   # default: OS browser + deep link
AUTHKIT_CEREMONY=window         pnpm --filter ./example dev   # in-app BrowserWindow
```

## Key files

| File                            | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `src/main/index.ts`             | `createAuthKit({ clientId, redirectUri, ceremony })` + `registerProtocol()` |
| `src/preload/index.ts`          | `exposeAuthKit()` — mounts the typed bridge on `window.__authkit_electron`  |
| `src/renderer/src/main.tsx`     | Wraps the app in `<AuthKitProvider>`                                        |
| `src/renderer/src/components/*` | Consume `useAuth()` (`user`, `isLoading`, `signIn`, `signOut`)              |

## Build

```bash
pnpm --filter ./example build      # typecheck + electron-vite build
pnpm --filter ./example build:mac  # package for macOS (electron-builder)
pnpm --filter ./example build:win  # Windows
pnpm --filter ./example build:linux
```

The packaged build registers the `workos-auth://` URL scheme (see the
`protocols:` block in `electron-builder.yml`) so deep links resolve.

## Learn more

- [`@workos/authkit-electron`](../) — the SDK this app consumes
- [WorkOS AuthKit Docs](https://workos.com/docs/user-management)
