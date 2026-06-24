import { contextBridge } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';
import { exposeAuthKit } from '@workos/authkit-electron/preload';

// The hand-wired `authApi` (and its duplicated channel map that had to "match"
// main by comment) is gone — one call wires the typed bridge onto
// `window.__authkit_electron` over the SDK-owned IPC channels.
exposeAuthKit();

// Keep the electron-vite template's electronAPI expose (unrelated to auth).
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
}
