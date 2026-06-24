import { app, shell, BrowserWindow } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { createAuthKit } from '@workos/authkit-electron';
import icon from '../../resources/icon.png?asset';

// ---------------------------------------------------------------------------
// The entire auth integration is now THREE calls across the three contexts:
//
//   main     -> createAuthKit({...}) + authkit.registerProtocol()   (here)
//   preload  -> exposeAuthKit()                                     (preload/index.ts)
//   renderer -> <AuthKitProvider> + useAuth()                       (renderer/src)
//
// This replaces the ~5 hand-wired files (src/main/auth/*, the renderer's local
// useAuth.ts, and the duplicated preload channel map) the example used to ship.
// ---------------------------------------------------------------------------

// The single-instance lock is the consumer's responsibility (the SDK can't
// control app lifecycle timing): it must run before the first window so the
// `second-instance` deep-link branch the SDK wires up can fire on Win/Linux.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Resolve the WorkOS Client ID. electron-vite inlines `import.meta.env.MAIN_VITE_*`
// at BUILD time, so prefer a RUNTIME `process.env` value when present — that lets
// the e2e harness launch the prebuilt app with its own test Client ID without a
// rebuild. Falls back to the build-time value for normal `pnpm dev` / packaged use.
const clientId =
  process.env.MAIN_VITE_WORKOS_CLIENT_ID ?? import.meta.env.MAIN_VITE_WORKOS_CLIENT_ID;

// Resolve the sign-in ceremony. Like the Client ID above, support BOTH channels:
// a runtime shell env var (`AUTHKIT_CEREMONY=window pnpm dev`) and a build-time
// `.env` value. Vite only exposes `.env` vars through `import.meta.env` when they
// carry the `MAIN_VITE_` prefix — it does NOT copy `.env` into `process.env` — so
// in `example/.env` the var must be `MAIN_VITE_AUTHKIT_CEREMONY=window`.
const ceremonyMode = process.env.AUTHKIT_CEREMONY ?? import.meta.env.MAIN_VITE_AUTHKIT_CEREMONY;
const mode = ceremonyMode === 'window' ? 'window' : 'system-browser';
console.log(
  `[example] sign-in ceremony: ${mode === 'window' ? 'window (in-app BrowserWindow)' : 'system-browser (OS browser)'}`,
);

// Construct the AuthKit runtime. No API key — this is a public OAuth client;
// only the WorkOS Client ID is needed and no secret ships in the binary.
const authkit = createAuthKit({
  clientId,
  redirectUri: 'workos-auth://callback',
  ceremony: { mode },
});

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // HMR for renderer based on electron-vite cli
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  // Set app user model id for Windows
  electronApp.setAppUserModelId('com.electron');

  // Default open or close DevTools by F12 in development
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Register the custom protocol + wire the cross-platform deep-link capture
  // matrix. Must run inside whenReady (before the first window) so it can also
  // handle a callback URL that arrives at cold start.
  authkit.registerProtocol();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Remove IPC handlers + deep-link listeners on shutdown.
  authkit.cleanup();
});
