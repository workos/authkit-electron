/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_WORKOS_CLIENT_ID: string;
  /** Optional `.env` ceremony toggle: `window` for the in-app BrowserWindow. */
  readonly MAIN_VITE_AUTHKIT_CEREMONY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
