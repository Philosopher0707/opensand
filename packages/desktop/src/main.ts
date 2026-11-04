import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcBridge } from './ipc-bridge.js';
import { DesktopTrayManager } from './tray.js';
import type { DesktopEvent, ApprovalDecision, DesktopSettings } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DesktopApp {
  private bridge: DesktopIpcBridge;
  private trayManager: DesktopTrayManager | null = null;
  private mainWindow: any = null;

  constructor() {
    this.bridge = new DesktopIpcBridge();
  }

  public async start(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app, BrowserWindow, ipcMain } = require('electron');

      if (!app) {
        console.log('[OpenSand Desktop] Electron not detected. Run desktop-server for web mode.');
        return;
      }

      await app.whenReady();

      this.createMainWindow(BrowserWindow);
      this.setupIpcHandlers(ipcMain);
      this.setupTray();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          this.createMainWindow(BrowserWindow);
        }
      });

      app.on('window-all-closed', () => {
        // macOS standard behavior: keep menubar app alive unless explicitly quit
        if (process.platform !== 'darwin') {
          app.quit();
        }
      });
    } catch (err) {
      console.log('[OpenSand Desktop] Running in headless / server mode:', err);
    }
  }

  private createMainWindow(BrowserWindow: any): void {
    this.mainWindow = new BrowserWindow({
      width: 960,
      height: 740,
      minWidth: 700,
      minHeight: 500,
      title: 'OpenSand',
      backgroundColor: '#18181b',
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const indexPath = path.join(__dirname, '../../renderer/index.html');
    this.mainWindow.loadFile(indexPath);

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

  private setupIpcHandlers(ipcMain: any): void {
    ipcMain.handle('opensand:sendQuery', async (_: any, { query, sessionId, agentId }: { query: string; sessionId?: string; agentId?: string }) => {
      return this.bridge.sendQuery(query, sessionId, agentId);
    });

    ipcMain.handle('opensand:approveTool', async (_: any, { approvalId, decision }: { approvalId: string; decision: ApprovalDecision }) => {
      return this.bridge.approveTool(approvalId, decision);
    });

    ipcMain.handle('opensand:getSessions', async () => {
      return this.bridge.getSessions();
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
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require('electron');
        app.quit();
      },
    });

    this.trayManager.init();
  }
}

// Auto-start if executed directly via Electron
if (process.versions.electron) {
  const desktopApp = new DesktopApp();
  desktopApp.start();
}
