// Track tab map — WEB. A real Mapbox GL JS map once a session starts; a
// static Mapbox image (buildPinMapUrl, same helper the native file's own
// pre-MapView version used) before that — see the boot effect below for why
// GL doesn't load until the runner taps Start.
//
// The custom Studio style is GL-only because of a hard API limit, not
// preference: the Static Images API cannot render Mapbox Standard styles
// (the `imports`-based kind Studio creates by default) — it returns a blank
// image, no error. GL JS renders them fine. See constants/map.ts.
//
// GL JS also buys what a baked PNG structurally cannot: a gradient route
// line, an extruded 3D fence, and a camera that moves — all things a session
// in progress needs and the idle screen doesn't.
//
// mapbox-gl is loaded by dynamic import and its CSS by a runtime <link>, both
// copied from route-map.web.tsx — see that file's header for why the CSS
// cannot be a JS import (Metro hoists every CSS module into one global,
// render-blocking stylesheet regardless of the import being dynamic).
//
// Every custom layer sets a `slot` and `*-emissive-strength` — see
// constants/map.ts's MAP_SLOT_ROUTE / MAP_SLOT_FILL / EMISSIVE_STRENGTH_FULL.
// Standard shades custom layers by the style's own light preset like any
// basemap layer (this style's Standard import sets lightPreset: 'night'),
// which is why every route/wall colour used to render at roughly a third of
// its intended brightness (P3 §7a).
//
// There is exactly ONE traced line on this map: ROUTE_SRC (plus its blurred
// glow twin), fed the WHOLE recorded path — every leg (see gap-policy.ts's
// splitLegs), not just its newest one. There used to be a second pair — an
// enclosure fill and its gradient rim, built by buildFence() over the whole
// growing path. buildFence AUTO-CLOSES the path into a ring, so drawing that
// ring's boundary as a LineString put three artefacts on screen at once
// (reported with screenshots 2026-09-08):
//   1. a straight chord from the runner's live position back to the start,
//      cutting across ground nobody ran (through the middle of a park);
//   2. what looked like a duplicated route — the ring traces the path
//      itself, so an out-and-back drew BOTH its sides alongside ROUTE_SRC,
//      three parallel lines for one run;
//   3. a fill shading the enclosed area as claimed, which under the tile
//      coverage model it is not.
// Territory is the H3 tile footprint (TILES_SRC/WALL_SRC), never an
// enclosure — see gap-policy.ts. Both the native track map and the saved-run
// summary (fence-map.web.tsx) already draw tiles only; this brings the web
// track map to parity. Do not reintroduce an enclosure outline here.
//
// ROUTE_SRC used to be fed only the trailing FENCE_LAG_M metres
// (fence-3d.ts's splitTrailing), from back when everything older "set" into
// a wall built along the path. That wall is long gone (replaced by the tile
// footprint above), but the trailing-only feed was never removed with it —
// so the vibrant line only ever showed roughly the last 100m of a run, and
// everything behind that had NOTHING drawn for it at all, not even the flat
// colour it used to fade into. Reported 2026-09-16: the tile fill still
// showed the whole run as claimed ground, which is why this went unnoticed
// for as long as it did. Fixed by feeding every leg's full length, same
// FeatureCollection-of-legs shape fence-map.web.tsx's summary route already
// uses (and already proven to keep lineMetrics' per-feature line-progress
// correct — see that file's own header). fence-3d.ts/splitTrailing/
// FENCE_LAG_M are deleted, not just unused: nothing on either platform reads
// them any more.
//
// One thing animates continuously while a session is live, so the map
// doesn't read as flat/static even when the runner is standing still: the
// route line flows ROUTE_GRADIENT along its own length via gradient-flow.ts
// — now the WHOLE route, not just its trailing edge. It's a plain
// setInterval timer, not a requestAnimationFrame loop — see the pulse-dot
// comment below.
import { cellsToMultiPolygon } from 'h3-js';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import type { GeoJSONSource, Map as MapboxMap, Marker } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import type { Feature, FeatureCollection } from 'geojson';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Spacing } from '@/constants/theme';
import {
  AUTO_RETURN_IDLE_MS,
  type CameraMode,
  EMISSIVE_STRENGTH_FULL,
  FENCE_RISE_MS,
  FENCE_SHIMMER_STEP_MS,
  FENCE_WALL_COLOR,
  FENCE_WALL_HEIGHT_M,
  FENCE_WALL_OPACITY,
  FOLLOW_OFFSET_RATIO,
  MAP_DEFAULT_ZOOM,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  MAX_BEARING_STEP_DEG,
  MIN_BEARING_SEPARATION_M,
  OVERVIEW_FIT_PADDING_PX,
  ROUTE_GLOW_BLUR,
  ROUTE_GLOW_OPACITY,
  ROUTE_GLOW_WIDTH,
  ROUTE_GRADIENT,
  ROUTE_GRADIENT_COLORS,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  SESSION_FLY_MS,
  SESSION_PITCH,
  SESSION_ZOOM,
  START_MARKER_COLOR,
  TILE_FILL_OPACITY,
  ZOOM_STEP,
} from '@/constants/map';
import {
  bearingFromPath,
  boundsOfPath,
  followOffsetPx,
  overviewPadding,
  smoothBearing,
  type ChromeInsets,
} from '@/lib/camera';
import { splitLegs, type TimedPoint } from '@/lib/gap-policy';
import { lineGradientExpression } from '@/lib/fence-draw';
import { startGradientFlow } from '@/lib/gradient-flow';
import { buildPinMapUrl } from '@/lib/mapbox';
import { useRegion } from '@/lib/region-context';
import { type LatLng } from '@/lib/territory';


/** No chrome over the map — the old behaviour, and what a caller that
 *  passes no insets gets. Module-level so the identity is stable and the
 *  mirroring effect below doesn't re-run every render. */
const NO_CHROME: ChromeInsets = { top: 0, bottom: 0 };

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const ROUTE_SRC = 'run-route';
const WALL_SRC = 'run-wall';
const TILES_SRC = 'run-tiles';
const ENCLOSED_SRC = 'run-enclosed';
const PULSE_STYLE_ID = 'track-pulse-style';

/**
 * The claimed cells as ONE dissolved shape, not one polygon per hexagon.
 *
 * cellsToMultiPolygon merges the set and returns its outline(s), holes and
 * all — the same call enclosure.ts uses to find enclosed ground, so the two
 * can never disagree about where the boundary is.
 *
 * Why it matters here: enclosure changed the scale of this. A run used to
 * claim a few hundred cells along its path; a 10 km loop now claims ~25,900,
 * and handing Mapbox 25,900 separate polygons every recompute is a lot of
 * geometry for a shape that is visually one region. Dissolving also removes
 * the internal edges, so the territory reads as one area rather than a
 * quilt.
 *
 * The rings come back GeoJSON-wound ([lng, lat]) and already closed, which
 * is why this no longer repeats the first point the way the per-hexagon
 * version had to.
 */
function tileFeatureCollection(cells: string[]): FeatureCollection {
  if (cells.length === 0) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: cellsToMultiPolygon(cells, true).map(
      (rings): Feature => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: rings },
      }),
    ),
  };
}


/**
 * Adds every custom source/layer a session needs (route, wall, tile fill,
 * enclosed shimmer) — called from the boot effect's `load` handler, right
 * after `new mapboxgl.Map()` first loads MAP_STYLE_GL. The map only ever
 * boots on that one style now (no idle style to swap out of first — see the
 * boot effect's own header), so this always runs exactly once per map.
 *
 * Pure function of `map` — everything else it touches is either a module
 * constant or a small immutable literal, so this needs no closure over
 * component state.
 */
function setupSessionLayers(map: MapboxMap): void {
  // lineMetrics is REQUIRED for line-gradient. Without it the paint
  // property is ignored silently and the line renders flat — which
  // looks like a styling mistake rather than a missing source option.
  map.addSource(ROUTE_SRC, {
    type: 'geojson',
    lineMetrics: true,
    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
  });
  map.addSource(WALL_SRC, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // Tile Coverage brief §6 step 4 — this session's live tile fill, fed
  // by the `tiles` prop's own effect below (NOT the points-driven
  // effect that owns ROUTE_SRC — index.tsx already throttles the prop,
  // so this source just renders whatever it's handed).
  map.addSource(TILES_SRC, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // Ground captured by closing a loop around it, as its own source so
  // it can carry the conquered shimmer — see the `enclosedTiles` prop.
  map.addSource(ENCLOSED_SRC, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: `${ROUTE_SRC}-glow`,
    type: 'line',
    source: ROUTE_SRC,
    slot: MAP_SLOT_ROUTE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_LINE_COLOR,
      'line-width': ROUTE_GLOW_WIDTH,
      'line-blur': ROUTE_GLOW_BLUR,
      'line-opacity': ROUTE_GLOW_OPACITY,
      'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
    },
  });
  map.addLayer({
    id: ROUTE_SRC,
    type: 'line',
    source: ROUTE_SRC,
    slot: MAP_SLOT_ROUTE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ROUTE_LINE_WIDTH,
      // Fallback for if line-gradient is ever rejected (unsupported
      // source, dropped lineMetrics, etc.) — Mapbox's default
      // line-color is #000000, and without this a rejected gradient
      // silently renders pure black instead of failing loudly. Never
      // fires today (the gradient renders — confirmed on device), but
      // costs nothing and matches the fix applied to the summary
      // outline below, which WAS silently falling back to black.
      'line-color': ROUTE_GRADIENT[0][1],
      // The static ramp is only what the line looks like BEFORE a
      // session arms the flow below — mid-run this property is
      // repainted every ROUTE_GRADIENT_FRAME_MS.
      'line-gradient': lineGradientExpression(),
      'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
    },
  });

  // Tile Coverage brief §6 step 4/§5 — below everything else in
  // MAP_SLOT_FILL (added first, so it's the bottom-most fill layer)
  // so the wall/enclosure-fill scene-dressing above still reads as
  // distinct edges/rise on top of the real claimed-ground fill.
  map.addLayer({
    id: TILES_SRC,
    type: 'fill',
    source: TILES_SRC,
    slot: MAP_SLOT_FILL,
    paint: {
      // Default colour at mount, same as WALL_SRC below —
      // this component persists across sessions (it's not remounted
      // per-run), so the real per-run colour is applied by the
      // fenceColor-sync effect, not baked in here.
      'fill-color': FENCE_WALL_COLOR,
      'fill-opacity': TILE_FILL_OPACITY,
      'fill-emissive-strength': EMISSIVE_STRENGTH_FULL,
    },
  });

  // Conquered ground. Same slot and opacity as TILES_SRC above and
  // added right after it, so the two fills sit at the same depth and
  // read as one continuous territory — what separates them is COLOUR,
  // not stacking: this one sweeps the ROUTE_GRADIENT wheel while the
  // run-over ground holds the run's own identity colour.
  //
  // `fill-color-transition` is where the shimmer's smoothness comes
  // from. The interval below only advances the hue one step every
  // FENCE_SHIMMER_STEP_MS; GL interpolates between each pair on the
  // GPU. That is the whole reason this can be a 2.2s timer instead of
  // a requestAnimationFrame loop — see the pulse-dot comment above
  // for why a per-frame map repaint is the specific trap here.
  //
  // Mapbox has no positional gradient for fills at all (only lines
  // take `line-gradient`), so a fill can only sweep the wheel through
  // TIME. Same technique, same constant, as a saved territory's
  // shimmer in territories-map.web.tsx — deliberately, so the live
  // capture and the saved territory it becomes read as the same thing.
  map.addLayer({
    id: ENCLOSED_SRC,
    type: 'fill',
    source: ENCLOSED_SRC,
    slot: MAP_SLOT_FILL,
    paint: {
      'fill-color': ROUTE_GRADIENT_COLORS[0],
      'fill-color-transition': { duration: FENCE_SHIMMER_STEP_MS, delay: 0 },
      'fill-opacity': TILE_FILL_OPACITY,
      'fill-emissive-strength': EMISSIVE_STRENGTH_FULL,
    },
  });

  // The fence. Height is animated per-feature via a paint transition
  // rather than a rAF loop: GL interpolates fill-extrusion-height on
  // the GPU, so the rise costs nothing on the main thread.
  map.addLayer({
    id: WALL_SRC,
    type: 'fill-extrusion',
    source: WALL_SRC,
    slot: MAP_SLOT_FILL,
    paint: {
      'fill-extrusion-color': FENCE_WALL_COLOR,
      'fill-extrusion-opacity': FENCE_WALL_OPACITY,
      'fill-extrusion-height': FENCE_WALL_HEIGHT_M,
      'fill-extrusion-base': 0,
      'fill-extrusion-height-transition': { duration: FENCE_RISE_MS, delay: 0 },
      'fill-extrusion-emissive-strength': EMISSIVE_STRENGTH_FULL,
    },
  });
}

interface TrackMapProps {
  /** The recorded path. Timestamped, and that is load-bearing: the gap caps
   *  that decide where this path must NOT be drawn as a continuous line are
   *  a function of elapsed time as well as distance (see splitLegs). A plain
   *  LatLng[] here is what let the route render straight across an
   *  unrecorded background gap. */
  points: TimedPoint[];
  running: boolean;
  /** A real fix, or null. Never a fallback — see use-current-location.ts. */
  here: LatLng | null;
  /** Pixels of app chrome drawn OVER the map (live stats block up top, the
   *  floating tab bar at the bottom). The camera frames against the band
   *  these leave visible rather than the whole container — see
   *  camera.ts's visibleBand. Optional: omitted means "nothing covers the
   *  map", which is the old behaviour. */
  chromeInsets?: ChromeInsets;
  /** True once a session is live: drives the fly-in and the 3D framing. */
  active: boolean;
  /** This run's fence colour ('#rrggbb') — see FENCE_COLOR_SETS. */
  fenceColor: string;
  /** Tile Coverage brief §6 step 4 — this session's live covered H3 cells,
   *  computed and throttled in index.tsx and passed down ready to render.
   *  Rendered via its OWN effect, deliberately separate from the
   *  points-driven effect that owns ROUTE_SRC/the camera — see this
   *  component's own report note on why that effect was left untouched
   *  rather than folding this in. */
  tiles: string[];
  /** The cells claimed by CLOSING A LOOP around them rather than by being
   *  run over — enclosure.ts's enclosedCells, computed and throttled in
   *  index.tsx alongside `tiles`, and disjoint from it.
   *
   *  Its own prop, and its own layer, because it gets its own treatment:
   *  captured ground shimmers through the gradient wheel to mark it as
   *  conquered while run-over ground holds the run's solid identity colour
   *  (Pedro's ask, 2026-09-08). Disjoint matters — the two fills are
   *  siblings, not stacked, so neither region ever blends two translucent
   *  fills and reads muddier than the other. */
  enclosedTiles: string[];
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  unavailable: string;
  /** Accessibility labels for the camera controls (Task D / P4) — passed in
   *  pre-translated, matching every other string on this component.
   *  recenterLabel is shown while in overview mode (tapping switches to
   *  follow); overviewLabel is shown while in follow mode (tapping switches
   *  to overview) — the single control cycles between the two modes. */
  zoomInLabel: string;
  zoomOutLabel: string;
  recenterLabel: string;
  overviewLabel: string;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

// The "you are here" pulse, plus the static start-pin style below it (one
// injected stylesheet for both DOM markers this file creates). The pulse is
// a keyframed DOM element rather than a GL layer: GL has no repeating
// animation primitive, so driving one would mean a requestAnimationFrame
// loop repainting the map every frame for the whole run — this costs
// nothing and the compositor handles it.
function ensurePulseStyle() {
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
@keyframes track-pulse {
  0%   { transform: scale(1);   opacity: 0.55; }
  70%  { transform: scale(3.2); opacity: 0;    }
  100% { transform: scale(3.2); opacity: 0;    }
}
.track-dot { position: relative; width: 16px; height: 16px; }
.track-dot__core {
  position: absolute; inset: 0; border-radius: 50%;
  background: ${ROUTE_LINE_COLOR};
  border: 2.5px solid #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,0.45);
}
.track-dot__halo {
  position: absolute; inset: 0; border-radius: 50%;
  background: ${ROUTE_LINE_COLOR};
  animation: track-pulse 2s ease-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .track-dot__halo { animation: none; opacity: 0; }
}
.track-start-dot {
  width: 16px; height: 16px; border-radius: 50%;
  background: ${START_MARKER_COLOR};
  border: 2.5px solid #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,0.45);
}`;
  document.head.appendChild(style);
}

export function TrackMap({
  points,
  running,
  here,
  chromeInsets,
  active,
  fenceColor,
  tiles,
  enclosedTiles,
  placeholder,
  placeholderColor,
  unavailable,
  zoomInLabel,
  zoomOutLabel,
  recenterLabel,
  overviewLabel,
}: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  // The start pin — dropped once a session has a first point and left there
  // for the rest of the run, unlike markerRef's "you are here" dot which
  // tracks the runner. See fence-map.web.tsx's own start marker for the
  // post-run equivalent (same colour, START_MARKER_COLOR).
  const startMarkerRef = useRef<Marker | null>(null);
  const readyRef = useRef(false);
  // The same fact as readyRef, as STATE — because a ref cannot wake an
  // effect. Every effect below bails until the map has loaded, and most
  // re-run on their own data (points, here, tiles) a fix or two later. Two
  // do NOT: the animation-arming and gesture-listener effects depend only on
  // `active`, which changes once at session start and not again. If the map
  // was still loading at that moment they bailed and never ran for the whole
  // session — no gradient flow, no conquered shimmer, and no drag/zoom
  // listeners at all, so the browse hold and auto-return simply did not
  // exist. Reachable on any cold start: mapbox-gl is a 1.8 MB dynamic
  // import plus a style fetch, and a runner can press Start inside that.
  //
  // Every readiness-gated effect now lists `mapReady`, so "the map finished
  // loading" is an event they can all react to rather than a value they
  // happened to read too early.
  const [mapReady, setMapReady] = useState(false);
  // True once the first set of tiles has finished painting (not just style
  // loaded) — used to keep the static placeholder visible until GL is
  // actually drawn, preventing the hard white flash between `load` and tiles.
  const [mapPainted, setMapPainted] = useState(false);
  // Set when the GL boot throws (import failure, WebGL unavailable, bad token).
  // Resets bootedRef so the next false→true edge of `active` can retry.
  const [mapError, setMapError] = useState(false);
  const flownRef = useRef(false);
  // The "feels alive even standing still" animation timer — a JS interval,
  // not a requestAnimationFrame loop (see the pulse-dot comment below for
  // why that distinction matters for the length of a run). Armed and cleared
  // by the `active` effect further down, so it only ever runs mid-session
  // and never on the idle pre-run map.
  //
  // The gradient flow owns its own timer (gradient-flow.ts); this holds its
  // stopper rather than an interval id.
  const routeFlowStopRef = useRef<(() => void) | null>(null);
  // The conquered-ground shimmer's own interval — see the ENCLOSED_SRC layer.
  const shimmerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Camera control during a session (Task D / P4). preferredZoom is a REF,
  // not state: the zoom buttons (and now pinch-zoom, see the gesture effect
  // below) write it and the camera-apply function reads it imperatively
  // from inside an event listener/timeout, seconds after the render that
  // set it — a ref avoids both a stale closure and re-subscribing every
  // listener on every zoom tap. Survives a session (not reset on
  // pause/resume) because it is a user preference, not per-leg state.
  const preferredZoomRef = useRef(SESSION_ZOOM);
  // The runner's latest known position, mirrored from the "feed
  // coordinates in" effect below (the same `head` it already computes) so
  // the auto-return glide — fired from a setTimeout, not a render — always
  // targets where the runner IS, not wherever they were when the 5s timer
  // was scheduled.
  const headRef = useRef<LatLng | null>(null);
  // Mirrors `points` for the same reason headRef mirrors `here` — overview
  // mode's bounds fit is computed from inside the same imperative call sites
  // (auto-return timeout, mode-toggle tap) that read headRef, so it needs
  // the same "always current, no stale closure" treatment.
  const pointsRef = useRef<LatLng[]>([]);
  const autoReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the moment a user gesture arms auto-return until the camera is
  // next placed authoritatively (the timer firing, a mode toggle, a recenter
  // tap, a new session). While it's true the per-fix camera effect below
  // stays hands-off, so a deliberate pan/pinch survives for the whole
  // AUTO_RETURN_IDLE_MS window instead of being undone by the next GPS fix.
  //
  // It applies in BOTH modes, and that is the fix for "it's almost as if it
  // doesn't allow you to explore the map" (Pedro, 2026-09-08). It used to be
  // checked only when cameraMode was 'overview' — so in follow mode, which
  // is what every session STARTS in, the per-fix effect re-centred on the
  // runner ~1-2s after a pan and AUTO_RETURN_IDLE_MS never came into it at
  // all. Panning away in follow mode was effectively impossible.
  //
  // Follow mode still stays glued fix to fix; nothing sets this ref unless
  // the runner actually touches the map (dragend/zoomend with a real
  // originalEvent — see the auto-return effect below).
  const manualPendingRef = useRef(false);

  // P4: cameraMode replaces the old cameraOffTarget visibility flag
  // entirely. The control is now ALWAYS rendered while a session is active
  // (see the render below) — its icon/label reflect whichever mode is
  // CURRENT, and a tap cycles to the other one. cameraModeRef mirrors the
  // state for the same stale-closure reason as preferredZoomRef/headRef:
  // read from the gesture handlers' setTimeout and from the marker's
  // dblclick listener, not just from render.
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const cameraModeRef = useRef<CameraMode>('follow');
  // Smoothed camera heading for follow mode (degrees, 0-360) — null until
  // bearingFromPath (camera.ts) has enough separation to derive one. Reset
  // to null at the start of each session (see the `active` effect below):
  // a new session has no known direction yet, and the old one's heading is
  // meaningless for it.
  const bearingRef = useRef<number | null>(null);
  // Mirrored into a ref for the same reason headRef/pointsRef are: the
  // camera is applied from setTimeout and Mapbox event listeners, not only
  // from a render, so it must read the current insets rather than the ones
  // captured when applyCameraForMode was defined.
  const chromeInsetsRef = useRef<ChromeInsets>(chromeInsets ?? NO_CHROME);
  useEffect(() => {
    chromeInsetsRef.current = chromeInsets ?? NO_CHROME;
  }, [chromeInsets]);
  const { region } = useRegion();

  // Applies whichever camera cameraModeRef.current currently names — the
  // ONE definition the continuous while-running follow, the auto-return
  // glide, the mode-toggle tap, and the pin double-tap all share, so
  // "deliberate zoom survives, stray drift doesn't, and both modes glide to
  // the same place their button promised" can't drift out of sync between
  // the four entry points.
  const applyCameraForMode = useCallback((durationMs: number) => {
    const map = mapRef.current;
    if (!map) return;
    // Every caller here is an authoritative "the camera belongs at the
    // current mode's target NOW" — the idle timer firing, a mode toggle, a
    // recenter tap. So both halves of the browse hold are released in ONE
    // place: the pending timer and the ref the per-fix effect reads. Leaving
    // the ref set here is what would strand that effect hands-off forever
    // (its timer having been cleared, nothing left to reset the ref).
    if (autoReturnTimerRef.current) {
      clearTimeout(autoReturnTimerRef.current);
      autoReturnTimerRef.current = null;
    }
    manualPendingRef.current = false;

    if (cameraModeRef.current === 'overview') {
      const head = headRef.current;
      const path = head ? [...pointsRef.current, head] : pointsRef.current;
      const bounds = boundsOfPath(path);
      if (!bounds) return; // nothing recorded yet — nothing to fit
      map.fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        {
          // Framed inside the band the chrome leaves visible — a uniform
          // padding fits the top of the route into the space the timer is
          // drawn over, and the bottom into the tab bar.
          padding: overviewPadding(chromeInsetsRef.current, OVERVIEW_FIT_PADDING_PX),
          bearing: 0,
          pitch: 0,
          duration: durationMs,
        },
      );
      return;
    }

    const head = headRef.current;
    if (!head) return; // nothing to target yet
    const containerHeight = containerRef.current?.clientHeight ?? 0;
    map.easeTo({
      center: [head.lng, head.lat],
      zoom: preferredZoomRef.current,
      pitch: SESSION_PITCH,
      // Falls back to the map's current bearing (not 0) when no heading has
      // been derived yet — standing still at the very start of a session
      // shouldn't snap the camera to north, it should just hold whatever
      // it's already at until a real course is known.
      bearing: bearingRef.current ?? map.getBearing(),
      // Pushes the runner toward the lower third of the VISIBLE band
      // (Mapbox's `offset` is screen-space pixels, not world-space) — see
      // followOffsetPx and FOLLOW_OFFSET_RATIO.
      offset: [0, followOffsetPx(containerHeight, chromeInsetsRef.current, FOLLOW_OFFSET_RATIO)],
      duration: durationMs,
    });
  }, []);

  // The mode-cycle button's tap handler. Updates the ref BEFORE calling
  // setCameraMode/applyCameraForMode — never inside a setState updater (a
  // documented trap in this codebase: a side effect inside an updater can
  // silently no-op under the React Compiler in production builds).
  const toggleCameraMode = useCallback(() => {
    const next: CameraMode = cameraModeRef.current === 'follow' ? 'overview' : 'follow';
    cameraModeRef.current = next;
    setCameraMode(next);
    applyCameraForMode(900); // clears the browse hold too — see its own comment
  }, [applyCameraForMode]);

  const zoomBy = useCallback((delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const nextZoom = map.getZoom() + delta;
    // The button IS the deliberate zoom — record it as the new preference
    // before animating, so an auto-return firing mid-animation (a runner
    // taps zoom-out right as their 5s idle timer was about to fire) still
    // lands on the value they just chose, not the one before it.
    preferredZoomRef.current = nextZoom;
    map.easeTo({ zoom: nextZoom, duration: 300 });
  }, []);

  // Only ever a fallback for the *initial* camera, and only while no real fix
  // exists. The marker is a separate decision below — it is never placed on a
  // city centre, because a pin is a claim about where you are.
  const initialLat = here?.lat ?? region.lat;
  const initialLng = here?.lng ?? region.lng;

  // Stays current across async gaps (used in the boot effect after
  // `await import()`, where the closure would otherwise see the render-time
  // value rather than a GPS fix that arrived during the 1.9s load).
  const hereRenderRef = useRef(here);
  useEffect(() => {
    hereRenderRef.current = here;
  }); // no deps — syncs after every render, always current before any async reads it

  // A static Mapbox image (buildPinMapUrl, same helper the native file used
  // to render before it got a real MapView — see this repo's own history)
  // covers the idle screen instead of a live GL map. Frozen once the first
  // real fix lands, not kept live: this is scene-dressing for "before you've
  // pressed Start," not a second live map to keep in sync, and re-fetching a
  // new static image on every GPS tick would be both wasteful and visibly
  // flickery. `hasRealFix: false` until then, matching the marker-placement
  // rule elsewhere in this file — a pin is a claim about where you are, never
  // dropped on the region fallback.
  //
  // If `here` is already defined at mount, initialize pinnedUrl directly (with
  // the real pin) and skip pinUrl entirely — avoids a "no-pin → real-pin"
  // double fetch that would otherwise happen on a warm component mount.
  // pinnedOnceRef guards the effect instead of `pinnedUrl !== null` in deps —
  // the latter triggers a cascading re-render (setState → dep changes → effect
  // fires again), which the React Compiler lint rejects as unstable.
  const pinnedOnceRef = useRef(!!here);
  const [pinUrl] = useState(() =>
    here ? null : buildPinMapUrl(initialLat, initialLng, true, false),
  );
  const [pinnedUrl, setPinnedUrl] = useState<string | null>(() =>
    here ? buildPinMapUrl(here.lat, here.lng, true, true) : null,
  );
  useEffect(() => {
    if (pinnedOnceRef.current || !here) return;
    pinnedOnceRef.current = true;
    setPinnedUrl(buildPinMapUrl(here.lat, here.lng, true, true));
  }, [here]);

  // The real GL map boots lazily, the FIRST time a session goes active (the
  // false→true edge of `active` — see its own prop doc), not on mount.
  //
  // Measured 2026-09-17: mapbox-gl's chunk alone costs ~1.9s of main-thread
  // CPU (755ms script eval, 187ms parse) the instant it runs. Deferring that
  // to idle time still landed inside PageSpeed Insights' Total Blocking Time
  // window often enough to keep the score under 85 (TBT counts everything up
  // to the page settling, not just a fixed initial window — moving WHEN the
  // cost lands doesn't remove it from that count). The only lever left was
  // not booting a live map automatically at all: the idle screen now shows a
  // static image (above) and pays mapbox-gl's real cost only on a genuine
  // user action, well outside anything Lighthouse measures on page load.
  // Pedro's call, made with the tradeoff spelled out — the Track screen no
  // longer feels "alive" the instant it opens; it does the moment you tap
  // Start.
  //
  // Booted once, ever, and never torn down for the rest of this component's
  // life (`bootedRef` guards re-entry) — a session can pause/resume (`active`
  // stays true throughout, see index.tsx's `inSession`) and a second session
  // can start after the first ends (`active` false→true again) without ever
  // re-creating the WebGL context. Cleanup that actually removes the map only
  // runs once, at true component unmount (the separate effect below) — this
  // effect intentionally returns no cleanup of its own, since an `[active]`
  // dependency would otherwise fire it (and tear the map down) every time a
  // session ENDS too.
  const bootedRef = useRef(false);
  const unmountedRef = useRef(false);
  useEffect(() => {
    if (!TOKEN || !containerRef.current || !active || bootedRef.current) return;
    // Guard concurrent boot attempts: if active fires twice before the dynamic
    // import resolves, only the first attempt proceeds. On any failure below,
    // bootedRef is reset so a new false→true edge of `active` can retry.
    bootedRef.current = true;

    void (async () => {
      try {
        ensureMapboxCss();
        ensurePulseStyle();
        const { default: mapboxgl } = await import('mapbox-gl');
        if (unmountedRef.current || !containerRef.current) {
          // Unmounted during import — release the guard so a remount can retry.
          bootedRef.current = false;
          return;
        }

        mapboxgl.accessToken = TOKEN;
        // Use hereRenderRef (updated on every render) rather than the
        // render-time initialLat/initialLng: a GPS fix that arrived during the
        // ~1.9s import window would otherwise be ignored, booting the map at
        // the region centre instead of the runner's actual position.
        const bootLat = hereRenderRef.current?.lat ?? initialLat;
        const bootLng = hereRenderRef.current?.lng ?? initialLng;
        const map = new mapboxgl.Map({
          container: containerRef.current,
          // The full Standard style directly — no idle style to boot into and
          // later swap out of, since GL never renders until a session needs it.
          style: MAP_STYLE_GL,
          center: [bootLng, bootLat],
          zoom: MAP_DEFAULT_ZOOM,
          attributionControl: false,
        });
        mapRef.current = map;

        map.on('load', () => {
          if (unmountedRef.current || mapRef.current !== map) return;

          // Rotate/pitch gestures, gone entirely — not just during a session.
          // SESSION_PITCH is set once for the 3D look and a runner has no
          // legitimate reason to change it via gesture. This is the fix for
          // the actual bug: one stray
          // pinch or two-finger drag used to permanently change the framing,
          // with no interaction detection and no way back (Pedro hit this
          // mid-run: "normal at first, then weird").
          map.dragRotate.disable();
          map.touchPitch.disable();
          map.touchZoomRotate.disableRotation(); // pinch-zoom itself stays on

          setupSessionLayers(map);

          const el = document.createElement('div');
          el.className = 'track-dot';
          el.innerHTML = '<div class="track-dot__halo"></div><div class="track-dot__core"></div>';
          // Double-tap the pin to re-center (Pedro's original idea) —
          // stopPropagation so a near-miss tap can't fall through to the
          // canvas underneath and trigger Mapbox's OWN built-in
          // double-click-to-zoom, which would zoom IN: the opposite of what
          // tapping the pin means here.
          el.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            applyCameraForMode(900);
          });
          markerRef.current = new mapboxgl.Marker({ element: el });

          const startEl = document.createElement('div');
          startEl.className = 'track-start-dot';
          startMarkerRef.current = new mapboxgl.Marker({ element: startEl });

          readyRef.current = true;
          // Ref first, then state: the ref is what the imperative call sites
          // read (the marker's dblclick, applyCameraForMode's callers), and it
          // must be true before any effect this wakes can run.
          setMapReady(true);

          // Keep the static placeholder visible until GL tiles have actually
          // painted — `load` fires when the style is ready but before tile
          // data has rendered. We poll `areTilesLoaded()` on each `render`
          // event (one per frame) and remove the listener the moment it's true,
          // which avoids the hard flash between a white canvas and the basemap.
          const onFirstPaint = () => {
            if (unmountedRef.current || mapRef.current !== map) {
              map.off('render', onFirstPaint);
              return;
            }
            if (map.areTilesLoaded()) {
              map.off('render', onFirstPaint);
              setMapPainted(true);
            }
          };
          map.on('render', onFirstPaint);
        });
      } catch {
        // Import failure (CDN timeout), WebGL unavailable, bad token, etc.
        // Reset the guard so a new false→true edge of `active` can retry.
        bootedRef.current = false;
        setMapError(true);
      }
    })();
  }, [active, initialLat, initialLng, applyCameraForMode]);

  // Runs ONCE, at true unmount only — deliberately separate from the boot
  // effect above so tearing down the map doesn't also happen on every
  // session END (see that effect's own comment on why it has no cleanup).
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      readyRef.current = false;
      flownRef.current = false;
      markerRef.current?.remove();
      markerRef.current = null;
      startMarkerRef.current?.remove();
      startMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Arms the route-colour-cycle timer ONLY while a session is active —
  // gated here, not inside the mount effect above, specifically because it
  // used to run from map mount to unmount regardless of whether a run was in
  // progress. Sitting on the Track tab with no run recording cost ~2.2
  // setPaintProperty calls per second, each forcing a map repaint,
  // indefinitely, on an empty source — directly undoing P0.1 bug 3, which
  // exists specifically to stop the idle screen burning battery (see
  // GeoWatchOptions.highAccuracy). This is a running app; the phone has to
  // survive 40+ minutes with the screen on. "Feels alive even standing
  // still" means standing still MID-RUN, not idling in the app.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !active) return;

    // The route flows its colours along itself. line-gradient has no
    // `-transition` support at all, so there is no GPU tween between
    // updates — every repaint lands exactly as drawn. That is why the flow
    // moves in many tiny steps rather than a few large ones; see
    // ROUTE_GRADIENT_FRAME_MS. The previous version rotated whole colour
    // stops and read as stepped.
    routeFlowStopRef.current = startGradientFlow((gradient) => {
      // Guarded, not assumed to exist: ROUTE_SRC's layer is only added once
      // setupSessionLayers has run, in the map's `load` handler — this
      // effect's own `readyRef.current` check above already implies that ran,
      // but the guard costs nothing and matches every other paint-property
      // call site in this file.
      if (map.getLayer(ROUTE_SRC)) map.setPaintProperty(ROUTE_SRC, 'line-gradient', gradient);
    });

    // The conquered-ground shimmer. One step of the wheel per tick; GL
    // tweens between steps via the layer's own fill-color-transition, so
    // this is ~0.45 setPaintProperty calls a second for the whole run.
    //
    // Armed on `active` alongside the flow above and not gated on the
    // enclosure being non-empty, deliberately: an empty source paints
    // nothing, so a tick against one costs a paint property assignment and
    // no pixels, and the alternative — arming and tearing down on
    // enclosedTiles.length — would re-arm the timer at the exact moment the
    // first capture appears, restarting the phase and making the first
    // shimmer the one that stutters. The idle pre-session map is what the
    // `active` gate is protecting (see this effect's own header).
    let shimmerStep = 0;
    shimmerIntervalRef.current = setInterval(() => {
      shimmerStep = (shimmerStep + 1) % ROUTE_GRADIENT_COLORS.length;
      // Guarded for the same reason the gradient-flow callback above is.
      if (map.getLayer(ENCLOSED_SRC)) {
        map.setPaintProperty(ENCLOSED_SRC, 'fill-color', ROUTE_GRADIENT_COLORS[shimmerStep]);
      }
    }, FENCE_SHIMMER_STEP_MS);

    return () => {
      routeFlowStopRef.current?.();
      routeFlowStopRef.current = null;
      if (shimmerIntervalRef.current) clearInterval(shimmerIntervalRef.current);
      shimmerIntervalRef.current = null;
      // Back to a colour, not left mid-sweep: this component outlives a
      // session, so the next one would otherwise open on whatever hue the
      // last tick happened to land on.
      //
      // Only while this map is still THE live map. `map` was captured when
      // the effect ran, and this cleanup ALSO runs on unmount — where the
      // mount effect's own cleanup (declared above, so it runs first) has
      // already called map.remove(). A removed Mapbox map has no `style`,
      // and getLayer reaches straight into it: the guard below was itself
      // what threw, taking the whole React tree down with it because
      // nothing above this component catches. That is the blank screen on
      // tapping Finish — the ONE moment this component always unmounts.
      //
      // Checked against the ref rather than a "did we unmount" flag so the
      // condition states the real precondition and does not depend on
      // cleanup ORDER: mapRef is nulled the instant the map is destroyed,
      // so `mapRef.current === map` is false exactly when touching it is
      // unsafe, whichever cleanup React happens to run first.
      if (mapRef.current === map && readyRef.current && map.getLayer(ENCLOSED_SRC)) {
        map.setPaintProperty(ENCLOSED_SRC, 'fill-color', ROUTE_GRADIENT_COLORS[0]);
      }
    };
  }, [active, mapReady]);

  // Resets the camera mode to 'follow' at the start of every session — the
  // mode is session-scoped, not a persisted user setting. Gated to fire only
  // on the false→true edge (the effect body no-ops while active stays
  // false, and re-running on active→false does nothing either): a pause
  // mid-run does not touch `active`, so cameraMode survives a pause exactly
  // like preferredZoomRef already does. bearingRef also resets — a new
  // session has no known heading yet, and the previous session's is
  // meaningless for it.
  useEffect(() => {
    if (!active) return;
    cameraModeRef.current = 'follow';
    bearingRef.current = null;
    manualPendingRef.current = false;
    // Deferred by a tick, not called straight from the effect body — the
    // React Compiler's lint rule traces a call through and flags any
    // setState it can reach as a synchronous effect update. Same pattern as
    // index.tsx's checkpoint-load effect.
    const id = setTimeout(() => setCameraMode('follow'), 0);
    return () => clearTimeout(id);
  }, [active, mapReady]);

  // Auto-return after AUTO_RETURN_IDLE_MS of no further interaction — gated
  // on `active` the same way as the animation timers above: this exists to
  // repair sweaty-hands drift mid-run, not to herd someone idly exploring
  // the pre-session map back to their own position. The re-center/overview
  // control is now ALWAYS rendered (see the render below) — this effect no
  // longer drives its visibility, only when the camera glides back to
  // whatever cameraModeRef currently names.
  //
  // `originalEvent` is present on Mapbox's own camera events ONLY when a
  // user gesture triggered them — absent for our own easeTo/flyTo calls
  // (the fly-in, the live follow, applyCameraForMode itself) — which is the
  // one reliable way to tell "the runner touched the map" apart from every
  // OTHER thing in this file that already moves the camera. Listens to
  // dragend/zoomend specifically, not moveend: rotate/pitch are disabled
  // above, so drag and pinch-zoom are the only gestures left that can
  // actually originate a user move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !active) return;

    const armAutoReturn = () => {
      if (autoReturnTimerRef.current) clearTimeout(autoReturnTimerRef.current);
      manualPendingRef.current = true;
      // Each new gesture RESTARTS the window (the clear above), so a runner
      // panning around for a while keeps the map theirs for
      // AUTO_RETURN_IDLE_MS after they stop, not after they started.
      autoReturnTimerRef.current = setTimeout(() => {
        applyCameraForMode(900); // resets manualPendingRef itself
      }, AUTO_RETURN_IDLE_MS);
    };

    // Typed `unknown`, not Mapbox's own per-event shape: 'dragend' and
    // 'zoomend' carry slightly different originalEvent union types, and the
    // 'void' branch some of these events' types include resolves (via
    // Mapbox's internal event-map machinery) to a bare {type, target} shape
    // with no originalEvent at all — no single object type satisfies every
    // variant. `unknown` is the top type, so this is valid for any of them;
    // narrowed by hand at runtime instead.
    const onUserDragEnd = (e: unknown) => {
      const originalEvent = (e as { originalEvent?: unknown } | null | undefined)?.originalEvent;
      if (!originalEvent) return;
      armAutoReturn();
    };
    // The core fix (P4): a pinch-zoom is a deliberate zoom exactly like the
    // +/- buttons, and must survive auto-return the same way — previously
    // ONLY the buttons wrote preferredZoomRef, so a runner who pinched to
    // max zoom got yanked back to SESSION_ZOOM 5s later with no way to tell
    // why, since the button that would explain it was hidden at the time
    // too (cameraOffTarget's old visibility bug, now gone).
    const onUserZoomEnd = (e: unknown) => {
      const originalEvent = (e as { originalEvent?: unknown } | null | undefined)?.originalEvent;
      if (!originalEvent) return;
      preferredZoomRef.current = map.getZoom();
      armAutoReturn();
    };

    map.on('dragend', onUserDragEnd);
    map.on('zoomend', onUserZoomEnd);

    return () => {
      map.off('dragend', onUserDragEnd);
      map.off('zoomend', onUserZoomEnd);
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    };
  }, [active, applyCameraForMode, mapReady]);

  // Marker placement is deliberately gated on a REAL fix. Showing the pin at
  // the region fallback is what made it look like the location was wrong —
  // it was a city centre being presented as the runner's position.
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !readyRef.current || !marker) return;

    // `here` first: during a session it's the tracker's RAW fix stream, which
    // stays fresh even while fixes are rejected for accuracy — the accepted
    // point list is only the fallback for the moment before any raw fix.
    const head = here ?? (points.length > 0 ? points[points.length - 1] : null);
    // Mirrored for applyCameraForMode (Task D / P4), which reads this from a
    // setTimeout/event listener rather than a render.
    headRef.current = head;
    if (!head) {
      marker.remove();
      return;
    }
    marker.setLngLat([head.lng, head.lat]).addTo(map);
  }, [points, here, mapReady]);

  // Start pin — `points[0]` is stable once a session has recorded anything
  // (the array only ever grows), so this only actually moves the marker
  // when a new session starts with a fresh, empty `points`. Live, the
  // runner IS the privacy zone's owner (see index.tsx's `tiles` prop doc),
  // so unlike fence-map's masked start this is the real first fix.
  useEffect(() => {
    const map = mapRef.current;
    const marker = startMarkerRef.current;
    if (!map || !readyRef.current || !marker) return;
    if (points.length === 0) {
      marker.remove();
      return;
    }
    marker.setLngLat([points[0].lng, points[0].lat]).addTo(map);
  }, [points, mapReady]);

  // Idle: keep the camera over the runner as they move, so the map isn't
  // still framing wherever they were when the tab opened. Skipped during a
  // session — the fly-in and follow below own the camera then.
  //
  // Dead before the very first Start of this component's life (GL hasn't
  // booted yet, so mapRef.current is null). The static placeholder covers
  // that window — it freezes on the first real GPS fix and doesn't track
  // further movement, which is deliberate: re-fetching on every fix would be
  // wasteful and visibly flickery.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || active || !here) return;
    map.easeTo({ center: [here.lng, here.lat], duration: 600 });
  }, [here, active, mapReady]);

  // Fly in when a session starts: tilt into 3D and close on the runner. Runs
  // once per session (flownRef), so a later GPS fix doesn't re-trigger it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    if (!active) {
      flownRef.current = false;
      return;
    }
    if (flownRef.current) return;

    const target = points.length > 0 ? points[points.length - 1] : here;
    if (!target) return; // wait for a real position rather than flying to a city centre

    flownRef.current = true;
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: SESSION_ZOOM,
      pitch: SESSION_PITCH,
      // Explicit, not omitted: a second-or-later run in the same screen
      // session can start with the map still rotated from the PREVIOUS
      // run's follow mode (bearing is never reset back to 0 when a session
      // ends — same pre-existing gap as pitch, which also stays tilted).
      // Forcing 0 here gives every fly-in a deterministic, north-up start;
      // follow mode rotates it to the real course within a fix or two once
      // bearingRef has enough separation to derive one.
      bearing: 0,
      duration: SESSION_FLY_MS,
      essential: true,
    });
  }, [active, points, here, mapReady]);

  // Per-run fence colour. The wall and tile layers are created once
  // setupSessionLayers has run (the map's first `load`, at the FIRST Start —
  // see the boot effect) with the default FENCE_WALL_COLOR, so the run's own
  // colour is applied as a paint update — cheap, no layer churn.
  //
  // ENCLOSED_SRC is deliberately NOT in here. Captured ground carries the
  // shimmer instead of the run's identity colour — that contrast IS the
  // signal that it was conquered rather than covered. Adding it here would
  // paint over the shimmer's hue on every fenceColor/active change and the
  // effect would read as an intermittent flicker, not as a bug.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    // Guarded, not assumed to exist: these layers are only added once
    // setupSessionLayers has run — costs nothing and matches every other
    // paint-property call site in this file.
    if (map.getLayer(WALL_SRC)) map.setPaintProperty(WALL_SRC, 'fill-extrusion-color', fenceColor);
    if (map.getLayer(TILES_SRC)) map.setPaintProperty(TILES_SRC, 'fill-color', fenceColor);
  }, [fenceColor, active, mapReady]);

  // Tile Coverage brief §6 step 4 — deliberately its OWN effect, not folded
  // into the points-driven effect below that owns ROUTE_SRC/the camera.
  // index.tsx already throttles `tiles`, so this just renders whatever it's
  // handed, same "own effect, untouched existing one" posture as
  // fence-map.web.tsx's rivalTiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    // ONE geometry drives both the flat fill and the raised wall: the tile
    // footprint. Tiles are H3 cells — they tile the plane and arrive
    // deduplicated (pathToTiles unions its direct and gap-filled sets), so
    // no two features can overlap and the opacity is uniform no matter how
    // many times a runner covers the same ground.
    //
    // The wall used to be a ribbon built along the path (buildWallPolygon).
    // A ribbon is ONE ring, so a path that doubles back makes that ring
    // self-intersect; Mapbox triangulates it and the overlapping triangles
    // blend twice, so running a street three times drew it three times as
    // dark. Reported 2026-09-07: the fence should mark total area, not how
    // often it was crossed.
    //
    // The WALL is the whole territory's raised edge, so it takes the UNION
    // of run-over and captured ground — a wall drawn around only the ground
    // you ran would cut straight through the middle of a closed loop. The
    // flat fills stay split, one per source, so each region has exactly one
    // fill and the shimmer is not blended over a second translucent layer.
    (map.getSource(TILES_SRC) as GeoJSONSource | undefined)?.setData(
      tileFeatureCollection(tiles),
    );
    (map.getSource(ENCLOSED_SRC) as GeoJSONSource | undefined)?.setData(
      tileFeatureCollection(enclosedTiles),
    );
    (map.getSource(WALL_SRC) as GeoJSONSource | undefined)?.setData(
      tileFeatureCollection([...tiles, ...enclosedTiles]),
    );
  }, [tiles, enclosedTiles, mapReady]);

  // Feed coordinates in. setData on an existing source is the cheap path —
  // no layer or style churn, so the line simply extends.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    // Mirrored for applyCameraForMode's overview branch, which reads this
    // from a setTimeout/event listener rather than a render — same reason
    // headRef mirrors `here` in the marker effect above.
    pointsRef.current = points;

    // Heading-up source for follow mode. Derives a new bearing only when
    // there's enough separation to trust one (bearingFromPath returns null
    // otherwise — standing still, or too early in the run) and smooths
    // toward it along the shortest arc rather than snapping, so a jittery
    // fix doesn't wobble the map. The FIRST bearing of a session jumps
    // straight to its target (maxStepDeg: Infinity) — there's no prior
    // heading to smooth from.
    const rawBearing = bearingFromPath(points, MIN_BEARING_SEPARATION_M);
    if (rawBearing !== null) {
      bearingRef.current =
        bearingRef.current === null
          ? rawBearing
          : smoothBearing(bearingRef.current, rawBearing, MAX_BEARING_STEP_DEG);
    }

    // `points` is one flat array with no record of its own seams, so drawing
    // straight from it joins the two sides of an unrecorded gap with a
    // straight line. On a real iOS Safari run that showed as a chord from
    // the start point to the runner's current position, and again as the
    // wall ribbon's two edges (reported with screenshots 2026-09-07).
    // splitLegs cuts exactly where pathToTiles already refuses to bridge, so
    // the drawn route and the claimed tiles agree about what is a hole.
    //
    // EVERY leg, the whole way back to the start — not just the newest one's
    // trailing edge (see this file's header, 2026-09-16). One Feature per
    // leg rather than one LineString across all of them, same reasoning as
    // fence-map.web.tsx's summary route: `line-gradient` reads line-progress,
    // which lineMetrics computes per feature, so each leg gets its own clean
    // 0->1 gradient run instead of one that resets across an unrecorded gap.
    const legs = splitLegs(points);
    const routeSource = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
    routeSource?.setData({
      type: 'FeatureCollection',
      features: legs
        .filter((leg) => leg.length >= 2)
        .map((leg) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'LineString' as const,
            coordinates: leg.map((p) => [p.lng, p.lat] as [number, number]),
          },
        })),
    });

    // The wall is no longer built from this path — it is the tile footprint
    // now, fed by the tiles effect above.
    //
    // Nothing else on this map is derived from `points`. The enclosure fill
    // and its rim used to be, via a throttled buildFence() right here; both
    // are gone — see this file's header for the three artefacts that ring
    // put on screen. Claimed ground is the tile footprint, and it arrives as
    // its own prop.

    // Camera only while recording: panning the map under someone reading
    // their finished route would fight them. Re-applies whichever mode is
    // current on every fix — follow re-centers on the runner (and rotates
    // to their latest smoothed bearing); overview re-fits the growing
    // bounds. Gated on `head` existing (not just `running`) for the same
    // reason as the marker effect above — there's nothing to center or fit
    // until a real fix exists.
    //
    // `manualPendingRef` suspends ALL of that for the AUTO_RETURN_IDLE_MS
    // window after a real pan/pinch, in BOTH modes. The check used to read
    // `cameraModeRef.current === 'overview' && manualPending`, which meant
    // follow mode — the mode every session starts in — re-centred on the
    // runner one fix (~1-2s) after any gesture. That is what made the map
    // impossible to explore mid-run: the pan landed, and the map took
    // itself back before you could read it (Pedro, 2026-09-08). The
    // armed auto-return timer, not this path, is what returns the camera.
    //
    // Note this cannot strand the camera: the ONLY thing that sets the ref
    // is a user gesture, and applyCameraForMode clears it on every
    // authoritative placement, including the timer's own.
    const head = here ?? points[points.length - 1];
    if (head && running && flownRef.current && !manualPendingRef.current) {
      applyCameraForMode(900);
    }
    // `mapReady` alongside the data, like every other readiness-gated effect
    // here: this one does re-run on its own (points/here tick every fix), but
    // the fixes recorded WHILE the map was still loading only reach ROUTE_SRC
    // on the next one — a gap between the stats saying 0:12 and the line
    // existing at all. Listing it closes that, and keeps the "every
    // readiness-gated effect lists mapReady" rule true with no exception to
    // remember.
  }, [points, running, here, applyCameraForMode, mapReady]);

  if (!TOKEN || mapError) {
    return (
      <View style={[styles.wrap, StyleSheet.absoluteFill, styles.centre]}>
        <Text style={[styles.placeholderText, { color: placeholderColor }]}>{unavailable}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* Static placeholder, covering the (still-empty) GL container until
          the real map has loaded — see the boot effect above for why this
          exists at all. `pinnedUrl` replaces the region-fallback `pinUrl`
          the FIRST time a real GPS fix lands, and never again.
          Gated on `mapPainted` (not `mapReady`) so the image stays until
          GL tiles are actually drawn on screen — `mapReady` fires on the
          map's `load` event before any tiles have rendered, which would
          hard-cut to a white canvas for ~0.5–2s on a normal connection. */}
      {!mapPainted && (
        <img
          src={pinnedUrl ?? pinUrl ?? undefined}
          alt=""
          // High-priority so the browser front-loads this against
          // any other competing resource — it's the LCP element on
          // the Track tab's initial paint.
          fetchPriority="high"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}
      {points.length === 0 && running && (
        <View style={styles.waiting}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}
      {/* Camera controls (Task D / P4) — reliable targets for sweaty hands
          where pinch is not. Bottom-right, matching where a thumb naturally
          rests; the app's own circular-button language (see index.tsx's
          RoundButton), not Mapbox's NavigationControl — foreign styling,
          and its compass would be meaningless with rotation disabled.

          The mode-cycle button is ALWAYS rendered here, never conditionally
          mounted — that was problem 1's root cause (a pinch to max zoom
          didn't write preferredZoomRef, so 5s later auto-return yanked the
          camera back to SESSION_ZOOM AND hid the button in the same
          instant). Its icon/label reflect the action a tap performs next,
          not the current mode: 'map' while in follow (tap → overview),
          'my_location' while in overview (tap → follow, reusing the same
          icon/copy as the old always-present recenter button). Fixed order
          — it and the +/- buttons never mount/unmount, so this cluster
          never shifts. */}
      {active && mapReady && (
        <View style={styles.cameraControls} pointerEvents="box-none">
          {cameraMode === 'follow' ? (
            <MapButton label={overviewLabel} onPress={toggleCameraMode} ios="map" android="map" />
          ) : (
            <MapButton label={recenterLabel} onPress={toggleCameraMode} ios="location.fill" android="my_location" />
          )}
          <MapButton label={zoomInLabel} onPress={() => zoomBy(ZOOM_STEP)} ios="plus" android="add" />
          <MapButton label={zoomOutLabel} onPress={() => zoomBy(-ZOOM_STEP)} ios="minus" android="remove" />
        </View>
      )}
    </View>
  );
}

function MapButton({
  label,
  onPress,
  ios,
  android,
}: {
  label: string;
  onPress: () => void;
  ios: SFSymbol;
  android: AndroidSymbol;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [styles.mapButton, { opacity: pressed ? 0.85 : 1 }]}>
      <Icon ios={ios} android={android} size={20} color="#FFFFFF" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Dark, not transparent/default-white: MAP_ALWAYS_DARK means the map
  // itself is always a dark night-style basemap regardless of the app's own
  // theme, but before mapbox-gl has even loaded (or while its tiles are
  // still streaming in over a throttled connection) this container was
  // showing through to whatever light background sat behind it — a stark
  // light-to-dark flash as tiles filled in, which is exactly what
  // Lighthouse's Speed Index penalizes (it measures how far each frame is
  // from the FINAL one; a light "still loading" frame reads as far less
  // "done" than it visually is once tiles are progressively filling a dark
  // ground). Matches the splash screen's own backgroundColor (app.json) for
  // the same "dark app, dark loading state" consistency. Pure CSS, no
  // network request — doesn't touch load timing or interactivity at all.
  wrap: { overflow: 'hidden', backgroundColor: '#000000' },
  centre: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  waiting: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  placeholderText: { fontSize: 14, textAlign: 'center' },
  cameraControls: {
    position: 'absolute',
    right: Spacing.three,
    bottom: BottomTabInset + Spacing.three,
    alignItems: 'center',
    gap: Spacing.two,
  },
  // Same 52px circle + shadow language as index.tsx's RoundButton (the
  // pause/stop cluster), but semi-transparent dark rather than a solid
  // session-colour — these aren't destructive/session-critical actions,
  // and need to read against whatever's under them on the map, not just
  // the white idle scrim.
  mapButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.65)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
});
