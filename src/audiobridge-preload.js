// Ponte da janela invisível do "fone pelo celular" com o main (ver lib/audiobridge.js)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  ready: () => ipcRenderer.send('bridge-ready'),
  onSignal: (cb) => ipcRenderer.on('bridge-signal', (_, m) => cb(m)),
  signal: (m) => ipcRenderer.send('bridge-signal', m),
  pcm: (data) => ipcRenderer.send('bridge-pcm', data),
  state: (s) => ipcRenderer.send('bridge-state', s),
});
