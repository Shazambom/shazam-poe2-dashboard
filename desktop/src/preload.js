const { contextBridge, ipcRenderer } = require('electron')

// The web app checks for this to swap the extension instructions for a native
// one-click connect (see AccountsPanel.jsx).
contextBridge.exposeInMainWorld('poe2desktop', {
  connectSession: () => ipcRenderer.invoke('poe-connect'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  // Open the PoE login in the user's real browser (where Cloudflare + Steam work),
  // then they paste POESESSID back. Avoids embedding auth in the app.
  openLogin: () => ipcRenderer.invoke('open-login'),
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

  // Live-search engine (desktop-only). Renderer sends intents; main runs the WS + fetch
  // + teleport against the user's own logged-in session and pushes pings/state back.
  trade: {
    newSearch: (league) => ipcRenderer.invoke('trade:new-search', { league }),
    onWebviewNav: (cb) => { const h = (_e, url) => cb(url); ipcRenderer.on('trade:webview-nav', h); return () => ipcRenderer.removeListener('trade:webview-nav', h) },
    describe: (league, slug) => ipcRenderer.invoke('trade:describe', { league, slug }),
    startSearch: (itemId, league, slug, type) => ipcRenderer.invoke('trade:start-search', { itemId, league, slug, type }),
    stopSearch: (itemId) => ipcRenderer.invoke('trade:stop-search', { itemId }),
    engineState: () => ipcRenderer.invoke('trade:engine-state'),
    teleport: (token) => ipcRenderer.invoke('trade:teleport', { token }),
    onPing: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('trade:ping', h); return () => ipcRenderer.removeListener('trade:ping', h) },
    onEngineState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('trade:engine-state', h); return () => ipcRenderer.removeListener('trade:engine-state', h) },
    onSearchState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('trade:search-state', h); return () => ipcRenderer.removeListener('trade:search-state', h) },
    onEngineError: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('trade:engine-error', h); return () => ipcRenderer.removeListener('trade:engine-error', h) },
    onRateState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('trade:rate-state', h); return () => ipcRenderer.removeListener('trade:rate-state', h) },
    onFocusLive: (cb) => { const h = () => cb(); ipcRenderer.on('hotkey:focus-live', h); return () => ipcRenderer.removeListener('hotkey:focus-live', h) },
  },
  // Global focus hotkey config (desktop-only).
  hotkey: {
    get: () => ipcRenderer.invoke('hotkey:get'),
    set: (combo) => ipcRenderer.invoke('hotkey:set', combo),
  },
})
