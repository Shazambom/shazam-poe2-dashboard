// Best-effort failures stay in the local developer console. Log only the operation,
// since errors from a request or desktop bridge can include private user data.
export function ignoredError(operation) {
  try {
    console.debug('[Arbiter]', operation)
  } catch {
    // The host console itself may be unavailable during teardown.
    return
  }
}
