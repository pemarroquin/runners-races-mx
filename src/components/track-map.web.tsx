// Track tab map — WEB. A real Mapbox GL JS map, not the static image the
// native file uses.
//
// This split exists because of a hard API limit, not preference: the Static
// Images API cannot render Mapbox Standard styles (the `imports`-based kind
// Studio creates by default) — it returns a blank image, no error. GL JS
// renders them fine, so the custom Studio style can only be used here. See
// constants/map.ts.
//
// GL JS also buys what a baked PNG structurally cannot: a gradient route
// line, an extruded 3D fence, and a camera that moves. The route renders in
// two pieces while running — see fence-3d.ts for the split.
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
// its intended brightness (P3 §7a). The live territory fill (FILL_SRC) is
// new for the same reason it was missing before: there was no fill layer at
// all, only two lines and one fill-extrusion.
//
// Two things animate continuously while a session is live, so the map
// doesn't read as flat/static even when the runner is standing still: the
// fill breathes between LIVE_FILL_OPACITY_LOW/HIGH, and the route line (plus
// the fill's own rim, FILL_OUTLINE_SRC) cycles through ROUTE_GRADIENT's
// colours via rotateRouteGradient. Both are plain setInterval timers, not
// requestAnimationFrame loops — see the pulse-dot comment below.
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import type { GeoJSONSource, Map as MapboxMap, Marker } from 'mapbox-gl';
import mapboxGlPkg from 'mapbox-gl/package.json';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Spacing } from '@/constants/theme';
import {
  AUTO_RETURN_IDLE_MS,
  EMISSIVE_STRENGTH_FULL,
  FENCE_LAG_M,
  FENCE_RISE_MS,
  FENCE_WALL_COLOR,
  FENCE_WALL_HEIGHT_M,
  FENCE_WALL_OPACITY,
  FENCE_WALL_WIDTH_M,
  LIVE_FILL_OPACITY_HIGH,
  LIVE_FILL_OPACITY_LOW,
  LIVE_FILL_OUTLINE_WIDTH,
  LIVE_FILL_PULSE_MS,
  LIVE_FILL_RECOMPUTE_MS,
  LIVE_FILL_RECOMPUTE_POINTS,
  MAP_DEFAULT_ZOOM,
  MAP_SLOT_FILL,
  MAP_SLOT_ROUTE,
  MAP_STYLE_GL,
  ROUTE_GLOW_BLUR,
  ROUTE_GLOW_OPACITY,
  ROUTE_GLOW_WIDTH,
  ROUTE_GRADIENT,
  ROUTE_GRADIENT_CYCLE_MS,
  ROUTE_LINE_COLOR,
  ROUTE_LINE_WIDTH,
  rotateRouteGradient,
  SESSION_FLY_MS,
  SESSION_PITCH,
  SESSION_ZOOM,
  ZOOM_STEP,
} from '@/constants/map';
import { buildWallPolygon, splitTrailing } from '@/lib/fence-3d';
import { useRegion } from '@/lib/region-context';
import { buildFence, outerRings, type LatLng } from '@/lib/territory';

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_CSS_URL = `https://api.mapbox.com/mapbox-gl-js/v${mapboxGlPkg.version}/mapbox-gl.css`;
const ROUTE_SRC = 'run-route';
const WALL_SRC = 'run-wall';
const FILL_SRC = 'run-fill';
const FILL_OUTLINE_SRC = 'run-fill-outline';
const PULSE_STYLE_ID = 'track-pulse-style';

interface TrackMapProps {
  points: LatLng[];
  running: boolean;
  /** A real fix, or null. Never a fallback — see use-current-location.ts. */
  here: LatLng | null;
  /** True once a session is live: drives the fly-in and the 3D framing. */
  active: boolean;
  /** This run's fence colour ('#rrggbb') — see FENCE_COLOR_SETS. */
  fenceColor: string;
  dark: boolean;
  color: ColorValue;
  placeholder: string;
  placeholderColor: ColorValue;
  unavailable: string;
  /** Accessibility labels for the camera controls (Task D) — passed in
   *  pre-translated, matching every other string on this component. */
  zoomInLabel: string;
  zoomOutLabel: string;
  recenterLabel: string;
}

function ensureMapboxCss() {
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
}

// The "you are here" pulse. A keyframed DOM element rather than a GL layer:
// GL has no repeating animation primitive, so driving one would mean a
// requestAnimationFrame loop repainting the map every frame for the whole
// run — this costs nothing and the compositor handles it.
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
}`;
  document.head.appendChild(style);
}

export function TrackMap({
  points,
  running,
  here,
  active,
  fenceColor,
  placeholder,
  placeholderColor,
  unavailable,
  zoomInLabel,
  zoomOutLabel,
  recenterLabel,
}: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const readyRef = useRef(false);
  const flownRef = useRef(false);
  // Throttle state for the live territory fill — see LIVE_FILL_RECOMPUTE_MS.
  const lastFillRef = useRef({ atMs: 0, pointCount: 0 });
  // The two "feels alive even standing still" animation timers — JS
  // intervals, not requestAnimationFrame loops (see the pulse-dot comment
  // below for why that distinction matters for the length of a run).
  // Started inside the map's 'load' handler, where the layers they animate
  // are guaranteed to already exist; cleared in the mount effect's cleanup.
  const fillPulseIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const routeCycleIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Camera control during a session (Task D). preferredZoom is a REF, not
  // state: the zoom buttons write it and the auto-return glide reads it
  // imperatively from inside an event listener/timeout, seconds after the
  // render that set it — a ref avoids both a stale closure and
  // re-subscribing every listener on every zoom tap. Survives a session
  // (not reset on pause/resume) because it is a user preference, not
  // per-leg state.
  const preferredZoomRef = useRef(SESSION_ZOOM);
  // The runner's latest known position, mirrored from the "feed
  // coordinates in" effect below (the same `head` it already computes) so
  // the auto-return glide — fired from a setTimeout, not a render — always
  // targets where the runner IS, not wherever they were when the 5s timer
  // was scheduled.
  const headRef = useRef<LatLng | null>(null);
  const autoReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drives the re-center control's visibility — true from the moment a user
  // gesture (drag/pinch) moves the camera until it glides back, whether
  // that's the auto-return timer or an explicit tap.
  const [cameraOffTarget, setCameraOffTarget] = useState(false);
  const { region } = useRegion();

  // Glides the camera back to (runner position, preferredZoom,
  // SESSION_PITCH) — the ONE definition auto-return, the re-center button,
  // and the pin double-tap all share, so "deliberate zoom survives, stray
  // drift doesn't" can't drift out of sync between the three entry points.
  const returnToTarget = useCallback(() => {
    const map = mapRef.current;
    const head = headRef.current;
    if (autoReturnTimerRef.current) {
      clearTimeout(autoReturnTimerRef.current);
      autoReturnTimerRef.current = null;
    }
    setCameraOffTarget(false);
    if (!map || !head) return; // nothing to target yet — just clear the pending timer/flag
    map.easeTo({
      center: [head.lng, head.lat],
      zoom: preferredZoomRef.current,
      pitch: SESSION_PITCH,
      duration: 900,
    });
  }, []);

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

  // Built once. Re-creating the map when points change would tear down and
  // re-instantiate a WebGL context on every GPS fix.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    (async () => {
      ensureMapboxCss();
      ensurePulseStyle();
      const { default: mapboxgl } = await import('mapbox-gl');
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: MAP_STYLE_GL,
        center: [initialLng, initialLat],
        zoom: MAP_DEFAULT_ZOOM,
        attributionControl: false,
      });
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;

        // Rotate/pitch gestures, gone entirely — not just during a session.
        // SESSION_PITCH is set once for the 3D look and a runner has no
        // reason to change it via gesture; on the idle (pre-session) map
        // pitch is already flat, so there is nothing legitimate to disable
        // FROM either way. This is the fix for the actual bug: one stray
        // pinch or two-finger drag used to permanently change the framing,
        // with no interaction detection and no way back (Pedro hit this
        // mid-run: "normal at first, then weird").
        map.dragRotate.disable();
        map.touchPitch.disable();
        map.touchZoomRotate.disableRotation(); // pinch-zoom itself stays on

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
        // The live territory fill — was entirely missing (P3 §7b: two line
        // layers and one fill-extrusion existed, no fill, so the enclosed
        // area never shaded in while running). Fed by a throttled
        // buildFence() below, not lineMetrics — a fill has no line-progress.
        map.addSource(FILL_SRC, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // The fill's chromatic rim — same technique as the route line and
        // the (now fixed) summary outline, traced around the growing
        // territory's edge instead of the path. Fed alongside FILL_SRC by
        // the same throttled buildFence() below.
        map.addSource(FILL_OUTLINE_SRC, {
          type: 'geojson',
          lineMetrics: true,
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
            // Flattened [offset, color, ...] — the expression form
            // line-gradient requires.
            'line-gradient': [
              'interpolate',
              ['linear'],
              ['line-progress'],
              ...ROUTE_GRADIENT.flat(),
            ] as unknown as string,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
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
        // Live territory fill. Below the wall in the layer list so the wall
        // still reads as a distinct rising edge rather than being swallowed
        // by the flat fill under it; same MAP_SLOT_FILL as the wall, so both
        // sit above roads and below buildings/labels together.
        //
        // fill-opacity starts LOW, not LIVE_FILL_OPACITY_HIGH: the pulse
        // interval below immediately starts alternating it, and starting at
        // the low end means the very first fence that appears fades UP
        // rather than snapping straight to full — same "eases in" feel as
        // the wall's own rise.
        map.addLayer({
          id: FILL_SRC,
          type: 'fill',
          source: FILL_SRC,
          slot: MAP_SLOT_FILL,
          paint: {
            'fill-color': FENCE_WALL_COLOR,
            'fill-opacity': LIVE_FILL_OPACITY_LOW,
            'fill-opacity-transition': { duration: LIVE_FILL_PULSE_MS, delay: 0 },
            'fill-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        }, WALL_SRC);
        map.addLayer({
          id: FILL_OUTLINE_SRC,
          type: 'line',
          source: FILL_OUTLINE_SRC,
          slot: MAP_SLOT_ROUTE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-width': LIVE_FILL_OUTLINE_WIDTH,
            'line-color': ROUTE_GRADIENT[0][1], // fallback — see the route line's own comment above
            'line-gradient': [
              'interpolate',
              ['linear'],
              ['line-progress'],
              ...ROUTE_GRADIENT.flat(),
            ] as unknown as string,
            'line-emissive-strength': EMISSIVE_STRENGTH_FULL,
          },
        });

        // "Feels alive even standing still" (mid-run, not idling — see the
        // dedicated effect below that arms these) — both timers are plain
        // setInterval, not requestAnimationFrame: see this file's pulse-dot
        // comment for why a per-frame GL repaint for the whole length of a
        // run is the specific trap being avoided. Each tick is one cheap
        // setPaintProperty call, not a geometry rebuild.

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
          returnToTarget();
        });
        markerRef.current = new mapboxgl.Marker({ element: el });
        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      flownRef.current = false;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mount-only: later camera/marker changes move the existing map rather
    // than rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arms the fill-breathe and route-colour-cycle timers ONLY while a session
  // is active — gated here, not inside the mount effect above, specifically
  // because they used to run from map mount to unmount regardless of
  // whether a run was in progress. Sitting on the Track tab with no run
  // recording cost ~2.2 setPaintProperty calls per second, each forcing a
  // map repaint, indefinitely, on an empty fill source — directly undoing
  // P0.1 bug 3, which exists specifically to stop the idle screen burning
  // battery (see GeoWatchOptions.highAccuracy). This is a running app; the
  // phone has to survive 40+ minutes with the screen on. "Feels alive even
  // standing still" means standing still MID-RUN, not idling in the app.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !active) return;

    // The fill breathes between LIVE_FILL_OPACITY_LOW/HIGH — GL interpolates
    // fill-opacity on the GPU between calls via the fill-opacity-transition
    // set when the layer was created, so this reads as a smooth pulse from
    // one JS call every LIVE_FILL_PULSE_MS.
    let fillHigh = false;
    fillPulseIntervalRef.current = setInterval(() => {
      fillHigh = !fillHigh;
      map.setPaintProperty(
        FILL_SRC,
        'fill-opacity',
        fillHigh ? LIVE_FILL_OPACITY_HIGH : LIVE_FILL_OPACITY_LOW,
      );
    }, LIVE_FILL_PULSE_MS);

    // The route (and its rim twin) cycle colour instead: unlike fill-opacity,
    // line-gradient is a ColorRampProperty with no `-transition` support at
    // all (confirmed against the installed mapbox-gl typings) — every update
    // SNAPS, there's no GPU tween to lean on. rotateRouteGradient keeps the
    // offsets fixed and only rotates which colour sits at which one, so this
    // reads as a stepped shift, not a silky flow — an honest limit of the API.
    let step = 0;
    routeCycleIntervalRef.current = setInterval(() => {
      step += 1;
      const gradient = [
        'interpolate',
        ['linear'],
        ['line-progress'],
        ...rotateRouteGradient(step).flat(),
      ] as unknown as string;
      map.setPaintProperty(ROUTE_SRC, 'line-gradient', gradient);
      map.setPaintProperty(FILL_OUTLINE_SRC, 'line-gradient', gradient);
    }, ROUTE_GRADIENT_CYCLE_MS);

    return () => {
      if (fillPulseIntervalRef.current) clearInterval(fillPulseIntervalRef.current);
      if (routeCycleIntervalRef.current) clearInterval(routeCycleIntervalRef.current);
      fillPulseIntervalRef.current = null;
      routeCycleIntervalRef.current = null;
    };
  }, [active]);

  // Auto-return after AUTO_RETURN_IDLE_MS of no further interaction — gated
  // on `active` the same way as the animation timers above: this exists to
  // repair sweaty-hands drift mid-run, not to herd someone idly exploring
  // the pre-session map back to their own position.
  //
  // `originalEvent` is present on Mapbox's own camera events ONLY when a
  // user gesture triggered them — absent for our own easeTo/flyTo calls
  // (the fly-in, the live follow, returnToTarget itself) — which is the one
  // reliable way to tell "the runner touched the map" apart from every
  // OTHER thing in this file that already moves the camera. Listens to
  // dragend/zoomend specifically, not moveend: rotate/pitch are disabled
  // above, so drag and pinch-zoom are the only gestures left that can
  // actually originate a user move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !active) return;

    // Typed `unknown`, not Mapbox's own per-event shape: 'dragend' and
    // 'zoomend' carry slightly different originalEvent union types, and the
    // 'void' branch some of these events' types include resolves (via
    // Mapbox's internal event-map machinery) to a bare {type, target} shape
    // with no originalEvent at all — no single object type satisfies every
    // variant. `unknown` is the top type, so this is valid for any of them;
    // narrowed by hand at runtime instead.
    const onUserMove = (e: unknown) => {
      const originalEvent = (e as { originalEvent?: unknown } | null | undefined)?.originalEvent;
      if (!originalEvent) return;
      setCameraOffTarget(true);
      if (autoReturnTimerRef.current) clearTimeout(autoReturnTimerRef.current);
      autoReturnTimerRef.current = setTimeout(returnToTarget, AUTO_RETURN_IDLE_MS);
    };

    map.on('dragend', onUserMove);
    map.on('zoomend', onUserMove);

    return () => {
      map.off('dragend', onUserMove);
      map.off('zoomend', onUserMove);
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
      setCameraOffTarget(false);
    };
  }, [active, returnToTarget]);

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
    // Mirrored for returnToTarget (Task D), which reads this from a
    // setTimeout/event listener rather than a render.
    headRef.current = head;
    if (!head) {
      marker.remove();
      return;
    }
    marker.setLngLat([head.lng, head.lat]).addTo(map);
  }, [points, here]);

  // Idle: keep the camera over the runner as they move, so the map isn't
  // still framing wherever they were when the tab opened. Skipped during a
  // session — the fly-in and follow below own the camera then.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || active || !here) return;
    map.easeTo({ center: [here.lng, here.lat], duration: 600 });
  }, [here, active]);

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
      duration: SESSION_FLY_MS,
      essential: true,
    });
  }, [active, points, here]);

  // Per-run fence colour. The wall and fill layers are created once at mount
  // (before any session exists) with the default FENCE_WALL_COLOR, so the
  // run's own colour is applied as a paint update — cheap, no layer churn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty(WALL_SRC, 'fill-extrusion-color', fenceColor);
    map.setPaintProperty(FILL_SRC, 'fill-color', fenceColor);
  }, [fenceColor, active]);

  // Feed coordinates in. setData on an existing source is the cheap path —
  // no layer or style churn, so the line simply extends.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const { settled, active: liveEdge } = splitTrailing(points, FENCE_LAG_M);

    const routeSource = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
    routeSource?.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: liveEdge.map((p) => [p.lng, p.lat] as [number, number]),
      },
    });

    const wall = buildWallPolygon(settled, FENCE_WALL_WIDTH_M);
    const wallSource = map.getSource(WALL_SRC) as GeoJSONSource | undefined;
    wallSource?.setData(
      wall ? { type: 'FeatureCollection', features: [wall] } : { type: 'FeatureCollection', features: [] },
    );

    // Live territory fill — throttled to every LIVE_FILL_RECOMPUTE_POINTS
    // points or LIVE_FILL_RECOMPUTE_MS, whichever comes first, NOT on every
    // fix: buildFence runs turf's clean/simplify/union pipeline, O(n) on a
    // ring that only grows, and this effect re-runs on every accepted point
    // for the whole length of a run. Uses the FULL point list, not `settled`
    // (the wall's lag-trimmed input) — a fill lagging the same ~100m behind
    // the runner would leave a visible, unshaded gap right where they
    // currently are, which the wall's live-edge line segment already covers
    // for the route itself.
    const now = Date.now();
    const last = lastFillRef.current;
    const fillSource = map.getSource(FILL_SRC) as GeoJSONSource | undefined;
    const outlineSource = map.getSource(FILL_OUTLINE_SRC) as GeoJSONSource | undefined;
    if (points.length < 3) {
      // Below buildFence's own minimum — most commonly a fresh run just
      // reset `points` to []. Cleared UNCONDITIONALLY, outside the throttle:
      // without this the fill (and its rim) kept showing the PREVIOUS run's
      // polygon (the throttle's own point-count baseline had reset too, so
      // the "enough new points" branch below wouldn't trip again for a
      // while).
      lastFillRef.current = { atMs: now, pointCount: points.length };
      fillSource?.setData({ type: 'FeatureCollection', features: [] });
      outlineSource?.setData({ type: 'FeatureCollection', features: [] });
    } else if (
      points.length - last.pointCount >= LIVE_FILL_RECOMPUTE_POINTS ||
      now - last.atMs >= LIVE_FILL_RECOMPUTE_MS
    ) {
      lastFillRef.current = { atMs: now, pointCount: points.length };
      // buildFence returns null for anything too short/collinear to enclose
      // an area — that's "no fill yet", not an error (territory.ts's own
      // contract; never throws).
      const fence = buildFence(points);
      fillSource?.setData(fence ? fence.geometry : { type: 'FeatureCollection', features: [] });
      outlineSource?.setData(
        fence
          ? {
              type: 'FeatureCollection',
              features: outerRings(fence.geometry.geometry).map((ring) => ({
                type: 'Feature' as const,
                properties: {},
                geometry: { type: 'LineString' as const, coordinates: ring },
              })),
            }
          : { type: 'FeatureCollection', features: [] },
      );
    }

    // Follow only while recording: panning the camera under someone reading
    // their finished route would fight them. Follows the raw fix (`here`)
    // when there is one, for the same reason as the marker above.
    const head = here ?? points[points.length - 1];
    if (head && running && flownRef.current) {
      map.easeTo({ center: [head.lng, head.lat], duration: 900 });
    }
  }, [points, running, here]);

  if (!TOKEN) {
    return (
      <View style={[styles.wrap, StyleSheet.absoluteFill, styles.centre]}>
        <Text style={[styles.placeholderText, { color: placeholderColor }]}>{unavailable}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, StyleSheet.absoluteFill]}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {points.length === 0 && running && (
        <View style={styles.waiting}>
          <Text style={[styles.placeholderText, { color: placeholderColor }]}>{placeholder}</Text>
        </View>
      )}
      {/* Camera controls (Task D) — reliable targets for sweaty hands where
          pinch is not. Bottom-right, matching where a thumb naturally rests;
          the app's own circular-button language (see index.tsx's
          RoundButton), not Mapbox's NavigationControl — foreign styling,
          and its compass would be meaningless with rotation disabled. */}
      {active && (
        <View style={styles.cameraControls} pointerEvents="box-none">
          {cameraOffTarget && (
            <MapButton label={recenterLabel} onPress={returnToTarget} ios="location.fill" android="my_location" />
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
  wrap: { overflow: 'hidden' },
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
