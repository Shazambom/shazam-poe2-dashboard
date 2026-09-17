const { contextBridge, ipcRenderer } = require('electron')

// One subscribe helper: returns (cb) => unsubscribe for a main→renderer channel.
const sub = (ch) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h) }

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
  // OS notification via the main process (shows as Arbiter; click raises the window + echoes the tag).
  notify: (p) => ipcRenderer.invoke('notify', p),
  onNotifyClick: sub('notify:click'),
  // Seamless in-app auto-update: subscribe to status, trigger a check, install.
  onUpdate: sub('update:status'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getChannel: () => ipcRenderer.invoke('update:getChannel'),
  setChannel: (beta) => ipcRenderer.invoke('update:setChannel', beta),

  // Live-search engine (desktop-only). Renderer sends intents; main runs the WS + fetch
  // + teleport against the user's own logged-in session and pushes pings/state back.
  trade: {
    onWebviewNav: sub('trade:webview-nav'),
    startSearch: (itemId, league, slug, type) => ipcRenderer.invoke('trade:start-search', { itemId, league, slug, type }),
    stopSearch: (itemId) => ipcRenderer.invoke('trade:stop-search', { itemId }),
    teleport: (token) => ipcRenderer.invoke('trade:teleport', { token }),
    onPing: sub('trade:ping'),
    onEngineState: sub('trade:engine-state'),
    onSearchState: sub('trade:search-state'),   // per-search: live | auth | reconnecting | error
    onEngineError: sub('trade:engine-error'),   // budget / rate errors
    onFocusLive: sub('hotkey:focus-live'),
    // ExiledExchange2 History (batch 3): main pushes one IngestIntent per copied item; the renderer acks.
    onIngest: sub('trade:ingest'),
    ingestAck: (ack) => ipcRenderer.send('trade:ingest-ack', ack),
  },
  ws: { onFlush: sub('ws:flush'), flushed: () => ipcRenderer.send('ws:flushed'), exportFile: (name, text) => ipcRenderer.invoke('ws:export-file', { name, text }) },
  ee2: {
    setEnabled: (enabled) => ipcRenderer.send('ee2:set-enabled', { enabled }),
    status: () => ipcRenderer.invoke('ee2:status'),
  },
  // DEV ONLY (main refuses when packaged): push a fixture item through the real consumer + worker.
  dev: { ee2Item: (item) => ipcRenderer.invoke('dev:ee2-item', item) },
  // Batch 1 bridges. diag.log: the renderer's one narrow telemetry path (allow-listed markers,
  // clamped + budgeted in main, beta/dev-gated). clipboard.classify: main reads + classifies the
  // clipboard and returns ONLY the classification. ws: main asks for a flush before quitting.
  diag: { log: (marker, line) => ipcRenderer.invoke('diag:log', { marker, line }) },
  clipboard: { classify: () => ipcRenderer.invoke('clipboard:classify') },
  // Global focus hotkey config (desktop-only).
  hotkey: {
    get: () => ipcRenderer.invoke('hotkey:get'),
    set: (combo) => ipcRenderer.invoke('hotkey:set', combo),
  },
})
