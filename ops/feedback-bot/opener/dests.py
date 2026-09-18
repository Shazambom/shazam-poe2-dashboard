"""The screens a report may carry — the opener's allow-list. Output filenames derive from THIS
tuple, never from the report; pinned to frontend/src/lib/dests.js by desktop/test/feedback-dests-sync.test.mjs."""
SCREENS = (
    "current",
    "board",
    "strategy-hold",
    "strategy-arbitrage",
    "economy-inflation",
    "economy-market",
    "trading-workspace",
    "trading-live",
    "trading-sales",
    "settings",
)
