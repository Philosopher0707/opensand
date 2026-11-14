import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcBridge } from './ipc-bridge.js';
import { getOnboardingState } from './onboarding.js';
import { DesktopServer } from './desktop-server.js';
import { DesktopTrayManager } from './tray.js';
import { listMissionSummaries } from './shell/mission-list-source.js';
import type { DesktopEvent, ApprovalDecision, DesktopSettings } from './types.js';

export class DesktopApp {
  private bridge: DesktopIpcBridge;
  private trayManager: DesktopTrayManager | null = null;
  private mainWindow: any = null;
  private server: DesktopServer | null = null;
  private electron: any = null;

  constructor() {
    this.bridge = new DesktopIpcBridge();
  }

  public async start(): Promise<void> {
    // Dynamic import keeps this module loadable in plain Node (tests, web mode);
    // in plain Node 'electron' resolves to a path string, so app/BrowserWindow are absent.
    let electron: any;
    try {
      electron = await import('electron');
    } catch {
      console.log('[OpenSand Desktop] Electron not available. Run desktop-server for web mode.');
      return;
    }

    const { app, BrowserWindow, ipcMain, dialog } = electron;
    if (!app || !BrowserWindow) {
      console.log('[OpenSand Desktop] Electron not detected. Run desktop-server for web mode.');
      return;
    }
    this.electron = electron;

    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }

    await app.whenReady();

    // Packaged builds get their icon from the app bundle; an unpackaged `electron .`
    // dev run otherwise shows the generic Electron icon in the Dock.
    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(fileURLToPath(new URL('../../../../build/icon.png', import.meta.url)));
      } catch {
        // Non-fatal: dev-mode dock icon is cosmetic only.
      }
    }

    app.on('second-instance', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });

    try {
      // Ephemeral port: the window loads whatever URL the server returns, so a
      // dev server already on 3456 cannot block the app from starting.
      this.server = new DesktopServer({ port: 0, appVersion: app.getVersion() });
      const { url } = await this.server.start();
      console.log('[OpenSand Desktop] server listening:', url.split('?')[0]);

      const onboarding = await getOnboardingState(this.server.getBridge());
      if (onboarding.needsOnboarding) console.log('[OpenSand Desktop] first run: no model and no key, showing onboarding');
      const welcome = new URL(url);
      welcome.pathname = '/welcome';
      const target = onboarding.needsOnboarding ? welcome.toString() : url;
      const origin = new URL(url).origin;

      this.setupIpcHandlers(ipcMain, origin);
      this.createMainWindow(BrowserWindow, target);
      this.setupTray();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.createMainWindow(BrowserWindow, target);
        }
      });

      app.on('window-all-closed', () => {
        // macOS standard behavior: keep menubar app alive unless explicitly quit
        if (process.platform !== 'darwin') {
          app.quit();
        }
      });

      app.on('before-quit', () => {
        void this.server?.stop();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[OpenSand Desktop] Failed to start:', message);
      dialog?.showErrorBox?.('OpenSand could not start', message);
      app.quit();
    }
  }

  private resolvePreloadPath(): string {
    const candidateDist = fileURLToPath(new URL('./preload.cjs', import.meta.url));
    const candidateAlt = path.join(import.meta.dirname, 'preload.cjs');
    if (fs.existsSync(candidateDist)) return candidateDist;
    if (fs.existsSync(candidateAlt)) return candidateAlt;
    return candidateDist;
  }

  private createMainWindow(BrowserWindow: any, serverUrl: string): void {
    const origin = new URL(serverUrl).origin;

    this.mainWindow = new BrowserWindow({
      width: 960,
      height: 740,
      minWidth: 700,
      minHeight: 500,
      title: 'OpenSand',
      backgroundColor: '#18181b',
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.resolvePreloadPath(),
      },
    });

    void this.mainWindow.loadURL(serverUrl);

    // Keep navigation inside the local server; send everything else to the browser.
    const shell = this.electron?.shell;
    this.mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
      if (shell) void shell.openExternal(url);
      return { action: 'deny' };
    });
    this.mainWindow.webContents.on('will-navigate', (event: any, target: string) => {
      if (!target.startsWith(origin)) {
        event.preventDefault();
        if (shell) void shell.openExternal(target);
      }
    });

    // Forward IPC events to renderer
    this.bridge.on('event', (event: DesktopEvent) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('opensand:event', event);
      }
      if (this.trayManager) {
        if (event.type === 'token') {
          this.trayManager.setStatus('thinking');
        } else if (event.type === 'tool_call') {
          this.trayManager.setStatus('executing');
        } else if (event.type === 'turn_complete') {
          this.trayManager.setStatus('idle');
        } else if (event.type === 'error') {
          this.trayManager.setStatus('error');
        }
      }
    });
  }

  private setupIpcHandlers(ipcMain: any, serverOrigin?: string): void {
    if (serverOrigin) {
      ipcMain.on('opensand:isAllowedOrigin', (event: any) => {
        const senderUrl = event.senderFrame?.url || event.sender?.getURL() || '';
        try {
          const senderOrigin = new URL(senderUrl).origin;
          event.returnValue = senderOrigin === serverOrigin;
        } catch {
          event.returnValue = false;
        }
      });
    }

    ipcMain.handle('opensand:sendQuery', async (_: any, { query, sessionId, agentId }: { query: string; sessionId?: string; agentId?: string }) => {
      return this.bridge.sendQuery(query, sessionId, agentId);
    });

    ipcMain.handle('opensand:cancelTurn', async () => {
      return this.bridge.cancelTurn();
    });

    ipcMain.handle('opensand:approveTool', async (_: any, { approvalId, decision }: { approvalId: string; decision: ApprovalDecision }) => {
      return this.bridge.approveTool(approvalId, decision);
    });

    ipcMain.handle('opensand:listPendingApprovals', async () => {
      return this.bridge.listPendingApprovals();
    });

    ipcMain.handle('opensand:getToolDiscovery', async () => {
      return this.bridge.getToolDiscovery();
    });

    ipcMain.handle('opensand:getSessions', async () => {
      return this.bridge.getSessions();
    });

    // Read-only: summarises <~/.opensand>/missions logs for the Preact mission list.
    ipcMain.handle('opensand:listMissions', async () => {
      return listMissionSummaries(path.join(os.homedir(), '.opensand'));
    });

    ipcMain.handle('opensand:loadSession', async (_: any, { sessionId }: { sessionId: string }) => {
      return this.bridge.loadSession(sessionId);
    });

    ipcMain.handle('opensand:deleteSession', async (_: any, { sessionId }: { sessionId: string }) => {
      return this.bridge.deleteSession(sessionId);
    });

    ipcMain.handle('opensand:clearAllSessions', async () => {
      return this.bridge.clearAllSessions();
    });

    ipcMain.handle('opensand:deleteAgent', async (_: any, { id }: { id: string }) => {
      return this.bridge.deleteAgent(id);
    });

    ipcMain.handle('opensand:getSettings', async () => {
      return this.bridge.getSettings();
    });

    ipcMain.handle('opensand:updateSettings', async (_: any, settings: Partial<DesktopSettings>) => {
      return this.bridge.updateSettings(settings);
    });

    ipcMain.handle('opensand:getTokenTelemetry', async (_: any, { agentId, sessionId }: { agentId?: string; sessionId?: string } = {}) => {
      return this.bridge.getTokenTelemetry(agentId, sessionId);
    });
  }

  private setupTray(): void {
    this.trayManager = new DesktopTrayManager({
      onToggleWindow: () => {
        if (this.mainWindow) {
          if (this.mainWindow.isVisible()) {
            this.mainWindow.hide();
          } else {
            this.mainWindow.show();
            this.mainWindow.focus();
          }
        }
      },
      onNewSession: () => {
        if (this.mainWindow) {
          this.mainWindow.show();
          this.mainWindow.webContents.send('opensand:newSession');
        }
      },
      onOpenSettings: () => {
        if (this.mainWindow) {
          this.mainWindow.show();
          this.mainWindow.webContents.send('opensand:openSettings');
        }
      },
      onQuit: () => {
        this.electron?.app?.quit();
      },
    }, this.electron);

    this.trayManager.init();
  }
}

// Auto-start if executed directly via Electron
if (process.versions.electron) {
  const desktopApp = new DesktopApp();
  void desktopApp.start();
}
