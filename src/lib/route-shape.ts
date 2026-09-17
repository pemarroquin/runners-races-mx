// Turns a recorded run's path into a flat SVG path string, sized to fit a
// given box — the shape behind the shareable "route sticker" (see
// share-card.tsx). Pure and react-native-svg-free, same testing philosophy
// as territory.ts's geometry pipeline: safe to unit-test directly against
// known tracks with no UI or native module involved.
import type { LatLng } from './territory';

export interface RouteShape {
  /** SVG path `d` attribute, ready to hand to react-native-svg's <Path>. */
  d: string;
  /** True for fewer than 2 usable points — nothing drawable. */
  empty: boolean;
}

const EMPTY_SHAPE: RouteShape = { d: '', empty: true };

/**
 * Projects lat/lng onto a flat plane (longitude scaled by cos(mean
 * latitude) — a local equirectangular approximation, accurate enough at the
 * scale of a single run and the same trick every "shape of my run" sticker
 * uses; the output is decorative, not a map, so a true projection buys
 * nothing) and fits the result inside `width` x `height` minus `padding` on
 * every side, preserving aspect ratio and centering.
 */
export function routeToSvgPath(
  points: LatLng[],
  width: number,
  height: number,
  padding: number,
): RouteShape {
  if (points.length < 2) return EMPTY_SHAPE;

  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);

  // x grows east, y grows NORTH here — flipped to screen space (y down)
  // only in the final projection below, so the bounds math stays ordinary
  // cartesian throughout.
  const xs = points.map((p) => p.lng * cosLat);
  const ys = points.map((p) => p.lat);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;

  const boxW = width - padding * 2;
  const boxH = height - padding * 2;

  // A run that's a straight line in one axis has zero span there — falling
  // back to the other axis' scale (or 1 if both are zero, which only a
  // cluster of identical points can produce) keeps the shape from blowing
  // up to an infinite scale.
  const scale =
    spanX > 0 && spanY > 0
      ? Math.min(boxW / spanX, boxH / spanY)
      : spanX > 0
        ? boxW / spanX
        : spanY > 0
          ? boxH / spanY
          : 1;

  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = padding + (boxW - drawnW) / 2;
  const offsetY = padding + (boxH - drawnH) / 2;

  const d = points
    .map((_, i) => {
      const x = offsetX + (xs[i] - minX) * scale;
      // Flip: increasing latitude (north) must move UP the screen, i.e.
      // toward smaller y — so it's maxY, not minY, that maps to the top.
      const y = offsetY + (maxY - ys[i]) * scale;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return { d, empty: false };
}
