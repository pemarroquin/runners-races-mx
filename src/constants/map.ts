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
