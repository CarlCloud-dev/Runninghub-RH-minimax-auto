// 画布窗口 preload：给注入的标题栏提供「隐藏窗口」能力
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__rhui', {
  hide: () => ipcRenderer.invoke('ui:win-hide'),
});
