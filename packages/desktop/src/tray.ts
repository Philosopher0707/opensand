/**
 * OpenSand Menubar Tray & Global Hotkey Manager
 */

export interface TrayCallbacks {
  onToggleWindow: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onQuit: () => void;
}

export class DesktopTrayManager {
  private tray: any = null;
  private callbacks: TrayCallbacks;
  private currentStatus: 'idle' | 'thinking' | 'executing' | 'error' = 'idle';

  constructor(callbacks: TrayCallbacks) {
    this.callbacks = callbacks;
  }

  public init(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron');
      const { Tray, Menu, nativeImage, globalShortcut } = electron;

      if (!Tray) {
        return false;
      }

      // 16x16 1-bit or template icon representation
      const icon = nativeImage.createEmpty();
      this.tray = new Tray(icon);
      this.tray.setToolTip('OpenSand Agent');

      this.updateMenu();

      this.tray.on('click', () => {
        this.callbacks.onToggleWindow();
      });

      // Register global shortcut
      if (globalShortcut) {
        globalShortcut.register('CommandOrControl+Shift+Space', () => {
          this.callbacks.onToggleWindow();
        });
      }

      return true;
    } catch {
      // Electron not in environment
      return false;
    }
  }

  public setStatus(status: 'idle' | 'thinking' | 'executing' | 'error'): void {
    this.currentStatus = status;
    this.updateMenu();
  }

  private updateMenu(): void {
    if (!this.tray) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Menu } = require('electron');
      const statusLabels = {
        idle: '● OpenSand: Ready',
        thinking: '◌ OpenSand: Thinking...',
        executing: '⚡ OpenSand: Executing Tool...',
        error: '⚠ OpenSand: Error',
      };

      const contextMenu = Menu.buildFromTemplate([
        { label: statusLabels[this.currentStatus], enabled: false },
        { type: 'separator' },
        { label: 'Toggle OpenSand (⌘⇧Space)', click: () => this.callbacks.onToggleWindow() },
        { label: 'New Session', click: () => this.callbacks.onNewSession() },
        { label: 'Settings...', click: () => this.callbacks.onOpenSettings() },
        { type: 'separator' },
        { label: 'Quit OpenSand', click: () => this.callbacks.onQuit() },
      ]);

      this.tray.setContextMenu(contextMenu);
    } catch {
      // Silently ignore
    }
  }

  public destroy(): void {
    if (this.tray) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { globalShortcut } = require('electron');
        if (globalShortcut) {
          globalShortcut.unregister('CommandOrControl+Shift+Space');
        }
        this.tray.destroy();
      } catch {
        // Ignore
      }
      this.tray = null;
    }
  }
}
