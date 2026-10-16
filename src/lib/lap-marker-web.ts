// The "+N laps" marker's DOM element for the web maps — the live Track map
// (track-map.web.tsx) and the session summary (fence-map.web.tsx) build it
// here so the two can't drift, same reason the silhouette itself lives in
// conquest-marker.ts.
//
// TWO elements, deliberately. The OUTER one is what mapboxgl.Marker owns: it
// gets the `.mapboxgl-marker` class (position:absolute; top/left 0) and
// Mapbox writes its `transform` on every camera frame to pin it to its
// coordinate. Nothing here may set `position` or `transform` on it — the
// summary's bubbles used to carry an inline `position:relative`, which beat
// the class, dropped the marker into normal document flow, and offset it by
// a fixed number of screen pixels from its coordinate. A fixed SCREEN offset
// is a different GROUND distance at every zoom, so the marker visibly slid
// across the route as the runner zoomed (reported 2026-10-15). The INNER
// `.lap-marker__body` is the one that animates, so its transforms compose
// with Mapbox's instead of overwriting them.
//
// Animation runs on element INSERTION (CSS animations start when the node
// enters the document), so "pop in" and "bump on a new lap" are just
// "render a body with the matching class" — no timers, no animationend
// bookkeeping, and nothing repaints the map.
import { LAP_MARKER, lapMarkerGeometry, lapMarkerHtml } from '@/lib/conquest-marker';

const STYLE_ID = 'lap-marker-style';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Sporty, not bouncy-cute: the bubble drops onto its point, squashes on
  // landing and settles — and a ring bursts out of the body like a lap
  // split going off. A new lap bumps the bubble and rolls the number up.
  // Every transform pivots on the TIP (set per element, since the tip's
  // offset depends on the bubble's width), so the point on the map never
  // moves while the bubble animates around it.
  style.textContent = `
@keyframes lap-marker-drop {
  0%   { transform: translateY(-18px) scale(0.2);      opacity: 0; }
  45%  { transform: translateY(0)     scale(1.16, 0.84); opacity: 1; }
  65%  { transform: translateY(0)     scale(0.94, 1.08); }
  82%  { transform: translateY(0)     scale(1.03, 0.97); }
  100% { transform: translateY(0)     scale(1);        opacity: 1; }
}
@keyframes lap-marker-bump {
  0%   { transform: scale(1); }
  30%  { transform: scale(1.24, 1.12); }
  60%  { transform: scale(0.95, 1.04); }
  100% { transform: scale(1); }
}
@keyframes lap-marker-burst {
  0%   { transform: scale(0.7); opacity: 0.9; }
  100% { transform: scale(2.3); opacity: 0;   }
}
@keyframes lap-marker-roll {
  0%   { transform: translateY(70%);  opacity: 0; }
  100% { transform: translateY(0);    opacity: 1; }
}
.lap-marker { line-height: 0; pointer-events: none; }
.lap-marker__body { position: relative; will-change: transform; }
.lap-marker__body--enter { animation: lap-marker-drop 620ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.lap-marker__body--bump  { animation: lap-marker-bump 520ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.lap-marker__burst {
  position: absolute; border-radius: 50%;
  border: 3px solid ${LAP_MARKER.ring};
  opacity: 0; pointer-events: none;
  animation: lap-marker-burst 760ms cubic-bezier(0.16, 1, 0.3, 1) 140ms both;
}
.lap-marker__count { overflow: hidden; }
.lap-marker__body--bump .lap-marker__count span {
  display: inline-block;
  animation: lap-marker-roll 360ms cubic-bezier(0.22, 1, 0.36, 1) 80ms both;
}
@media (prefers-reduced-motion: reduce) {
  .lap-marker__body--enter, .lap-marker__body--bump,
  .lap-marker__body--bump .lap-marker__count span { animation: none; }
  .lap-marker__burst { display: none; }
}`;
  document.head.appendChild(style);
}

function bodyHtml(laps: number, uid: string, mode: 'enter' | 'bump' | 'still'): string {
  const g = lapMarkerGeometry(laps);
  const cls = mode === 'still' ? '' : ` lap-marker__body--${mode}`;
  // The burst ring sits exactly over the body circle (box coords = silhouette
  // coords + bleed), so it reads as coming out of the bubble, not the box.
  const burst =
    mode === 'still'
      ? ''
      : `<span class="lap-marker__burst" style="left:${g.bleed + g.centerX - g.radius}px;` +
        `top:${g.bleed + g.centerY - g.radius}px;width:${g.diameter}px;height:${g.diameter}px;"></span>`;
  return (
    `<div class="lap-marker__body${cls}" style="width:${g.boxWidth}px;height:${g.boxHeight}px;` +
    `transform-origin:50% ${g.tipFromTop}px;">` +
    burst +
    lapMarkerHtml(laps, uid) +
    `</div>`
  );
}

/** The outer element to hand `new mapboxgl.Marker({ element, anchor: 'bottom',
 *  offset: [0, lapMarkerGeometry(laps).webOffsetY] })`. Pops in on insertion. */
export function createLapMarkerElement(laps: number, label: string, uid: string): HTMLDivElement {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'lap-marker';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.dataset.laps = String(laps);
  el.innerHTML = bodyHtml(laps, uid, 'enter');
  return el;
}

/** Re-render for a new count. Bumps only when the count actually went UP —
 *  a re-render with the same number (a label change on a language toggle)
 *  must not replay the celebration. Returns whether the bubble's size
 *  changed, i.e. whether the caller has to re-apply the marker's offset
 *  (the tip moves when "+9" becomes "+10" and the body widens). */
export function updateLapMarkerElement(
  el: HTMLElement,
  laps: number,
  label: string,
  uid: string,
): boolean {
  el.setAttribute('aria-label', label);
  const prev = Number(el.dataset.laps);
  if (prev === laps) return false;
  el.dataset.laps = String(laps);
  el.innerHTML = bodyHtml(laps, uid, laps > prev ? 'bump' : 'still');
  return lapMarkerGeometry(prev).webOffsetY !== lapMarkerGeometry(laps).webOffsetY;
}
