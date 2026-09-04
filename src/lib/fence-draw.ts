// Drawing helpers for the fence/route renderers on BOTH platforms, kept
// here (pure, no renderer imports) so they stay unit-testable without a GL
// context or a React renderer:
//
//   - GeoJSON ring extraction for react-native-maps.
//   - Per-vertex sampling of the route gradient — GL JS interpolates
//     `line-gradient` on the GPU on web, but react-native-maps' Polyline
//     needs one explicit colour per coordinate.
//   - The cyclic/flowing form of that same gradient, plus the flattened
//     `interpolate` expression the web layers hand to `line-gradient`. Only
//     the web renderers animate it (see gradient-flow.ts); on native a
//     flowing gradient would mean re-rendering the whole Polyline every
//     tick, so gradientStrokeColors stays static there.
import type { MultiPolygon, Polygon, Position } from 'geojson';

import { ROUTE_GRADIENT, ROUTE_GRADIENT_COLORS } from '@/constants/map';

export interface MapCoord {
  latitude: number;
  longitude: number;
}

/** GeoJSON [lng,lat] ring → react-native-maps coordinate list. */
export function ringToCoords(ring: Position[]): MapCoord[] {
  return ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
}

/**
 * (Multi)Polygon → its polygons' rings, each as [outer, ...holes]. Callers
 * feed outer to react-native-maps' `coordinates` and the rest to `holes`.
 */
export function polygonRings(geometry: Polygon | MultiPolygon): Position[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

/** Linear blend of two '#rrggbb' colours. */
function hexLerp(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 0xff;
    const vb = (pb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Colour at offset t ∈ [0,1] along ROUTE_GRADIENT — cool tail, warm head. */
export function gradientColorAt(t: number): string {
  const stops = ROUTE_GRADIENT;
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [offset, color] = stops[i];
    if (t <= offset) {
      const [prevOffset, prevColor] = stops[i - 1];
      return hexLerp(prevColor, color, (t - prevOffset) / (offset - prevOffset));
    }
  }
  return stops[stops.length - 1][1];
}

/** One gradient colour per vertex, for Polyline `strokeColors`. */
export function gradientStrokeColors(count: number): string[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) =>
    gradientColorAt(count === 1 ? 1 : i / (count - 1)),
  );
}

/**
 * ROUTE_GRADIENT_COLORS sampled as the WHEEL it is: colour(t) === colour(t+1),
 * because entry 11 blends straight back into entry 0 over one more even leg.
 * Every leg is 1/12 of a turn, the wrap included — there is no seam and no
 * special case at it.
 *
 * That evenness is why the wheel has to be a wheel. Two earlier shapes were
 * tried against the old 6-colour ramp, which spanned only indigo to gold:
 * blending its warm end straight back to its cool start put a desaturated
 * mauve (~#A69AA5) band circulating forever through a gradient whose whole
 * job is to look vibrant, and mirroring the ramp (cool -> warm -> cool)
 * avoided that but made the flow visibly bounce at the turning points
 * instead of travelling. Closing the hue circle properly does neither.
 *
 * `t - Math.floor(t)` rather than `((t % 1) + 1) % 1`: the modulo form is
 * off by an ulp for values like 0.82, which is enough to land on the wrong
 * side of a branch. Any real t works; negatives wrap correctly too.
 *
 * gradientColorAt() above is deliberately NOT cyclic — it walks
 * ROUTE_GRADIENT's explicit offsets once, clamping outside them. This one is
 * for anything that loops.
 */
export function cyclicGradientColorAt(t: number): string {
  const colors = ROUTE_GRADIENT_COLORS;
  const n = colors.length;
  const p = (t - Math.floor(t)) * n;
  const i = Math.floor(p);
  return hexLerp(colors[i % n], colors[(i + 1) % n], p - i);
}

/**
 * The wheel as `line-gradient` stops, rotated by `phase` (0-1, wraps).
 * Increasing phase travels the colours toward offset 1: the head of a live
 * route, once around a closed territory ring. Offsets 0 and 1 always resolve
 * to the same colour, so a ring joined end to end has no visible seam.
 *
 * The stops land on the wheel's OWN boundaries (shifted by phase), not on a
 * fixed grid the wheel is resampled onto. Two things follow, and both
 * matter:
 *
 *   - It is EXACT. A fixed grid has to be dense enough to not round off the
 *     corners where one colour meets the next; boundaries have no corners to
 *     round, at any density.
 *   - It is SMALL — 13 or 14 stops instead of the 48 a grid needed for the
 *     same fidelity. Mapbox re-parses this expression on every
 *     setPaintProperty call, once per animated layer per tick, so stop count
 *     is the cost that scales with how many territories are on screen.
 *
 * The offsets still never move BACKWARD past each other — they slide as one
 * block and re-enter at 0, which keeps them strictly increasing, which is
 * what `interpolate` requires (an unsorted expression is rejected silently:
 * a frozen line, not an error).
 */
export function flowingRouteGradient(phase: number): [number, string][] {
  const colors = ROUTE_GRADIENT_COLORS;
  const n = colors.length;
  const leg = 1 / n;
  const p = phase - Math.floor(phase);
  // Whole legs the phase has advanced, and where the first boundary has slid
  // to inside the leg it started in.
  const advanced = Math.floor(p * n);
  const first = p - advanced * leg;
  // The colour at offset 0 — mid-leg, since the wrapped leg is what straddles
  // the line's two ends. Repeated at offset 1 to close the loop.
  const edge = cyclicGradientColorAt(-p);

  const stops: [number, string][] = [];
  // Skipped when the first boundary has slid exactly onto 0, which would
  // otherwise emit offset 0 twice and break "strictly increasing".
  if (first > 0) stops.push([0, edge]);
  for (let j = 0; j < n; j++) {
    stops.push([first + j * leg, colors[(((j - advanced) % n) + n) % n]]);
  }
  stops.push([1, edge]);
  return stops;
}

/**
 * Flattened `interpolate` expression for a line layer's `line-gradient`.
 * Cast because mapbox-gl's typings declare that paint property as a string,
 * while it in fact requires an expression array.
 *
 * Defaults to the plain (non-cyclic) ramp — what a layer is created with
 * before any flow starts, and what it keeps if nothing ever animates it.
 */
export function lineGradientExpression(stops: [number, string][] = ROUTE_GRADIENT): string {
  return ['interpolate', ['linear'], ['line-progress'], ...stops.flat()] as unknown as string;
}
