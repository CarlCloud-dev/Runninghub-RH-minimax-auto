const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('ui', {
  winMin: () => ipcRenderer.invoke('ui:win-min'),
  winClose: () => ipcRenderer.invoke('ui:win-close'),
  pickDir: () => ipcRenderer.invoke('ui:pick-dir'),
  pathFor: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  api: (method, path, body) => ipcRenderer.invoke('ui:api', method, path, body),
  onLog: (fn) => ipcRenderer.on('log', (e, m) => fn(m)),
  onEvt: (fn) => ipcRenderer.on('evt', (e, m) => fn(m)),
});
