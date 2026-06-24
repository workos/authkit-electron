import { ElectronAPI } from '@electron-toolkit/preload';
import type { AuthKitBridge } from '@workos/authkit-electron/preload';

// The SDK owns the bridge shape; the example no longer redeclares channel names
// or a local User type. `exposeAuthKit()` mounts this under the global below.
declare global {
  interface Window {
    electron: ElectronAPI;
    __authkit_electron: AuthKitBridge;
  }
}
