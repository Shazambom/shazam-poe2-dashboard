// The application menu template, kept out of main.js so a test can pin it. Deliberately NO
// zoom roles: Electron's { role: 'viewMenu' } installs ⌘+/⌘−/⌘0, and since the embedded trade
// <webview> shares defaultSession with no partition, a pathofexile.com zoom persisted across
// restarts and leaked into the open-trade pop-out (the "UI zooms weirdly" bug). Zoom is pinned
// to 1 in main.js; this menu offers an explicit reset instead.
'use strict'

function buildMenuTemplate({ platform = process.platform, arbiter = [], resetTradeZoom = () => {} } = {}) {
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Arbiter', submenu: arbiter },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Reset trade window zoom', click: resetTradeZoom },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
}

module.exports = { buildMenuTemplate }
