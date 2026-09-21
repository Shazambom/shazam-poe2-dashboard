// Hold's forecast as a direction + strength, from the backend's `pred_arrows`: +1..+3 up (green),
// -1..-3 down (red), 0 (a weak forecast) or none = a quiet dash.
export function arrowCell(code) {
  if (!code) return { text: '–', cls: 'muted' }
  return code > 0 ? { text: '↑'.repeat(code), cls: 'gain' } : { text: '↓'.repeat(-code), cls: 'loss' }
}
