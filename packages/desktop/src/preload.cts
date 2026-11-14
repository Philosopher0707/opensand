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

  // Verify origin: publish the bridge only to the app's own local-server origin.
  let isAllowed = false;
  try {
    isAllowed = Boolean(ipcRenderer.sendSync('opensand:isAllowedOrigin'));
  } catch {
    const locOrigin = window?.location?.origin || '';
    isAllowed = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(locOrigin);
  }

  if (isAllowed && contextBridge && ipcRenderer) {
    contextBridge.exposeInMainWorld('opensand', {
      sendQuery: (query: string, sessionId?: string, agentId?: string) =>
        ipcRenderer.invoke('opensand:sendQuery', { query, sessionId, agentId }),
      approveTool: (approvalId: string, decision: any) =>
        ipcRenderer.invoke('opensand:approveTool', { approvalId, decision }),
      listPendingApprovals: () =>
        ipcRenderer.invoke('opensand:listPendingApprovals'),
      getToolDiscovery: () =>
        ipcRenderer.invoke('opensand:getToolDiscovery'),
      cancelTurn: () =>
        ipcRenderer.invoke('opensand:cancelTurn'),
      getSessions: () =>
        ipcRenderer.invoke('opensand:getSessions'),
      listMissions: () =>
        ipcRenderer.invoke('opensand:listMissions'),
      getMissionTimeline: (missionId: string) =>
        ipcRenderer.invoke('opensand:getMissionTimeline', { missionId }),
      getMissionReceipt: (missionId: string) =>
        ipcRenderer.invoke('opensand:getMissionReceipt', { missionId }),
      getMissionFileDiff: (missionId: string, fileIndex: number) =>
        ipcRenderer.invoke('opensand:getMissionFileDiff', { missionId, fileIndex }),
      loadSession: (sessionId: string) =>
        ipcRenderer.invoke('opensand:loadSession', { sessionId }),
      deleteSession: (sessionId: string) =>
        ipcRenderer.invoke('opensand:deleteSession', { sessionId }),
      clearAllSessions: () =>
        ipcRenderer.invoke('opensand:clearAllSessions'),
      deleteAgent: (id: string) =>
        ipcRenderer.invoke('opensand:deleteAgent', { id }),
      getSettings: () =>
        ipcRenderer.invoke('opensand:getSettings'),
      updateSettings: (settings: any) =>
        ipcRenderer.invoke('opensand:updateSettings', settings),
      getTokenTelemetry: (agentId?: string, sessionId?: string) =>
        ipcRenderer.invoke('opensand:getTokenTelemetry', { agentId, sessionId }),
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
