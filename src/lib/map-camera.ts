// react-native-maps reads `zoom` on Google and `altitude` on Apple, and each
// platform ignores the other's field — so every native camera change must
// carry both. The mapping is empirical, tuned to visually match the web
// map's zoom levels on a phone viewport: z15 ≈ 960 m (neighbourhood),
// z17.5 ≈ 170 m (street). Shared so no map copies a zoom-only camera that
// silently does nothing on iOS.
export function altitudeForZoom(zoom: number): number {
  return 60 * Math.pow(2, 19 - zoom);
}

/** The inverse, for reading the current zoom back off an Apple camera,
 *  which reports altitude and no zoom. */
export function zoomForAltitude(altitude: number): number {
  return 19 - Math.log2(altitude / 60);
}

/** A camera `delta` zoom levels from the current one, valid on both
 *  providers. */
export function zoomedCamera<T extends { zoom?: number; altitude?: number }>(
  camera: T,
  delta: number,
): T & { zoom: number; altitude: number } {
  const current =
    camera.zoom ?? (camera.altitude !== undefined ? zoomForAltitude(camera.altitude) : 15);
  const zoom = current + delta;
  return { ...camera, zoom, altitude: altitudeForZoom(zoom) };
}
