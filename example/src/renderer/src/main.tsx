import '@radix-ui/themes/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthKitProvider } from '@workos/authkit-electron/react';
import App from './App';

// The renderer reflects the main process's auth state. <AuthKitProvider> fetches
// the current user once on mount and then subscribes to auth-change broadcasts
// from any window — so signing out in one window updates them all.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthKitProvider>
      <App />
    </AuthKitProvider>
  </StrictMode>,
);
