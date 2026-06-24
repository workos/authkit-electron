/**
 * Main-process IPC surface + auth-change broadcast.
 *
 * Registers one `ipcMain.handle` per SDK-owned channel, delegating to the
 * session manager. Two load-bearing properties:
 *
 * 1. **No refresh token crosses IPC.** Every renderer-facing auth payload is
 *    built by `toRendererAuthPayload` (Phase 1), which strips `refreshToken`
 *    via an explicit allowlist. This module never hand-builds a payload.
 * 2. **Errors never throw across `invoke`.** `ipcRenderer.invoke` flattens a
 *    rejected handler into an opaque rejection, so we return a discriminated
 *    `IpcResult` (`{ ok: true, data } | { ok: false, error }`) instead — the
 *    renderer can branch on `ok` and read a stable `error.code`.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels.js';
import { type RendererAuthPayload, toRendererAuthPayload } from '../shared/types.js';
import type { SessionManager } from './session-manager.js';

/** Discriminated result returned across every renderer→main `invoke`. */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** Minimal `ipcMain` surface (injectable for tests). */
export interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Minimal `BrowserWindow` static surface used for broadcast (injectable). */
export interface BrowserWindowsLike {
  getAllWindows(): WebContentsHolder[];
}

interface WebContentsHolder {
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

export interface RegisterIpcHandlersOptions {
  ipcMain?: IpcMainLike;
  /**
   * Override the auth-change broadcaster. Defaults to {@link broadcastAuthChange}
   * over all `BrowserWindow`s. Injected by tests, and by `createAuthKit` so the
   * deep-link callback and the IPC handlers share one broadcast path.
   */
  broadcast?: (payload: RendererAuthPayload) => void;
}

/**
 * Normalize any thrown value into the typed `{ ok: false, error }` branch.
 * Uses the error's class name as a stable `code` so the renderer can branch.
 */
function toErrorResult(err: unknown): { ok: false; error: { code: string; message: string } } {
  if (err instanceof Error) {
    return { ok: false, error: { code: err.name, message: err.message } };
  }
  return { ok: false, error: { code: 'UnknownError', message: String(err) } };
}

/** Run an operation, wrapping success/failure in an `IpcResult`. */
async function toResult<T>(op: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await op() };
  } catch (err) {
    return toErrorResult(err);
  }
}

/**
 * Register every renderer→main handler. Returns a cleanup function that removes
 * all of them (used by `createAuthKit().cleanup()`).
 */
export function registerIpcHandlers(
  sm: SessionManager,
  opts: RegisterIpcHandlersOptions = {},
): () => void {
  const ipc: IpcMainLike = opts.ipcMain ?? (ipcMain as unknown as IpcMainLike);
  const broadcast =
    opts.broadcast ?? ((payload: RendererAuthPayload) => broadcastAuthChange(payload));

  // ipcMain.handle passes (event, ...args); the renderer's first invoke arg is
  // therefore args[1]. We read it positionally so the handler is agnostic to
  // the IpcMainInvokeEvent type (which we deliberately don't import here).
  ipc.handle(IPC_CHANNELS.signIn, (...args: unknown[]): Promise<IpcResult<null>> => {
    const signInOpts = (args[1] ?? undefined) as
      | { screenHint?: 'sign-in' | 'sign-up'; organizationId?: string }
      | undefined;
    return toResult(async () => {
      await sm.beginSignIn(signInOpts);
      return null;
    });
  });

  ipc.handle(
    IPC_CHANNELS.signOut,
    (...args: unknown[]): Promise<IpcResult<{ logoutUrl: string }>> => {
      const signOutOpts = (args[1] ?? undefined) as { returnTo?: string } | undefined;
      return toResult(async () => {
        const res = await sm.signOut(signOutOpts);
        // Signing out is an auth change — tell every window.
        broadcast({ user: null });
        return res;
      });
    },
  );

  ipc.handle(IPC_CHANNELS.getUser, (): Promise<IpcResult<RendererAuthPayload>> => {
    return toResult(async () => toRendererAuthPayload(await sm.getUser()));
  });

  ipc.handle(IPC_CHANNELS.getAccessToken, (): Promise<IpcResult<string | null>> => {
    return toResult(() => sm.getAccessToken());
  });

  ipc.handle(
    IPC_CHANNELS.switchToOrganization,
    (...args: unknown[]): Promise<IpcResult<RendererAuthPayload>> => {
      const orgId = args[1] as string;
      return toResult(async () => {
        const auth = await sm.switchToOrganization(orgId);
        const payload = toRendererAuthPayload(auth);
        broadcast(payload);
        return payload;
      });
    },
  );

  return () => {
    ipc.removeHandler(IPC_CHANNELS.signIn);
    ipc.removeHandler(IPC_CHANNELS.signOut);
    ipc.removeHandler(IPC_CHANNELS.getUser);
    ipc.removeHandler(IPC_CHANNELS.getAccessToken);
    ipc.removeHandler(IPC_CHANNELS.switchToOrganization);
  };
}

export interface BroadcastOptions {
  browserWindow?: BrowserWindowsLike;
}

/**
 * Broadcast an auth-change payload to every open window's renderer.
 *
 * Guards `webContents.isDestroyed()` so a window torn down mid-send is skipped
 * rather than throwing. The payload is already refresh-token-free (it is a
 * `RendererAuthPayload`).
 */
export function broadcastAuthChange(
  payload: RendererAuthPayload,
  opts: BroadcastOptions = {},
): void {
  const bw: BrowserWindowsLike =
    opts.browserWindow ?? (BrowserWindow as unknown as BrowserWindowsLike);
  for (const win of bw.getAllWindows()) {
    const wc = win.webContents;
    if (!wc.isDestroyed()) {
      wc.send(IPC_CHANNELS.authChanged, payload);
    }
  }
}
