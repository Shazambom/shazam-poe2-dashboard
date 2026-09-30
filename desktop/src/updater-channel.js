// Point electron-updater at the beta or the stable feed. Setting `channel` makes electron-updater
// allow downgrades, and on the beta channel the newest semver tag right after a stable ship is the
// previous beta, so a stable user who opted into beta was offered an OLDER build (audit 2026-09-29).
// Downgrades are switched back off every time. Returns whether the beta feed is in use.
function applyChannel(au, beta) {
  au.allowPrerelease = beta
  au.channel = beta ? 'beta' : 'latest'
  au.allowDowngrade = false
  return beta
}

module.exports = { applyChannel }
