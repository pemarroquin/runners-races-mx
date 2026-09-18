// Refuses browser page-zoom, on the web.
//
// Reported 2026-09-18 (Pedro, iOS Safari, mid-run): "I was able to zoom in
// into the whole interface with the pause and stop button. and then it was
// hard to zoom out considering the map zooms in and out independently, i had
// to target the yellow circle and pinch out to zoom out."
//
// That is a trap, not a preference. Once the DOCUMENT is zoomed, every fixed
// overlay this app relies on is wrong — the tab pill, the pause/stop
// controls, the stat readout — and the obvious way out (pinch back) mostly
// does not work, because the thing under your fingers is a Mapbox canvas
// that consumes the pinch to zoom ITSELF. The only reliable undo was to find
// a scrap of non-map chrome (the Pause button) and pinch out on that.
//
// Why it happens on the Track tab specifically: mapbox-gl's own stylesheet
// already sets `touch-action: none` on `.mapboxgl-canvas-container`
// (node_modules/mapbox-gl/dist/mapbox-gl.css), so Safari never page-zooms a
// pinch that lands on the map. Everything React Native Web renders ON TOP of
// it — the control buttons, the timer, the tab bar — inherits no
// `touch-action` at all, so a pinch there is a plain document zoom. The
// full-screen map is what makes those overlays the only comfortable place to
// put your fingers.
//
// It is also what made the tab bar "randomly resize": react-native-web
// derives `useWindowDimensions()` from `visualViewport.width * .scale`, a
// product that stops matching the layout viewport once a page zoom is in
// play. See (tabs)/_layout.tsx's FloatingTabBar header — that bug is fixed
// there independently, by not measuring at all. This file removes the cause;
// that one removes the app's sensitivity to it. Both are wanted.
//
// TRADE-OFF, stated plainly: this also removes pinch-zoom as an
// accessibility affordance on every screen, including the race feed's text.
// It is deliberate and consistent with how this app already treats the
// browser as an app shell rather than a document (portrait-gate.web.tsx
// refuses landscape outright for the same reason). Text scaling set at the
// OS/browser level is untouched and still works; only the transient pinch
// gesture is refused. Revisit if the feed ever becomes a reading surface.
import { useEffect } from 'react';

export function PageZoomLock() {
  useEffect(() => {
    // 1. Double-tap zoom. `touch-action: manipulation` is the declarative,
    //    spec'd way to refuse it, and iOS Safari honours it (unlike
    //    `user-scalable=no` in the viewport meta, which Safari has ignored
    //    since iOS 10). Applied to the root elements rather than to every
    //    view, and harmless to Mapbox: its canvas container sets its own
    //    `touch-action` and a child's value wins over an ancestor's.
    const style = document.createElement('style');
    style.setAttribute('data-page-zoom-lock', '');
    style.textContent = 'html,body{touch-action:manipulation}';
    document.head.appendChild(style);

    // 2. Pinch zoom. `touch-action` cannot express "no pinch, but keep
    //    scrolling", so this uses WebKit's non-standard gesture events,
    //    which is the only thing that actually stops a Safari page zoom.
    //    Safe for the map: mapbox-gl registers ZERO gesture* handlers
    //    (grepped across dist/mapbox-gl.js and dist/mapbox-gl-dev.js) — it
    //    drives its own pinch from raw touch events — so cancelling these
    //    takes the page zoom away and leaves the map's zoom intact.
    //
    //    `passive: false` is not optional: listeners on document default to
    //    passive for touch-class events in Safari, and a passive listener's
    //    preventDefault() is ignored with only a console warning.
    const block = (e: Event) => e.preventDefault();
    const events = ['gesturestart', 'gesturechange', 'gestureend'] as const;
    for (const type of events) {
      document.addEventListener(type, block, { passive: false });
    }

    return () => {
      style.remove();
      for (const type of events) document.removeEventListener(type, block);
    };
  }, []);

  return null;
}
