/**
 * Opt-in ambient `Window` typing for the preload bridge — types only, no runtime.
 *
 * The runtime global is created by `exposeAuthKit()` (from
 * `@workos/authkit-electron/preload`); this file only teaches TypeScript about
 * it. Opt in from renderer code with either a triple-slash reference:
 *
 *   /// <reference types="@workos/authkit-electron/globals" />
 *
 * or the renderer tsconfig:
 *
 *   { "compilerOptions": { "types": ["@workos/authkit-electron/globals"] } }
 *
 * The property is optional on purpose: the bridge is genuinely absent when the
 * preload script didn't run (the most common misconfiguration — see
 * Troubleshooting in the README), so the type system asks for one guard at the
 * first use site instead of allowing a runtime surprise later.
 */

import type { AuthKitBridge } from './dist/preload/index.js';

declare global {
  interface Window {
    readonly __authkit_electron?: AuthKitBridge;
  }
}
