const { contextBridge, ipcRenderer } = require('electron')

// The web app checks for this to swap the extension instructions for a native
// one-click connect (see AccountsPanel.jsx).
contextBridge.exposeInMainWorld('poe2desktop', {
  connectSession: () => ipcRenderer.invoke('poe-connect'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  // Write a pasted POESESSID into the app's Electron session so the embedded
  // Trade webview is logged in too (paste otherwise only reaches the backend).
  setCookie: (cookie) => ipcRenderer.invoke('poe-set-cookie', cookie),
  // Open a trade-site search in a real logged-in window (shares our PoE session,
  // so live search + whispering work). Several can be open at once.
  openTrade: (url) => ipcRenderer.invoke('open-trade', url),
  // Seamless in-app auto-update: subscribe to status, trigger a check, install.
  onUpdate: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('update:status', h); return () => ipcRenderer.removeListener('update:status', h) },
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
})
