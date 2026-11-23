type DesktopCall<Args extends unknown[] = [], Result = unknown> = (...args: Args) => Promise<Result>
type DesktopSubscription = (listener: (event: unknown) => void) => () => void

interface Window {
  poe2desktop?: {
    connectSession: DesktopCall<[], { ok: boolean; message: string }>
    getVersion: DesktopCall<[], string>
    openLogin: DesktopCall
    setCookie: DesktopCall<[string]>
    openTrade: DesktopCall<[string]>
    notify: DesktopCall<[unknown]>
    onNotifyClick: DesktopSubscription
    onUpdate: DesktopSubscription
    checkUpdate: DesktopCall
    installUpdate: DesktopCall
    getChannel: DesktopCall
    setChannel: DesktopCall<[boolean]>
    setTheme: DesktopCall<[string, string?]>
    trade: {
      onWebviewNav: DesktopSubscription
      onTap: DesktopSubscription
      listings: DesktopCall<[unknown]>
      recheck: DesktopCall<[unknown]>
      relax: DesktopCall<[unknown]>
      relaxCancel: DesktopCall
      listingsCancel: DesktopCall
      startSearch: DesktopCall<[string, string, string, string]>
      stopSearch: DesktopCall<[string]>
      modLookup: DesktopCall<[unknown]>
      modItem: DesktopCall
      teleport: DesktopCall<[string]>
      uniques: DesktopCall
      priceQuery: DesktopCall<[unknown]>
      onPing: DesktopSubscription
      onEngineState: DesktopSubscription
      onSearchState: DesktopSubscription
      onEngineError: DesktopSubscription
      onFocusLive: DesktopSubscription
      onIngest: DesktopSubscription
      ingestAck: (ack: unknown) => void
    }
    ws: { onFlush: DesktopSubscription; flushed: () => void; exportFile: DesktopCall<[string, string]> }
    sales: { fetch: DesktopCall<[string]> }
    merchant: { fetch: DesktopCall<[unknown]>; priceCheck: DesktopCall<[unknown]>; cancel: DesktopCall<[unknown?]> }
    ee2: { setEnabled: (enabled: boolean) => void; setSearchPrefs: (prefs: unknown) => void; status: DesktopCall }
    clientLog: { onEvent: DesktopSubscription; onStatus: DesktopSubscription; status: DesktopCall }
    dev: { ee2Item: DesktopCall<[unknown]>; clientLogLine: DesktopCall<[string]> }
    diag: { log: DesktopCall<[string, string]> }
    clipboard: { classify: DesktopCall }
    feedback: { package: DesktopCall; drag: DesktopCall<[string]>; reveal: DesktopCall<[string]>; discord: DesktopCall }
    hotkey: { get: DesktopCall; set: DesktopCall<[string]> }
  }
}
