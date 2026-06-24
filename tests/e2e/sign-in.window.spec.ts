/**
 * E2E: full sign-in via the in-app window ceremony (success criterion 7, mode 2).
 *
 * Window mode opens the AuthKit hosted page inside a child `BrowserWindow`, which
 * Playwright can reach directly via `app.windows()`. We drive that window's
 * hosted form, the SDK intercepts the navigation to `workos-auth://callback`,
 * completes the OAuth round-trip in the main process, and broadcasts the
 * authenticated user to the renderer — which we assert.
 */

import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import {
  type E2ECredentials,
  expectNoRefreshTokenInRenderer,
  expectSignedIn,
  expectSignedOut,
  hostedSignIn,
  launchExample,
  missingPrerequisites,
  readCredentials,
} from './helpers.js';

const creds = readCredentials();
const skipReason = missingPrerequisites(creds);

test.describe('sign-in: window ceremony', () => {
  // Skip (not fail) the whole describe when prerequisites are missing — this is
  // the bootstrap gate, with a clear message. A real sign-in failure once the
  // secrets are present is a hard failure inside the test body, never a skip.
  test.skip(skipReason !== null, skipReason ?? '');

  let app: ElectronApplication;
  let window: Page;

  test.beforeEach(async () => {
    ({ app, window } = await launchExample('window', creds as E2ECredentials));
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('signs in through the in-app window and reaches the renderer', async () => {
    await expectSignedOut(window);

    // Trigger sign-in; window mode opens the hosted page as a NEW BrowserWindow.
    const authWindowPromise = app.waitForEvent('window', { timeout: 30_000 });
    await window.getByTestId('sign-in').first().click();
    const authWindow = await authWindowPromise;
    await authWindow.waitForLoadState('domcontentloaded');

    await hostedSignIn(authWindow, creds as E2ECredentials);

    // The SDK intercepts the redirect-URI navigation, completes the exchange,
    // and broadcasts; the original renderer window reflects the signed-in user.
    await expectSignedIn(window);
    await expectNoRefreshTokenInRenderer(window);
  });

  test('signs out back to the signed-out state', async () => {
    await expectSignedOut(window);

    const authWindowPromise = app.waitForEvent('window', { timeout: 30_000 });
    await window.getByTestId('sign-in').first().click();
    const authWindow = await authWindowPromise;
    await authWindow.waitForLoadState('domcontentloaded');
    await hostedSignIn(authWindow, creds as E2ECredentials);
    await expectSignedIn(window);

    await window.getByTestId('sign-out').first().click();
    await expect(window.getByTestId('sign-in').first()).toBeVisible({ timeout: 15_000 });
  });
});
