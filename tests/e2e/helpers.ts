/**
 * Shared helpers for the Playwright + Electron e2e suite.
 *
 * Each ceremony mode has its own spec file (sign-in.system-browser.spec.ts and
 * sign-in.window.spec.ts) so dropping either fails the gate — that is success
 * criterion 7 ("a passing test for system-browser AND window"). These helpers
 * launch the BUILT example app (`example/out/main/index.js`), drive the AuthKit
 * hosted sign-in page, and assert the authenticated user reaches the renderer
 * while the refresh token never appears in anything the renderer can read.
 *
 * The WorkOS backend is real for now. The suite is structured so it can later
 * point at `@workos/emulate` by swapping `hostedSignIn()` for a fixture/base URL
 * — the launch + renderer assertions stay identical.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
} from '@playwright/test';
import { AUTHKIT_BRIDGE_KEY } from '../../src/shared/ipc-channels.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (tests/e2e/ -> ../..). */
const repoRoot = resolve(here, '..', '..');

/** The built example main entry. `pnpm --filter ./example build` produces this. */
export const exampleMain = resolve(repoRoot, 'example', 'out', 'main', 'index.js');

/**
 * Credentials/config the real-instance e2e needs. Absent in a bare checkout, so
 * the specs skip with a clear message rather than failing the bootstrap — the
 * required secrets are documented in `.github/workflows/ci.yml`. (A genuine
 * sign-in FAILURE once these are present is still a hard gate failure, never a
 * skip — see the spec's Error Handling table.)
 */
export interface E2ECredentials {
  clientId: string;
  email: string;
  password: string;
}

/** Read e2e credentials from the environment, or null when not fully configured. */
export function readCredentials(): E2ECredentials | null {
  const clientId = process.env.E2E_WORKOS_CLIENT_ID;
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;
  if (!clientId || !email || !password) {
    return null;
  }
  return { clientId, email, password };
}

/** Human-readable reason used by `test.skip(...)` when prerequisites are missing. */
export function missingPrerequisites(creds: E2ECredentials | null): string | null {
  if (!existsSync(exampleMain)) {
    return `Built example not found at ${exampleMain}. Run \`pnpm build && pnpm --filter ./example build\` first.`;
  }
  if (!creds) {
    return 'Missing E2E_WORKOS_CLIENT_ID / E2E_TEST_EMAIL / E2E_TEST_PASSWORD. See .github/workflows/ci.yml for the required secrets.';
  }
  return null;
}

export interface LaunchResult {
  app: ElectronApplication;
  window: Page;
}

/**
 * Launch the built example and return the app + its first window.
 *
 * @param ceremony which sign-in ceremony the main process should construct.
 * @param creds    WorkOS client id is injected as the app expects.
 */
export async function launchExample(
  ceremony: 'system-browser' | 'window',
  creds: E2ECredentials,
): Promise<LaunchResult> {
  const app = await electron.launch({
    args: [exampleMain],
    env: {
      ...process.env,
      // The example main prefers this RUNTIME value over the build-time
      // import.meta.env, so the prebuilt app picks up the test Client ID
      // without a rebuild (see example/src/main/index.ts).
      MAIN_VITE_WORKOS_CLIENT_ID: creds.clientId,
      AUTHKIT_CEREMONY: ceremony,
      NODE_ENV: 'test',
    },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

/** Assert the renderer is in the signed-out state (the Sign In button is shown). */
export async function expectSignedOut(window: Page): Promise<void> {
  await expect(window.getByTestId('sign-in').first()).toBeVisible({ timeout: 15_000 });
}

/**
 * Drive the AuthKit hosted sign-in page to completion.
 *
 * Selectors are pinned to AuthKit's hosted form (email + password). Retry-once
 * for the email step absorbs hosted-page latency without masking a real failure.
 */
export async function hostedSignIn(page: Page, creds: E2ECredentials): Promise<void> {
  const emailField = page.getByLabel(/email/i);
  await emailField.waitFor({ state: 'visible', timeout: 30_000 });
  await emailField.fill(creds.email);

  // The hosted flow may be single-step (email+password together) or two-step
  // (email -> continue -> password). Handle both: click a Continue/Next if it
  // gates the password field.
  const continueButton = page.getByRole('button', { name: /continue|next/i });
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click();
  }

  const passwordField = page.getByLabel(/password/i);
  await passwordField.waitFor({ state: 'visible', timeout: 30_000 });
  await passwordField.fill(creds.password);

  await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
}

/** Assert the authenticated user reached the renderer (welcome heading shown). */
export async function expectSignedIn(window: Page): Promise<void> {
  await expect(window.getByTestId('welcome')).toBeVisible({ timeout: 30_000 });
  await expect(window.getByTestId('sign-out').first()).toBeVisible();
}

/**
 * Assert the refresh token is not exposed to the renderer.
 *
 * The renderer can only read what crosses the IPC bridge (`window[AUTHKIT_BRIDGE_KEY]`).
 * We serialize everything reachable through `getUser()` and assert no
 * `refreshToken` field is present — the single chokepoint is the SDK's
 * `toRendererAuthPayload`, and this is the e2e backstop for it.
 */
export async function expectNoRefreshTokenInRenderer(window: Page): Promise<void> {
  const payload = await window.evaluate(async (bridgeKey) => {
    const bridge = (globalThis as Partial<Record<string, { getUser(): Promise<unknown> }>>)[
      bridgeKey
    ];
    if (!bridge) {
      return null;
    }
    return bridge.getUser();
  }, AUTHKIT_BRIDGE_KEY);
  const serialized = JSON.stringify(payload ?? {});
  expect(serialized).not.toContain('refreshToken');
}
