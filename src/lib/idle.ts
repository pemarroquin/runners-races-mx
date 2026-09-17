// Defers non-critical startup work (fetches nothing on the current screen
// needs immediately) off the critical rendering path — used by
// races-provider.tsx and region-context.tsx, both of which fire a network
// request the instant the app mounts regardless of which tab is active.
//
// `requestIdleCallback` doesn't exist on React Native's JS runtime (Hermes)
// — it's a browser-only API — so this checks for it rather than assuming
// web. Native keeps the immediate-ish `setTimeout(fn, 0)` behavior these two
// callers already had; only web gets pushed to genuine browser idle time.
//
// Why this exists: PageSpeed Insights' default scoring mode was measured
// (2026-09-17) to produce a wildly inconsistent Largest Contentful Paint
// specifically when many concurrent cross-origin requests fire in the first
// ~1s of a page load (this app's Track tab already fires off a dozen-plus
// Mapbox tile/style/glyph requests in that window) — a local-server test
// with the SAME code but none of that network complexity never showed the
// issue, isolating it to request fan-out, not anything CPU-bound. Spacing
// these two requests (races.json, ipapi.co) out from that initial burst is
// a genuine best practice regardless of what it does to any one scoring
// tool; it just happens to be the most promising lever left for that too.
export function deferToIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn);
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
}
