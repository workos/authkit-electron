# AuthKit Electron Library

The AuthKit library for Electron provides convenient helpers for authentication and session management using WorkOS & AuthKit in Electron desktop apps. It collapses the OAuth and session lifecycle — normally hand-wired across Electron's three isolated process contexts — into **one call per context**, built on [`@workos/authkit-session`](https://www.npmjs.com/package/@workos/authkit-session).

> [!NOTE]
> This library treats your desktop app as a **public OAuth client**: you configure it with a `clientId` only — **no API key is shipped in your binary**. The refresh token is confined to the main process and never crosses IPC to the renderer.

## How it works

The entire integration is **three calls**, one per Electron process context:

| Context      | Call                                          | Entry point                        |
| ------------ | --------------------------------------------- | ---------------------------------- |
| **Main**     | `createAuthKit({...})` + `registerProtocol()` | `@workos/authkit-electron`         |
| **Preload**  | `exposeAuthKit()`                             | `@workos/authkit-electron/preload` |
| **Renderer** | `<AuthKitProvider>` + `useAuth()`             | `@workos/authkit-electron/react`   |

The SDK owns the security-sensitive pieces — PKCE, JWT verification, token refresh, the cross-platform deep-link capture matrix, `safeStorage`-backed persistence, and the IPC contract — and delegates the cryptography to `@workos/authkit-session`.

## Requirements

- **Electron** ≥ 30 (ESM main process; modern Electron supports ESM natively)
- **Node** ≥ 20
- **ESM only.** This package ships ES modules with no CommonJS build, matching the `authkit-session` lineage. Bundle your Electron app with a tool that supports ESM (the in-repo example uses [electron-vite](https://electron-vite.org/)).
- A **React** renderer for the `/react` bindings (main and preload are framework-agnostic).

## Installation

```sh
pnpm add @workos/authkit-electron @workos-inc/node
```

or

```sh
npm install @workos/authkit-electron @workos-inc/node
```

`@workos-inc/node` is a peer dependency (`^10.4.0`). If you use the `/react` bindings, `react` and `react-dom` (`^18` or `^19`) are also peers.

### Subpath exports

The package ships five entry points that version in lockstep:

| Import                               | Process  | Provides                                                                                                  |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `@workos/authkit-electron`           | Main     | `createAuthKit`, default storage, shared types                                                            |
| `@workos/authkit-electron/preload`   | Preload  | `exposeAuthKit`, the typed bridge contract                                                                |
| `@workos/authkit-electron/react`     | Renderer | `AuthKitProvider`, `useAuth`, `useAccessToken`, `SignedIn/SignedOut`                                      |
| `@workos/authkit-electron/globals`   | Renderer | Types only: opt-in `Window` typing for the bridge (see [Renderer without React](#renderer-without-react)) |
| `@workos/authkit-electron/internals` | Main     | Building blocks for advanced composition (see [Building blocks](#building-blocks))                        |

## Pre-flight

In the [WorkOS dashboard](https://dashboard.workos.com):

1. Copy your **Client ID** (`client_...`). You do **not** need an API key — this is a public client.
2. Under **Redirects**, add a **custom-protocol redirect URI** for your app, e.g.:

   ```
   workos-auth://callback
   ```

   Desktop apps capture the OAuth callback through a custom URL scheme (not an `http://` URL), so the redirect URI must be a `scheme://path` value. The SDK derives the protocol scheme from it automatically.

3. Still under **Redirects**, set a default **Logout URI**. `signOut` ends the hosted AuthKit session by navigating to the WorkOS logout URL, which then lands on this URI.

> [!NOTE]
> Unlike the web SDKs, this library reads its configuration from the `createAuthKit({...})` **argument**, not from environment variables. How you source your `clientId` (env var, build-time inlining, hardcoded) is up to your app. The in-repo [`example/`](./example) sources it from `MAIN_VITE_WORKOS_CLIENT_ID`.

### The cookie password

The SDK seals the in-flight PKCE state with a `cookiePassword` (≥ 32 characters). **You do not need to provide one** — on first run a per-install secret is generated and stored in the OS keychain via `safeStorage`. Pass `cookiePassword` explicitly only if you need a fixed, shared value (it must be ≥ 32 characters):

```ts
createAuthKit({ clientId, redirectUri, cookiePassword: process.env.MY_SECRET });
```

## Setup

### 1. Main process

Call `createAuthKit()` once to assemble the auth runtime, then call `registerProtocol()` inside `app.whenReady()`.

```ts
import { app } from 'electron';
import { createAuthKit } from '@workos/authkit-electron';

// Safe to construct at module top level — createAuthKit() does no OS-keychain
// work until the first sign-in, so it does not require app.whenReady().
const authkit = createAuthKit({
  clientId: process.env.WORKOS_CLIENT_ID!,
  redirectUri: 'workos-auth://callback',
});

app.whenReady().then(() => {
  // Registers the custom protocol + wires the cross-platform deep-link capture.
  // Must run inside whenReady (before your first window) so a callback URL that
  // arrives at cold start is still handled.
  authkit.registerProtocol();

  // ... create your BrowserWindow(s)
});

app.on('will-quit', () => {
  // Remove IPC handlers + deep-link listeners on shutdown.
  authkit.cleanup();
});
```

`createAuthKit(config, options?)` returns:

| Method               | When to call                  | Description                                                                                    |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `registerProtocol()` | Inside `app.whenReady()`      | Registers the app as the OS handler for the redirect-URI scheme and wires the deep-link matrix |
| `cleanup()`          | On app shutdown (`will-quit`) | Removes the IPC handlers and deep-link listeners                                               |

> [!IMPORTANT]
> The **single-instance lock** is your responsibility, because it must run before your first window so the `second-instance` deep-link branch (Windows/Linux) can fire. Call `app.requestSingleInstanceLock()` early in your main entry:
>
> ```ts
> if (!app.requestSingleInstanceLock()) {
>   app.quit();
> }
> ```

### 2. Preload script

Call `exposeAuthKit()` once. It mounts a typed, `contextBridge`-isolated API on `window.__authkit_electron` using the SDK-owned IPC channel names — you never declare channel names yourself.

```ts
import { exposeAuthKit } from '@workos/authkit-electron/preload';

exposeAuthKit();
```

Point your `BrowserWindow` at this preload script:

```ts
new BrowserWindow({
  webPreferences: {
    preload: join(__dirname, '../preload/index.mjs'),
    // contextIsolation is on by default and is the supported mode.
  },
});
```

### 3. Renderer (React)

Wrap your app in `<AuthKitProvider>` and consume `useAuth()`.

```tsx
import { AuthKitProvider, useAuth } from '@workos/authkit-electron/react';

function Root() {
  return (
    <AuthKitProvider>
      <App />
    </AuthKitProvider>
  );
}

function App() {
  const { user, isLoading, signIn, signOut } = useAuth();

  if (isLoading) return <div>Loading…</div>;

  return user ? (
    <div>
      <p>Welcome back, {user.firstName}</p>
      <button onClick={() => signOut()}>Sign out</button>
    </div>
  ) : (
    <button onClick={() => signIn()}>Sign in</button>
  );
}
```

> [!IMPORTANT]
> `AuthKitProvider` reads `window.__authkit_electron`. If `exposeAuthKit()` was not called in the preload script (or the window has no preload), the hooks throw an actionable error. See [Troubleshooting](#troubleshooting).

### Renderer without React

The `/react` bindings are optional — main and preload are framework-agnostic, and the preload bridge **is** the public renderer API. Once `exposeAuthKit()` has run in your preload script, any renderer (vanilla TS, Vue, Svelte, …) drives auth through `window.__authkit_electron`.

For typed access, opt into the ambient `Window` augmentation from any `.d.ts` in your renderer source (electron-vite scaffolds already have an `env.d.ts` for exactly this):

```ts
/// <reference types="@workos/authkit-electron/globals" />
```

(Equivalent: add `"@workos/authkit-electron/globals"` to `compilerOptions.types` in your renderer tsconfig.)

The typing marks the bridge **optional** because it is genuinely absent when the preload didn't run — the same misconfiguration the React hooks throw for. Guard once and reuse:

```ts
// renderer/authkit.ts
import type { AuthKitBridge } from '@workos/authkit-electron/preload';

export function authkit(): AuthKitBridge {
  const bridge = window.__authkit_electron;
  if (!bridge) {
    throw new Error('[authkit-electron] bridge missing — did the preload call exposeAuthKit()?');
  }
  return bridge;
}
```

(The `import type` is erased at compile time — no preload code is bundled into your renderer.)

```ts
// renderer/main.ts
import { authkit } from './authkit';

const bridge = authkit(); // the guard runs once, at startup

const status = document.getElementById('status')!;

function render(user: { email: string } | null): void {
  status.textContent = user ? `Signed in as ${user.email}` : 'Signed out';
}

async function init(): Promise<void> {
  // Every renderer→main call resolves to an IpcResult<T> — branch on `ok`
  // rather than try/catch, and read the stable `error.code` on failure.
  const result = await bridge.getUser();
  if (!result.ok) {
    status.textContent = `Auth error: ${result.error.code}`;
    return;
  }
  render(result.data.user);
}
void init();

// Stay in sync: sign-in, sign-out, and org switches in ANY window arrive here.
// (onAuthChange returns an unsubscribe function — keep it if this UI can be torn down.)
bridge.onAuthChange((payload) => render(payload.user));

document.getElementById('sign-in')!.addEventListener('click', () => void bridge.signIn());
document.getElementById('sign-out')!.addEventListener('click', () => void bridge.signOut());
```

`onAuthChange` delivers the same `RendererAuthPayload` the React hooks consume (`user`, `organizationId`, `role`, `permissions`, `claims`, …), so everything in [`useAuth()`](#useauth) maps 1:1 onto bridge calls. To build richer bindings (a Vue composable, a Svelte store), wrap the same six bridge methods — that is all `AuthKitProvider` does.

### Packaged apps: register the protocol with your bundler

`registerProtocol()` registers the custom scheme at **runtime**. For packaged builds, the OS also needs the scheme declared in your build config so deep links resolve when the app is launched cold. With `electron-builder`:

```yaml
# electron-builder.yml
protocols:
  - name: WorkOS AuthKit
    schemes:
      - workos-auth
```

## Configuration

`createAuthKit(config, options?)` accepts the following `config` (`AuthKitElectronConfig`):

| Option           | Type                                      | Default                      | Description                                                                                            |
| ---------------- | ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `clientId`       | `string`                                  | **required**                 | Your WorkOS Client ID (`client_...`). Validated at construction — a missing/blank value throws.        |
| `redirectUri`    | `string`                                  | **required**                 | Custom-protocol redirect URI, e.g. `workos-auth://callback`. The scheme is derived from this.          |
| `cookiePassword` | `string`                                  | per-install generated secret | Override the ≥ 32-char secret that seals in-flight PKCE state. Omit to auto-generate + keychain-store. |
| `ceremony`       | `{ mode?: 'system-browser' \| 'window' }` | `{ mode: 'system-browser' }` | How the user is taken to AuthKit. See [Sign-in ceremonies](#sign-in-ceremonies).                       |
| `storage`        | `TokenStorage`                            | bundled `electron-store`     | A custom persistence adapter. See [Custom storage](#custom-storage-adapter).                           |

The optional second argument (`CreateAuthKitOptions`) is primarily for testing (inject a fake `client`, `ipcMain`, `app`, etc.), with one consumer-facing option:

| Option             | Type         | Description                                                                                                       |
| ------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `onSecondInstance` | `() => void` | Called when a second app instance forwards a deep link (Windows/Linux). Use it to focus/restore your main window. |

## Sign-in ceremonies

A "ceremony" is how the user is taken to AuthKit to authenticate. Two modes are supported:

### `system-browser` (default)

Opens the user's **default OS browser** (`shell.openExternal`) and returns to your app through the custom-protocol deep link.

- ✅ Most secure; uses the user's real browser session and password manager.
- ℹ️ On return, the OS shows a "**\<your-domain> wants to open \<YourApp>**" confirmation dialog. **This is expected** — it is the OS handing the `workos-auth://` callback back to your app. Users can check "Always open" to suppress it.
- ℹ️ On `signOut`, the browser opens again briefly — the hosted AuthKit session's cookie lives there, so ending it means sending the browser to the logout URL (it lands on your configured **Logout URI**).

### `window`

Opens a child `BrowserWindow` pointed at the hosted AuthKit page and captures the callback by intercepting in-app navigation — the user never leaves your app, and there is no OS handoff dialog.

```ts
createAuthKit({
  clientId,
  redirectUri: 'workos-auth://callback',
  ceremony: { mode: 'window' },
});
```

Because the hosted AuthKit page loads at a real `https://` origin inside the window, WebAuthn/passkeys work without any native module. Sign-out is invisible in this mode: the logout URL is loaded in a hidden window (the hosted session's cookie lives in the app's Electron session, not the OS browser).

> [!NOTE]
> Touch ID inside a `BrowserWindow` (window mode) requires Electron ≥ 42 plus `app.configureWebAuthn`. In `system-browser` mode this is a non-issue.

Either way, sign-in is triggered from the renderer with `signIn()`, and the cross-platform deep-link capture matrix (`open-url` on macOS, `second-instance` on Windows/Linux, the dev-mode `argv` branch) is wired by `registerProtocol()`.

## Usage

### `useAuth()`

The primary renderer hook. Returns the renderer-safe auth state and the actions. Field names mirror the web SDK `@workos/authkit-react`, plus Electron-specific extras (`sessionId`, `entitlements`, `claims`).

```tsx
'use client';
import { useAuth } from '@workos/authkit-electron/react';

function Profile() {
  const { user, isLoading, organizationId, role } = useAuth();

  if (isLoading) return <div>Loading…</div>;
  if (!user) return <div>Not signed in</div>;

  return (
    <div>
      {user.email} — {role} @ {organizationId}
    </div>
  );
}
```

| Property               | Type                                              | Description                                                                                                     |
| ---------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `user`                 | `User \| null`                                    | The signed-in user, or `null` when signed out                                                                   |
| `isLoading`            | `boolean`                                         | `true` until the first `getUser()` resolves                                                                     |
| `sessionId`            | `string \| undefined`                             | Session ID (signed in only)                                                                                     |
| `organizationId`       | `string \| undefined`                             | Active organization (signed in only)                                                                            |
| `role` / `roles`       | `string` / `string[] \| undefined`                | Role claim(s)                                                                                                   |
| `permissions`          | `string[] \| undefined`                           | Permission claims                                                                                               |
| `entitlements`         | `string[] \| undefined`                           | Entitlement claims                                                                                              |
| `featureFlags`         | `string[] \| undefined`                           | Feature-flag claims                                                                                             |
| `impersonator`         | `Impersonator \| undefined`                       | Present when the session is being impersonated                                                                  |
| `claims`               | `AuthKitClaims \| undefined`                      | The full decoded access-token claims                                                                            |
| `error`                | `AuthErrorPayload \| null`                        | The last sign-in failure (denied/cancelled/exchange error), else `null`; cleared on the next successful sign-in |
| `signIn`               | `(opts?: SignInOptions) => Promise<void>`         | Begin a sign-in ceremony                                                                                        |
| `signOut`              | `(opts?: { returnTo?: string }) => Promise<void>` | Clear the local session AND end the hosted AuthKit session                                                      |
| `switchToOrganization` | `(organizationId: string) => Promise<void>`       | Force-refresh into a different organization                                                                     |
| `getAccessToken`       | `() => Promise<string \| null>`                   | The current short-lived access token, or `null` when signed out                                                 |

`signIn` accepts `SignInOptions`:

```ts
signIn({ screenHint: 'sign-up' }); // open the sign-up screen
signIn({ organizationId: 'org_123' }); // scope the sign-in to an org
```

> [!NOTE]
> The main process is the single source of truth. Auth changes (sign-in, sign-out, org switch) **broadcast to every window**, so signing out in one window updates all of them.

> [!TIP]
> When a sign-in is denied, cancelled, or the code exchange fails, the callback completes with no auth change. Rather than leaving the user silently signed out, the main process broadcasts a safe `{ code, message }` error (never tokens) that surfaces as `useAuth().error`:
>
> ```tsx
> const { error, signIn } = useAuth();
> // ...
> {
>   error && <p role="alert">Sign-in failed: {error.message}</p>;
> }
> ```
>
> `error` is cleared automatically on the next successful sign-in.

### Guards: `<SignedIn>` / `<SignedOut>`

Declarative guards, modeled on `@clerk/clerk-react`. Neither renders its children until the initial `getUser()` has resolved (no flash of the wrong state).

```tsx
import { SignedIn, SignedOut } from '@workos/authkit-electron/react';

function Nav() {
  return (
    <>
      <SignedIn>
        <UserMenu />
      </SignedIn>
      <SignedOut>
        <SignInButton />
      </SignedOut>
    </>
  );
}
```

### `useAccessToken()`

For calling your own backend, use `useAccessToken()` to fetch and cache the short-lived access token. It re-fetches on every auth change and exposes a manual `refresh()`. The token is the renderer-safe **access** token only — the refresh token never crosses IPC.

```tsx
import { useAccessToken } from '@workos/authkit-electron/react';

function ApiButton() {
  const { accessToken, isLoading, error, refresh } = useAccessToken();

  if (isLoading) return <div>Loading…</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!accessToken) return <div>Not authenticated</div>;

  async function callApi() {
    await fetch('https://api.example.com/data', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  return <button onClick={callApi}>Call API</button>;
}
```

| Property      | Type                            | Description                                                  |
| ------------- | ------------------------------- | ------------------------------------------------------------ |
| `accessToken` | `string \| null`                | The current access token, or `null` when signed out          |
| `isLoading`   | `boolean`                       | `true` while a fetch is in flight (matches `useAuth`)        |
| `error`       | `Error \| null`                 | The last fetch error, or `null`                              |
| `refresh`     | `() => Promise<string \| null>` | Re-fetch the token (triggers main-side validate-and-refresh) |

Calling `refresh()` (or `getAccessToken()` from `useAuth`) triggers the main process to validate the session and silently refresh the tokens if the access token has expired.

> [!TIP]
> Treat the access token as a sensitive credential. Use it where needed (e.g. an `Authorization` header), and avoid persisting it in renderer storage like `localStorage`.

### Switching organizations

For multi-tenant apps, switch the active organization and re-issue an org-scoped session:

```tsx
const { switchToOrganization } = useAuth();

await switchToOrganization('org_123');
// The new organizationId/claims arrive via the broadcast; the provider updates.
```

## Security

Security is the reason this library exists — it removes the error-prone, security-sensitive boilerplate from your app code.

- **Refresh token confinement.** The refresh token lives only in the main process. Every renderer-facing payload is built by a single chokepoint (`toRendererAuthPayload`) that strips it by **allowlist** — a new field can only reach the renderer if it is added on purpose. No IPC channel returns the refresh token.
- **At-rest encryption.** The session is persisted with Electron's `safeStorage` (OS keychain), not a hardcoded key. If `safeStorage` is unavailable (e.g. Linux with no keyring), the SDK **refuses to persist** and throws `EncryptionUnavailableError` rather than writing secrets in plaintext.
- **No static secret in the binary.** The PKCE-sealing `cookiePassword` is a ≥ 32-char per-install secret generated on first run and kept in the keychain.
- **PKCE + sealed CSRF state.** Sign-in uses PKCE with a sealed (encrypted) `state`. The sealed state is persisted main-side (not in a cookie), then verified on callback with a constant-time compare + unseal. The pending verifier is **single-use** with a 10-minute TTL, so a replayed callback cannot reuse a consumed verifier.
- **Complete sign-out.** `signOut` clears the local session immediately, then ends the **hosted** AuthKit session by delivering the WorkOS logout URL where that session's cookie lives (the OS browser, or a hidden window in window mode) — so the next sign-in cannot silently reuse a stale hosted session. The remote step is best-effort and never blocks local sign-out.
- **All crypto is delegated.** PKCE, JWT verification, and token refresh come from `@workos/authkit-session`; this library re-implements none of it.

> [!WARNING]
> `createDefaultStorage({ allowPlaintext: true })` exists for development on machines without a keyring. It stores session data **unencrypted** and should never be enabled in a distributed build.

## Advanced

### Custom storage adapter

Provide your own `TokenStorage` implementation to swap the bundled `electron-store` + `safeStorage` backend (e.g. for a custom keychain integration):

```ts
import { createAuthKit, type TokenStorage } from '@workos/authkit-electron';

const storage: TokenStorage = {
  getSession() {
    /* ... */
  },
  setSession(session) {
    /* ... */
  },
  clearSession() {
    /* ... */
  },
  getOrCreateCookiePassword() {
    /* return a stable ≥32-char secret */
  },
  setPendingVerifier(key, value) {
    /* ... */
  },
  takePendingVerifier(key) {
    /* single-use read+remove */
  },
};

createAuthKit({ clientId, redirectUri: 'workos-auth://callback', storage });
```

### Building blocks

For advanced composition (or to build non-React renderer bindings), the lower-level pieces are exported from `@workos/authkit-electron/internals`: `createSessionManager`, `createCeremony`, the deep-link primitives (`registerProtocol`, `wireDeepLinks`, `parseCallback`), the IPC layer (`registerIpcHandlers`, `broadcastAuthChange`), the `IPC_CHANNELS` map, and `createPublicWorkOS` (a WorkOS client built from a `clientId` with no API key). `createAuthKit()` wires these together for you, so reach for `/internals` only when you need a piece directly. (`createDefaultStorage` remains on the root entry.)

### Types

The package surfaces WorkOS's own types directly so you never redeclare them — `User` and `Impersonator` come from `@workos-inc/node`, and `AuthResult`, `Session`, `BaseTokenClaims`, and `CustomClaims` from `@workos/authkit-session`. The renderer-safe payload is `RendererAuthPayload`, and `AuthKitClaims<TCustomClaims>` lets you type custom claims.

The bridge contract (`AuthKitBridge`, `IpcResult`, `SignInOptions`) is exported from `/preload`.

## Troubleshooting

#### `createAuthKit` throws `clientId is required` at startup

The value you passed for `clientId` was `undefined` or blank — almost always a missing or misnamed environment variable (e.g. an unprefixed var that your bundler doesn't expose to the main process). Failing at construction is deliberate: the alternative is a broken authorization URL at first sign-in.

#### `window.__authkit_electron is missing`

The renderer can't see the preload bridge. Ensure `exposeAuthKit()` is called in your preload script **and** your `BrowserWindow`'s `webPreferences.preload` points at that script. The hooks throw this error with the same guidance.

#### `EncryptionUnavailableError: OS encryption (safeStorage) is unavailable`

`safeStorage` cannot encrypt. The common causes:

- **Linux without a keyring** (e.g. headless/CI). Install/start a keyring (libsecret/gnome-keyring), or for development only, opt into plaintext: `createAuthKit({ ..., storage: createDefaultStorage({ allowPlaintext: true }) })`.
- **Called before the app is ready.** `safeStorage` is only available after `app.whenReady()`. `createAuthKit()` itself is safe to call at module top level (it defers the keychain read), but if you build a custom `TokenStorage` that touches `safeStorage` eagerly, do it after `ready`.

#### The OS shows "&lt;domain&gt; wants to open &lt;YourApp&gt;" on sign-in

This is **expected** in `system-browser` mode — the OS is handing the `workos-auth://` callback from your external browser back to your app. Users can check "Always open" to skip it next time. If you'd rather keep the entire flow in-app with no OS dialog, use `ceremony: { mode: 'window' }`.

#### Deep link never returns to a packaged app

The custom protocol isn't registered with the OS for the packaged build. Add the `protocols:` block to your `electron-builder` config (see [Packaged apps](#packaged-apps-register-the-protocol-with-your-bundler)). `registerProtocol()` only covers the running app.

## Example

A complete, runnable Electron app consuming this SDK lives in [`example/`](./example) — it demonstrates all three contexts and both ceremony modes. See its [README](./example/README.md) to run it.

## Learn more

- [WorkOS AuthKit docs](https://workos.com/docs/user-management)
- [`@workos/authkit-session`](https://www.npmjs.com/package/@workos/authkit-session) — the framework-agnostic core this library builds on
