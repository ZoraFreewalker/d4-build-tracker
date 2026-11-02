const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  // overlay / detail
  onUpdate: cb => ipcRenderer.on('update', (_e, data) => cb(data)),
  onBuild: cb => ipcRenderer.on('build', (_e, data) => cb(data)),
  onToast: cb => ipcRenderer.on('toast', (_e, data) => cb(data)),
  // hidden capture window
  onCaptureStart: cb => ipcRenderer.on('capture-start', (_e, data) => cb(data)),
  onCaptureStop: cb => ipcRenderer.on('capture-stop', () => cb()),
  onGrab: cb => ipcRenderer.on('grab', (_e, data) => cb(data)),
  grabResult: (id, bytes) => ipcRenderer.send('grab-result', id, bytes),
  rects: list => ipcRenderer.send('rects', list.map(r => ({ x: +r.x, y: +r.y, width: +r.width, height: +r.height }))),
  setPhase: name => ipcRenderer.send('phase', String(name)),
  dragStart: mode => ipcRenderer.send('drag-start', mode),
  dragEnd: () => ipcRenderer.send('drag-end'),
  openControl: () => ipcRenderer.send('open-control'),
  toggleDetail: () => ipcRenderer.send('toggle-detail'),
  exclusiveOff: () => ipcRenderer.send('exclusive-off'),
  // control window
  library: () => ipcRenderer.invoke('library'),
  importBuild: link => ipcRenderer.invoke('import', String(link)),
  activate: id => ipcRenderer.invoke('activate', String(id)),
  remove: id => ipcRenderer.invoke('remove', String(id)),
  settings: change => ipcRenderer.invoke('settings', change),
  resetProgress: () => ipcRenderer.invoke('reset-progress'),
  openDebug: () => ipcRenderer.invoke('open-debug'),
  debugReport: () => ipcRenderer.invoke('debug-report'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateReady: cb => ipcRenderer.on('update-ready', (_e, v) => cb(v)),
});
