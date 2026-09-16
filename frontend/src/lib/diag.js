// Renderer-side diagnostics: a no-op on web, and on desktop a call into main's narrow diag bridge
// (marker allow-list ee2 | ws | sales, clamped, budgeted, beta/dev-gated there). Lines carry
// names, counts and byte lengths only — never a query, raw clipboard text or a full slug.
export const diag = (marker, line) => { try { window.poe2desktop?.diag?.log(marker, line) } catch {} }
