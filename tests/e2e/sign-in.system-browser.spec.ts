/**
 * E2E: full sign-in via the system-browser ceremony (success criterion 7, mode 1).
 *
 * System-browser mode hands the authorization URL to `shell.openExternal`, which
 * opens the OS browser — a window Playwright did not launch and cannot drive
 * (the spec's Open Item). So we make the hop deterministic and CI-friendly:
 *
 *   1. Stub `shell.openExternal` in the main process (via app.evaluate) to
 *      CAPTURE the authorization URL instead of opening a real browser.
 *   2. Drive that hosted URL in a Playwright-controlled Chromium page (test
 *      credentials) so AuthKit redirects to `workos-auth://callback?code=...`.
 *   3. Deliver that callback URL back to the app as the OS would — through the
 *      same deep-link event the SDK listens on — and assert the renderer shows
 *      the authenticated user.
 *
 * This exercises the real createAuthorization -> hosted sign-in -> code-exchange
 * path end to end; only the browser *transport* is substituted, exactly the
 * "stubs the external browser" option the spec calls out.
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

test.describe('sign-in: system-browser ceremony', () => {
  // Skip (not fail) when prerequisites are missing — bootstrap gate with a clear
  // message. A real sign-in failure once secrets are present is a hard failure.
  test.skip(skipReason !== null, skipReason ?? '');

  let app: ElectronApplication;
  let window: Page;

  test.beforeEach(async () => {
    ({ app, window } = await launchExample('system-browser', creds as E2ECredentials));
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('signs in via the (stubbed) system browser and reaches the renderer', async ({
    browser,
  }) => {
    await expectSignedOut(window);

    // 1. Capture the URL the app would open externally.
    const openedUrlPromise = captureExternalOpen(app);
    await window.getByTestId('sign-in').first().click();
    const authUrl = await openedUrlPromise;
    expect(authUrl).toMatch(/^https?:\/\//);

    // 2. Drive the hosted page in a real (Playwright) browser to obtain the
    //    callback URL with the authorization code.
    const callbackUrl = await completeHostedFlowAndCaptureCallback(
      browser,
      authUrl,
      creds as E2ECredentials,
    );
    expect(callbackUrl).toContain('code=');

    // 3. Deliver the deep link to the app exactly as the OS would.
    await deliverDeepLink(app, callbackUrl);

    await expectSignedIn(window);
    await expectNoRefreshTokenInRenderer(window);
  });
});

/**
 * Replace `shell.openExternal` in the main process with a capture stub and
 * resolve with the first URL the app tries to open.
 */
function captureExternalOpen(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ shell }) => {
    return new Promise<string>((resolveUrl) => {
      const original = shell.openExternal.bind(shell);
      shell.openExternal = async (url: string): Promise<void> => {
        resolveUrl(url);
        // Don't actually open a browser during the test.
        void original;
      };
    });
  });
}

/**
 * Open the authorization URL in a Playwright browser, complete the AuthKit
 * hosted sign-in, and capture the resulting `workos-auth://callback?...` URL.
 *
 * The hosted page's final redirect targets a custom scheme the browser can't
 * navigate to; we intercept that navigation request and read its URL.
 */
async function completeHostedFlowAndCaptureCallback(
  browser: import('@playwright/test').Browser,
  authUrl: string,
  credentials: E2ECredentials,
): Promise<string> {
  const context = await browser.newContext();
  const page = await context.newPage();

  let callbackUrl: string | null = null;
  // The custom-scheme redirect surfaces as a navigation request the browser
  // refuses; capture it before it fails.
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('workos-auth://')) {
      callbackUrl = url;
    }
  });
  page.on('framenavigated', (frame) => {
    const url = frame.url();
    if (url.startsWith('workos-auth://')) {
      callbackUrl = url;
    }
  });

  await page.goto(authUrl, { waitUntil: 'domcontentloaded' });
  await hostedSignIn(page, credentials);

  // Give the final redirect a moment to fire.
  await expect
    .poll(() => callbackUrl, { timeout: 30_000 })
    .toEqual(expect.stringContaining('code='));

  await context.close();
  if (!callbackUrl) {
    throw new Error('Did not capture a workos-auth:// callback URL from the hosted flow.');
  }
  return callbackUrl;
}

/**
 * Emit the deep-link event into the main process exactly as the OS would on
 * each platform: `open-url` on macOS, `second-instance` (argv) elsewhere.
 */
async function deliverDeepLink(app: ElectronApplication, callbackUrl: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, url) => {
    if (process.platform === 'darwin') {
      electronApp.emit('open-url', { preventDefault() {} }, url);
    } else {
      electronApp.emit('second-instance', { preventDefault() {} }, ['app', url], process.cwd());
    }
  }, callbackUrl);
}
