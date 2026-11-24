/**
 * OpenSand Electron Preload Script
 * Secure IPC bridge conforming to contextIsolation: true and sandbox: true
 */

let electron: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  electron = require('electron');
} catch (cause) {
  throw new Error('OpenSand secure bridge unavailable: Electron preload APIs could not be loaded.', { cause });
}

const { contextBridge, ipcRenderer } = electron;
if (!contextBridge || !ipcRenderer) {
  throw new Error('OpenSand secure bridge unavailable: Electron preload APIs are missing.');
}

// Only the main process can authorize the exact app origin. Never guess from window.location.
let isAllowed = false;
try {
  isAllowed = ipcRenderer.sendSync('opensand:isAllowedOrigin') === true;
} catch (cause) {
  throw new Error('OpenSand secure bridge unavailable: could not verify the renderer origin.', { cause });
}
if (!isAllowed) {
  throw new Error('OpenSand secure bridge unavailable: refusing to expose the OpenSand bridge to this origin.');
}

try {
  contextBridge.exposeInMainWorld("api", {
    engines: {
      detect: () => ipcRenderer.invoke("engines:detect"),
    },
  });
} catch (cause) {
  throw new Error('OpenSand secure bridge unavailable: failed to expose the OpenSand desktop bridge.', { cause });
}

contextBridge.exposeInMainWorld('opensand', {
  sendQuery: (query: string, sessionId?: string, agentId?: string) =>
    ipcRenderer.invoke('opensand:sendQuery', { query, sessionId, agentId }),
  approveTool: (approvalId: string, decision: any) =>
    ipcRenderer.invoke('opensand:approveTool', { approvalId, decision }),
  listPendingApprovals: () =>
    ipcRenderer.invoke('opensand:listPendingApprovals'),
  getToolDiscovery: () =>
    ipcRenderer.invoke('opensand:getToolDiscovery'),
  detectEngines: () =>
    ipcRenderer.invoke('engines:detect'),
  engines: {
    detect: () => ipcRenderer.invoke('engines:detect'),
  },
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
  previewRestoreMissionSnapshot: (missionId: string, snapshot: string) =>
    ipcRenderer.invoke('opensand:previewRestoreMissionSnapshot', { missionId, snapshot }),
  restoreMissionSnapshot: (missionId: string, snapshot: string) =>
    ipcRenderer.invoke('opensand:restoreMissionSnapshot', { missionId, snapshot }),
  forkMission: (missionId: string, snapshot: string | number, options?: { newTitle?: string; newInstruction?: string }) =>
    ipcRenderer.invoke('opensand:forkMission', { missionId, snapshot, ...options }),
  readWorkspaceFile: (path: string) =>
    ipcRenderer.invoke('opensand:readWorkspaceFile', { path }),
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
  onOpenSettings: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('opensand:openSettings', handler);
    return () => {
      ipcRenderer.removeListener('opensand:openSettings', handler);
    };
  },
});
