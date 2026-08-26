// Live route / fence drawing. Deliberately NOT a basemap: this renders many
// times a minute while a run is in progress, and the two map options in this
// project are both wrong for that — react-native-maps needs a Google API key
// on Android (which is exactly why route-map.tsx doesn't use it) and the
// Mapbox Static Images API is a network round-trip per repaint. An SVG trace
// costs nothing, works offline, and needs no key. The finished fence is shown
// over real streets on the summary instead (see buildFenceMapUrl in mapbox.ts).
import { useState } from 'react';
import { StyleSheet, View, type ColorValue, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Polygon, Polyline } from 'react-native-svg';

import type { LatLng } from '@/lib/territory';

interface RouteTraceProps {
  points: LatLng[];
  /** Draw as a closed, filled shape (the fence) rather than an open path. */
  closed?: boolean;
  color: ColorValue;
  height: number;
}

const PADDING = 16;
const MIN_POINTS = 2;

export function RouteTrace({ points, closed = false, color, height }: RouteTraceProps) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const ready = points.length >= MIN_POINTS && width > 0;
  const projected = ready ? project(points, width, height) : [];
  const coordString = projected.map(([x, y]) => `${x},${y}`).join(' ');
  const head = projected[projected.length - 1];

  return (
    <View style={{ height }} onLayout={onLayout}>
      {ready && (
        <Svg width="100%" height={height} style={StyleSheet.absoluteFill}>
          {closed ? (
            <Polygon
              points={coordString}
              fill={color}
              fillOpacity={0.22}
              stroke={color}
              strokeWidth={3}
            />
          ) : (
            <Polyline
              points={coordString}
              fill="none"
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {/* Current position, so a run in progress reads as live rather than
              as a static squiggle. Suppressed on the closed fence, where there
              is no "current" point any more. */}
          {!closed && <Circle cx={head[0]} cy={head[1]} r={5} fill={color} />}
        </Svg>
      )}
    </View>
  );
}

/**
 * lat/lng → view coordinates, aspect-preserving and centred.
 *
 * Longitude degrees are narrower than latitude degrees by cos(lat), so a
 * naive independent x/y normalisation stretches every route sideways — a
 * square lap around a block renders as a wide rectangle. Scaling by a
 * single factor after the cos correction keeps the drawn shape honest,
 * which matters here because the shape IS the territory.
 */
function project(points: LatLng[], width: number, height: number): [number, number][] {
  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const cos = Math.cos((meanLat * Math.PI) / 180);

  const xs = points.map((p) => p.lng * cos);
  const ys = points.map((p) => -p.lat);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const usableW = Math.max(1, width - PADDING * 2);
  const usableH = Math.max(1, height - PADDING * 2);

  // A perfectly straight out-and-back has zero span on one axis; guard the
  // divide rather than emitting NaN coordinates, which render as nothing at
  // all and look like a broken screen.
  const scale = Math.min(
    spanX > 0 ? usableW / spanX : Infinity,
    spanY > 0 ? usableH / spanY : Infinity,
  );
  const safeScale = Number.isFinite(scale) ? scale : 1;

  const offsetX = (width - spanX * safeScale) / 2;
  const offsetY = (height - spanY * safeScale) / 2;

  return points.map((_, i) => [
    offsetX + (xs[i] - minX) * safeScale,
    offsetY + (ys[i] - minY) * safeScale,
  ]);
}
