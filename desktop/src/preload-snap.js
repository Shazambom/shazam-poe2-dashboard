// Preload for the hidden feedback snap window (feedback/snap.js). READ-ONLY bridge: the app renders
// as the desktop app (version, channel, hotkey label, EE2 status) and nothing else is reachable —
// no engine, no writer of any kind (desktop/test/feedback-contract.test.mjs pins the list).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('poe2desktop', {
  getVersion: () => ipcRenderer.invoke('app-version'),
  getChannel: () => ipcRenderer.invoke('update:getChannel'),
  hotkey: { get: () => ipcRenderer.invoke('hotkey:get') },
  ee2: { status: () => ipcRenderer.invoke('ee2:status') },
})
