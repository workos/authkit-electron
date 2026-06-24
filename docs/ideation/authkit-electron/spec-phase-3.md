# Implementation Spec: @workos/authkit-electron - Phase 3 (React bindings)

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 3 is the renderer surface: `@workos/authkit-electron/react`. It is a thin, framework-idiomatic wrapper over the IPC bridge published by `exposeAuthKit()` (Phase 2) on `window.__authkit_electron`. The renderer holds only renderer-safe state — `user` + claims + the short-lived access token — and **never** the refresh token (enforced upstream in the IPC payload; this layer simply has no channel that returns it).

`AuthKitProvider` calls `getUser()` once on mount, subscribes to `onAuthChange` for push updates from any window, and exposes the result via React context. `useAuth()` reads that context and returns `user`, `loading`, the claims, and the actions (`signIn`, `signOut`, `switchToOrganization`). `useAccessToken()` is a dedicated hook for the common "call my own backend" case — it fetches and caches the token and exposes a `refresh()`. `<SignedIn>`/`<SignedOut>` are declarative guards reading the same context.

Field names mirror the verified `AuthResult` shape from `authkit-session`; **before finalizing, align exact hook field/method names with `@workos/authkit-react`** (the web SDK) so a developer moving between web and desktop sees the same surface. That alignment is the one build-time lookup this phase carries.

**Pattern to follow**: `electron-authkit-example/src/renderer/src/hooks/useAuth.ts` (the subscribe-on-mount shape, minus the locally-redefined `User` type — we import it from `@workos-inc/node`). For guards, `@clerk/clerk-react`'s `<SignedIn>/<SignedOut>`.

## Feedback Strategy

**Inner-loop command**: `pnpm vitest run react`

**Playground**: React Testing Library (jsdom) — render the provider + a consumer with a mocked `window.__authkit_electron`. Fast and deterministic; the visual check happens in the Phase 5 example app.

**Why this approach**: The logic worth testing is context propagation, the on-mount fetch, and the push-update subscription — all RTL-testable without a running Electron app.

## File Changes

### New Files

| File Path | Purpose |
|---|---|
| `src/react/index.tsx` | Public `./react` entry; exports provider, hooks, guards |
| `src/react/auth-kit-provider.tsx` | `AuthKitProvider`: on-mount `getUser`, `onAuthChange` subscription, context |
| `src/react/use-auth.ts` | `useAuth()` → user, loading, claims, actions |
| `src/react/use-access-token.ts` | `useAccessToken()` → `{ accessToken, loading, error, refresh }` |
| `src/react/guards.tsx` | `<SignedIn>` / `<SignedOut>` |
| `src/react/context.ts` | Internal context + a `useBridge()` that reads `window.__authkit_electron` |
| `src/react/__tests__/use-auth.spec.tsx` | Provider + `useAuth` tests |
| `src/react/__tests__/use-access-token.spec.tsx` | Token fetch/refresh tests |
| `src/react/__tests__/guards.spec.tsx` | Guard rendering tests |

### Modified Files

| File Path | Changes |
|---|---|
| `package.json` | Confirm `./react` export + `react`/`react-dom` peers; add `@testing-library/react` dev dep |

## Implementation Details

### AuthKitProvider (`auth-kit-provider.tsx`)

**Pattern to follow**: `electron-authkit-example/src/renderer/src/hooks/useAuth.ts`

```tsx
export function AuthKitProvider({ children }: { children: ReactNode }): JSX.Element {
  const bridge = useBridge(); // window.__authkit_electron; throws a clear error if exposeAuthKit() wasn't called
  const [state, setState] = useState<{ auth: RendererAuth | null; loading: boolean }>({ auth: null, loading: true });
  useEffect(() => {
    bridge.getUser().then(r => setState({ auth: r.ok ? r.data : null, loading: false }));
    return bridge.onAuthChange(auth => setState({ auth, loading: false })); // returns unsubscribe
  }, []);
  // provide state + actions via context
}
```

**Key decisions**:
- One source of truth: the main process. The provider never computes auth itself; it reflects `getUser` + `onAuthChange`.
- `useBridge()` throws a developer-friendly error if `window.__authkit_electron` is missing ("did you call exposeAuthKit() in your preload?").

**Feedback loop**:
- **Playground**: `use-auth.spec.tsx` rendering `<AuthKitProvider>` with a mocked bridge.
- **Experiment**: mount with signed-out bridge (loading→null); mount signed-in (user present); fire `onAuthChange(null)` → consumers re-render signed-out; assert unsubscribe on unmount.
- **Check command**: `pnpm vitest run use-auth`

### useAccessToken (`use-access-token.ts`)

**Overview**: Fetches the access token for calling the consumer's own backend; re-fetches on `onAuthChange`.

**Implementation steps**:
1. On mount + on `onAuthChange`, call `bridge.getAccessToken()`.
2. Expose `{ accessToken, loading, error, refresh }`; `refresh()` re-invokes `getAccessToken()` (which triggers main-side `validateAndRefresh`).

**Feedback loop**:
- **Playground**: `use-access-token.spec.tsx` with a mocked bridge.
- **Experiment**: token present; token null when signed out; `refresh()` returns a rotated token; error surfaces from `{ok:false}`.
- **Check command**: `pnpm vitest run use-access-token`

### Guards (`guards.tsx`)

```tsx
export function SignedIn({ children }: { children: ReactNode }): JSX.Element | null;  // renders when user != null
export function SignedOut({ children }: { children: ReactNode }): JSX.Element | null; // renders when user == null
```
Trivial — no feedback loop beyond the render test.

## Data Model

### Context state
```typescript
interface AuthKitContextValue {
  user: User | null; loading: boolean;
  sessionId?: string; organizationId?: string; role?: string; roles?: string[];
  permissions?: string[]; entitlements?: string[]; featureFlags?: string[];
  signIn(opts?): Promise<void>; signOut(opts?): Promise<void>; switchToOrganization(orgId: string): Promise<void>;
  getAccessToken(): Promise<string | null>;
}
```

## Testing Requirements

### Unit Tests
| Test File | Coverage |
|---|---|
| `use-auth.spec.tsx` | on-mount fetch, push update, unsubscribe, missing-bridge error |
| `use-access-token.spec.tsx` | fetch, null-when-signed-out, refresh, error |
| `guards.spec.tsx` | SignedIn/SignedOut render by state |

**Key test cases**:
- `onAuthChange` from another window updates this renderer.
- `useBridge()` throws a clear error when preload didn't run.
- No code path exposes `refreshToken` (type-level: `RendererAuth` has no such field).

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Provider | Bridge missing | `exposeAuthKit()` not called in preload | Hooks throw on use | `useBridge()` throws a clear, actionable error |
| Provider | Stale state after sign-out in another window | Missed `onAuthChange` | Renderer shows stale user | Subscription is the single update path; also re-fetch on window focus (optional) |
| useAccessToken | Token fetch races sign-out | `getAccessToken` resolves after `onAuthChange(null)` | Brief stale token in state | Ignore a resolved token if the latest auth is null (guard with a ref) |

## Validation Commands

```bash
pnpm tsc --noEmit
pnpm lint
pnpm vitest run --coverage
pnpm build
```

## Open Items

- [ ] Align exact `useAuth`/`useAccessToken` field and method names with `@workos/authkit-react`.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
