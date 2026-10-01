import { describe, expect, it } from 'vitest';

import { altitudeForZoom, zoomForAltitude, zoomedCamera } from '../src/lib/map-camera';

describe('map-camera', () => {
  it('round-trips zoom through altitude', () => {
    for (const z of [10, 15, 17.5]) expect(zoomForAltitude(altitudeForZoom(z))).toBeCloseTo(z);
  });

  it('zooms an Apple camera, which reports altitude and no zoom', () => {
    const next = zoomedCamera({ altitude: altitudeForZoom(15) }, 1);
    expect(next.zoom).toBeCloseTo(16);
    expect(next.altitude).toBeCloseTo(altitudeForZoom(16));
  });

  it('zooms a Google camera and sets altitude alongside', () => {
    const next = zoomedCamera({ zoom: 14 }, -1);
    expect(next.zoom).toBe(13);
    expect(next.altitude).toBeCloseTo(altitudeForZoom(13));
  });
});
