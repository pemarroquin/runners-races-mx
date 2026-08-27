// Map styling for Territory Mode.
//
// There are TWO style ids here and they are not interchangeable, because the
// two rendering paths accept different kinds of style:
//
// - Mapbox GL JS (web) renders **Mapbox Standard** styles — the new
//   `imports`-based architecture Studio creates by default. That's what
//   MAP_STYLE_GL is.
// - The Static Images API (native, where Expo Go can't load a GL SDK) does
//   NOT render Standard styles. It returns a blank image rather than an
//   error — verified 2026-08-26: the custom style and `mapbox/standard`
//   both came back essentially empty (5KB / 85B) while `mapbox/dark-v11`
//   returned a real 27KB map. So native falls back to a stock classic dark
//   style that looks close.
//
// If the two ever need to match exactly, the fix is to rebuild the custom
// style from a *classic* template in Studio (not Standard) and point both
// constants at it.

/** Custom Studio style — Mapbox Standard, GL JS only (web). */
export const MAP_STYLE_GL = 'mapbox://styles/pmarroquin/cmtapbd8m00zi01qjhx0jbmuh';

/** Classic style for the Static Images API (native). `{owner}/{style}` form. */
export const MAP_STYLE_STATIC = 'mapbox/dark-v11';

/**
 * The map is dark regardless of the app's light/dark setting, deliberately:
 * it's a full-bleed game surface, and the route line and territory fill are
 * tuned for contrast against a dark ground.
 */
export const MAP_ALWAYS_DARK = true;

/**
 * Shared zoom for the Track tab's idle/centred view, both platforms. Was 16
 * on web (track-map.web.tsx) and 15 on native (buildPinMapUrl) — two
 * slightly different hand-picked values for what is visually the same
 * "before you start running" shot, unified here.
 *
 * First dropped 4 levels to 12 (2026-08-26), then walked back — 12 read as
 * zoomed too far out, closer to a city-district view than the neighbourhood
 * shot Google Maps opens to by default (its own default is commonly z15-16:
 * street names legible, a handful of blocks visible, not yet building
 * outlines). Settled at 15 for the same reason. Mapbox Standard (the style
 * this app uses on web, see MAP_STYLE_GL) scales its label text size to
 * zoom automatically as part of the style itself — that's one of Standard's
 * differences from classic styles — so labels shouldn't read as
 * disproportionate at this level the way a fixed-size label layer might.
 */
export const MAP_DEFAULT_ZOOM = 15;

/** Route line. Hex with '#', for GL JS and SVG. */
export const ROUTE_LINE_COLOR = '#E4572E';
/** Same colour without '#', for Static Images URL overlays. */
export const ROUTE_LINE_COLOR_URL = 'e4572e';
export const ROUTE_LINE_WIDTH = 5;
/** Wider, blurred copy under the main line — reads as a glow on dark ground. */
export const ROUTE_GLOW_WIDTH = 14;
export const ROUTE_GLOW_BLUR = 3;
export const ROUTE_GLOW_OPACITY = 0.35;

/** Closed-fence fill on the summary. */
export const FENCE_FILL_OPACITY = 0.25;

/**
 * The live route's vibrant gradient, as `line-gradient` stops (offset 0-1
 * along the drawn line). Reads as the iridescent Apple-AI ramp Pedro asked
 * for: cool at the tail, warm at the head, so the newest stretch is the
 * brightest part of the line and the eye lands on where you are now.
 *
 * `line-gradient` requires `lineMetrics: true` on the GeoJSON source — the
 * property is silently ignored without it, which looks like a flat line
 * rather than an error.
 */
export const ROUTE_GRADIENT: [number, string][] = [
  [0.0, '#4F5BD5'],
  [0.25, '#8A2BE2'],
  [0.45, '#D62976'],
  [0.65, '#F4508B'],
  [0.85, '#FA7E1E'],
  [1.0, '#FEDA75'],
];

/** Trailing distance that stays a flat line before the route sets into wall. */
export const FENCE_LAG_M = 100;
/** Wall thickness on the ground, metres (web — the 3D extrusion gets its
 *  visual bulk from height, so the footprint stays thin). */
export const FENCE_WALL_WIDTH_M = 3;
/** Ribbon width on native, metres. The native fence is a FLAT filled ribbon
 *  (react-native-maps has no fill-extrusion), so without the 18m of wall
 *  height it needs a wider footprint to read as a fence at all — 3m is
 *  ~4px at the session zoom. */
export const FENCE_RIBBON_WIDTH_M = 8;
/** Wall height, metres. */
export const FENCE_WALL_HEIGHT_M = 18;
export const FENCE_WALL_OPACITY = 0.55;
/** Default wall colour — only the pre-session layer setup uses this; each
 *  session repaints with its own set (see FENCE_COLOR_SETS below). */
export const FENCE_WALL_COLOR = '#8A2BE2';

/**
 * Fence colour sets — each run's fence gets ONE of these, so territories are
 * tellable apart on a map of many. Pedro's ask (2026-08-27): "a different
 * color each run", from a configurable list — add/remove/reorder sets here
 * freely (a Settings picker can layer on later).
 *
 * Selection is `fenceColorForRun(startedAtMs)`: deterministic from the run's
 * start time, which is already stored in Supabase (`runs.started_at`) — so
 * every screen on every device derives the SAME colour for the same run with
 * no colour column and no migration (those are applied by hand in this
 * project and an unapplied one fails silently).
 */
export interface FenceColorSet {
  id: string;
  /** '#rrggbb'. Fills/strokes derive their alpha from the FENCE_* opacities. */
  color: string;
}

export const FENCE_COLOR_SETS: FenceColorSet[] = [
  { id: 'violet', color: '#8A2BE2' },
  { id: 'cyan', color: '#22D3EE' },
  { id: 'magenta', color: '#EC4899' },
  { id: 'lime', color: '#A3E635' },
  { id: 'amber', color: '#FBBF24' },
  { id: 'blue', color: '#3B82F6' },
];

export function fenceColorForRun(startedAtMs: number): FenceColorSet {
  // Seconds, not ms: ISO timestamps round-trip through Postgres with ms
  // precision but the maths shouldn't depend on it.
  const seconds = Math.abs(Math.floor(startedAtMs / 1000));
  return FENCE_COLOR_SETS[seconds % FENCE_COLOR_SETS.length];
}

/** '#rrggbb' + alpha → 'rgba(...)', for react-native-maps fill/stroke props. */
export function withAlpha(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha})`;
}
/** Seconds the wall takes to rise once a stretch settles. */
export const FENCE_RISE_MS = 900;

/** Camera framing when a session starts — tilted, so the wall reads as 3D. */
export const SESSION_ZOOM = 17.5;
export const SESSION_PITCH = 60;
export const SESSION_FLY_MS = 2200;

/**
 * Night styling for react-native-maps on Android (Google provider). The
 * native Track map (track-map.tsx) honours MAP_ALWAYS_DARK with this on
 * Android and `userInterfaceStyle="dark"` on iOS — Google ignores that prop
 * and Apple ignores this one, so both are always passed. Google's standard
 * night-mode recipe, trimmed to the layers this map shows.
 */
export const GOOGLE_DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#212121' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#757575' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#181818' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#373737' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3c3c3c' }] },
  { featureType: 'transit', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000000' }] },
];
