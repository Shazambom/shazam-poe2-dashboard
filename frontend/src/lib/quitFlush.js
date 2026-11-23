import { useStratStore } from './stratStore.js'
import { useWorkspace } from './workspaceStore.js'

// App quit (main's ws:flush): write the pending Trading-workspace and Strat-Calculator edits now. A write
// that fails is sent again at once, after each of these short waits; main lets the window go on
// ws:flushed or 1 s after asking, whichever comes first, so a write that keeps failing never holds it.
const QUIT_RETRY_MS = [100, 250]

// The stores whose write failed in one pass.
async function flushEdits() {
  const [, stratOk] = await Promise.all([useWorkspace.getState().flush(), useStratStore.getState().flush()])
  return { workspace: useWorkspace.getState().saveState === 'error', strat: stratOk === false }
}

// Resolves true once every pending edit is written, false when the retries are spent.
export async function flushForQuit() {
  let failed = await flushEdits()
  for (const ms of QUIT_RETRY_MS) {
    if (!failed.workspace && !failed.strat) return true
    await new Promise(resolve => { setTimeout(resolve, ms) })
    if (failed.strat) useStratStore.getState().resave()   // its failed write left nothing pending: queue the document again
    failed = await flushEdits()                           // the workspace re-sends while its save state is 'error'
  }
  return !failed.workspace && !failed.strat
}
