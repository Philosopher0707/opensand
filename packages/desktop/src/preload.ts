/**
 * OpenSand Electron Preload Script
 * Secure IPC bridge conforming to contextIsolation: true and sandbox: true
 */

// If running inside Electron, ipcRenderer and contextBridge will be available
// For headless/test environments, fallback to mock bridge
declare const window: any;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { contextBridge, ipcRenderer } = require('electron');

  if (contextBridge && ipcRenderer) {
    contextBridge.exposeInMainWorld('opensand', {
      sendQuery: (query: string, sessionId?: string) =>
        ipcRenderer.invoke('opensand:sendQuery', { query, sessionId }),
      approveTool: (approvalId: string, decision: any) =>
        ipcRenderer.invoke('opensand:approveTool', { approvalId, decision }),
      getSessions: () =>
        ipcRenderer.invoke('opensand:getSessions'),
      loadSession: (sessionId: string) =>
        ipcRenderer.invoke('opensand:loadSession', { sessionId }),
      getSettings: () =>
        ipcRenderer.invoke('opensand:getSettings'),
      updateSettings: (settings: any) =>
        ipcRenderer.invoke('opensand:updateSettings', settings),
      onEvent: (callback: (event: any) => void) => {
        const handler = (_: any, event: any) => callback(event);
        ipcRenderer.on('opensand:event', handler);
        return () => {
          ipcRenderer.removeListener('opensand:event', handler);
        };
      },
    });
  }
} catch {
  // Not running inside Electron environment (e.g. headless or tests)
}
