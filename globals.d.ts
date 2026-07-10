/**
 * Opt-in ambient `Window` typing for the bridge `exposeAuthKit()` creates —
 * types only, no runtime. Opt in from renderer code with
 * `/// <reference types="@workos/authkit-electron/globals" />` (or tsconfig
 * `compilerOptions.types`). The property is optional because the bridge is
 * genuinely absent when the preload script didn't run — guard the first use.
 * See "Renderer without React" in the README.
 */

import { AUTHKIT_BRIDGE_KEY } from './dist/shared/ipc-channels.js';
import type { AuthKitBridge } from './dist/shared/ipc.js';

declare global {
  interface Window {
    readonly [AUTHKIT_BRIDGE_KEY]?: AuthKitBridge;
  }
}
