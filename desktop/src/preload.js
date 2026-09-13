const { contextBridge, ipcRenderer } = require('electron')

// The web app checks for this to swap the extension instructions for a native
// one-click connect (see AccountsPanel.jsx).
contextBridge.exposeInMainWorld('poe2desktop', {
  connectSession: () => ipcRenderer.invoke('poe-connect'),
})
