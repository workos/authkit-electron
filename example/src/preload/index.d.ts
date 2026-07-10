import { ElectronAPI } from '@electron-toolkit/preload';

// The SDK owns the bridge shape AND its Window typing: `exposeAuthKit()` mounts
// `window.__authkit_electron`, typed via the ambient reference in
// src/renderer/src/env.d.ts (`@workos/authkit-electron/globals`) — the example
// no longer redeclares the property here.
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
