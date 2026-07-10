const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  indexFolder: (folder) => ipcRenderer.invoke('index-folder', folder),
  previewSampleUrl: (filePath) => ipcRenderer.invoke('preview-sample-url', filePath),
  removeTmpFile: (url) => ipcRenderer.invoke('remove-tmp-file', url),
  startDragFile: (filePath) => ipcRenderer.invoke('start-drag-file', filePath),
  openItemInExplorer: (filePath) => ipcRenderer.invoke('open-in-explorer', filePath),
  openInBrowser: (filePath) => ipcRenderer.invoke('open-in-browser', filePath),
  openLastInAimp: (filePath) => ipcRenderer.invoke('open-last-in-aimp', filePath),
  onIndexProgress: (callback) => ipcRenderer.on('index-progress', (_event, data) => callback(data)),
  onIndexError: (callback) => ipcRenderer.on('index-error', (_event, data) => callback(data)),
  onZoomIn: (callback) => ipcRenderer.on('zoom-in', () => callback()),
  onZoomOut: (callback) => ipcRenderer.on('zoom-out', () => callback()),
  onZoomReset: (callback) => ipcRenderer.on('zoom-reset', () => callback()),
  onToggleFade: (callback) => ipcRenderer.on('toggle-fade', () => callback()),
  onToggleLoop: (callback) => ipcRenderer.on('toggle-loop', () => callback()),
});
