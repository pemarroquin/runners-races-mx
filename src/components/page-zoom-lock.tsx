// Native no-op. There is no page-level pinch-zoom in a native app — the OS
// zooms the whole screen via Accessibility, never the view hierarchy — so
// there is nothing here to lock. See page-zoom-lock.web.tsx for the real
// implementation and the full reasoning; Metro resolves that file on web.
export function PageZoomLock() {
  return null;
}
