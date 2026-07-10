import { ElectronAPI } from '@electron-toolkit/preload';

// `window.__authkit_electron` is typed by the renderer's env.d.ts reference to
// `@workos/authkit-electron/globals`; only the example's own globals live here.
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
