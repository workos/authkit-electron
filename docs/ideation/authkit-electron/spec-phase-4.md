# Implementation Spec: @workos/authkit-electron - Phase 4 (In-app window ceremony mode)

**Contract**: ./contract.md
**Estimated Effort**: S/M

## Technical Approach

Phase 4 adds the second ceremony mode: `ceremony.mode: 'window'`. Instead of `shell.openExternal`, the SDK opens a child `BrowserWindow` pointed at the hosted AuthKit authorization URL and captures the callback by **intercepting navigation** to the `redirectUri` — `preventDefault()`-ing it *before* it escapes to the OS and re-triggers the deep-link protocol handler (the double-handle hazard). Everything after capture reuses the Phase 2 `completeCallback` orchestration unchanged; this phase only swaps how the URL is opened and how `code`/`state` are intercepted.

Because the hosted AuthKit page loads at a real `https://` origin inside the `BrowserWindow`, WebAuthn/passkeys work without any native module (verified against WorkOS docs). The one platform caveat to document: Touch ID inside a `BrowserWindow` requires Electron ≥ 42 + `app.configureWebAuthn` — a non-issue in `system-browser` mode.

**Pattern to follow**: the `Ceremony` interface from Phase 2 (`src/main/ceremony/index.ts`); `system-browser.ts` is the sibling implementation.

## Feedback Strategy

**Inner-loop command**: `pnpm vitest run ceremony-window`

**Playground**: Unit test for the navigation-intercept predicate (does this URL match `redirectUri`? extract `code`/`state`); manual smoke for the actual window flow in the example app.

**Why this approach**: The risky, regressable logic is the intercept predicate and double-handle avoidance — pure and unit-testable. The visual window behavior is a one-time manual check.

## File Changes

### New Files

| File Path | Purpose |
|---|---|
| `src/main/ceremony/window.ts` | `BrowserWindow` ceremony: open URL, intercept navigation to `redirectUri`, capture + close |
| `src/main/ceremony/__tests__/window.spec.ts` | Intercept-predicate + capture tests |

### Modified Files

| File Path | Changes |
|---|---|
| `src/main/ceremony/index.ts` | Select implementation by `config.ceremony.mode` (default `system-browser`) |
| `src/main/deep-link.ts` | When window mode is active, ensure an intercepted `redirectUri` navigation does NOT also fire the protocol handler |

## Implementation Details

### Window ceremony (`ceremony/window.ts`)

**Overview**: Opens a modal child window; resolves the callback through navigation interception rather than the OS protocol.

```typescript
export function createWindowCeremony(opts: {
  redirectUri: string;
  onCallback: (code?: string, state?: string, error?: string) => void;
  parent?: BrowserWindow;
}): Ceremony;
```

**Implementation steps**:
1. `open(url)`: create a `BrowserWindow` (modal to `parent` if given), `loadURL(url)`.
2. On `webContents` `will-redirect` and `will-navigate`: if the target starts with `redirectUri`, `event.preventDefault()`, parse via the shared `parseCallback`, call `onCallback`, and `close()` the window.
3. On user-closed-without-completing: emit a cancellation so the renderer's `signIn` promise settles.

**Key decisions**:
- `will-redirect` is intercepted before the navigation commits, so the `workos-auth://` (or http) redirect never reaches the OS — no double-handle with the deep-link handler.
- The intercept matches on `redirectUri` prefix; reuse `parseCallback` from Phase 2 (no second parser).

**Feedback loop**:
- **Playground**: `window.spec.ts` — unit-test the predicate `isCallbackNavigation(url, redirectUri)` and the `code`/`state` extraction; mock `BrowserWindow`/`webContents` events.
- **Experiment**: navigation to `redirectUri?code&state` → captured + window closed; navigation to an unrelated AuthKit URL (e.g. an interstitial) → not intercepted; `error` param → surfaced; user closes window → cancellation emitted.
- **Check command**: `pnpm vitest run ceremony-window`

## Testing Requirements

### Unit Tests
| Test File | Coverage |
|---|---|
| `ceremony/__tests__/window.spec.ts` | intercept predicate, code/state extraction, no-intercept on interstitials, cancellation |

### Manual Testing
- [ ] In the example app set `ceremony: { mode: 'window' }`, click sign-in → child window opens to AuthKit, authenticate, window closes, user appears. No second protocol-handler fire (add a temporary log in the deep-link handler to confirm it does NOT run in window mode).
- [ ] Close the window mid-flow → `signIn` rejects/﻿resolves to a cancellation, UI returns to signed-out.

## Error Handling

| Error Scenario | Handling Strategy |
|---|---|
| User closes window before completing | Emit cancellation; settle the `signIn` promise as cancelled (not an error toast) |
| Navigation to `redirectUri` with `error` param | Parse + surface typed error; close window |
| `will-redirect` fires but URL unparseable | Leave window open; log; let user retry or close |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
|---|---|---|---|---|
| Window ceremony | Double-handle | Intercepted redirect also hits the OS protocol handler | Callback processed twice | `preventDefault()` on `will-redirect` before commit; verify deep-link handler does not fire in window mode |
| Window ceremony | Passkey/Touch ID unavailable in-window | macOS Touch ID, Electron < 42 | Passkey prompt fails in window mode | Document Electron ≥ 42 + `app.configureWebAuthn`; system-browser mode is the fallback |
| Window ceremony | Window leak | Window not closed on error path | Orphaned window | `close()` in a `finally`; null the reference |

## Validation Commands

```bash
pnpm tsc --noEmit
pnpm lint
pnpm vitest run --coverage
pnpm build
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
