// The only bridge between the CelChat web app and the desktop shell. Deliberately tiny.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('celDesktop', {
  setBadge: (mentions, any) => ipcRenderer.send('cel:badge', Number(mentions) || 0, !!any),
  onCommand: (cb) => {
    const handler = (_e, cmd) => cb(cmd);
    ipcRenderer.on('cel:command', handler);
    return () => ipcRenderer.removeListener('cel:command', handler);
  },
  info: () => ipcRenderer.invoke('cel:info'),
});
