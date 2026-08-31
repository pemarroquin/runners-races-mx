// The GPS accuracy filter's accept/reject rule.
//
// These exist because of a real device bug (2026-08-27): near an office
// building every fix reported >100m accuracy, the filter rejected all of
// them, and the route never grew past its single seed point — so no line was
// ever drawn. Pausing and resuming was the only thing that worked, because
// resume() clears `lastRef` and the first fix of a leg bypasses the filter.
//
// The rule that fixes it: reject OUTLIERS, never the environment.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GeoFix } from '../src/lib/geolocation.web';
import { requestPermission, watch } from '../src/lib/geolocation.web';
import { shouldAcceptFix } from '../src/lib/tracking';

describe('shouldAcceptFix', () => {
  it('always keeps the first fix of a leg, however poor', () => {
    expect(
      shouldAcceptFix({ isFirst: true, accuracyM: 5000, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('keeps an accurate fix', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 12, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('drops an isolated poor fix — outlier rejection still works', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 400, consecutiveRejects: 0 }),
    ).toBe(false);
  });

  it('FAILS OPEN once poor fixes are sustained — the office-building bug', () => {
    // Three in a row means this is the environment, not an outlier. A
    // degraded route beats no route at all.
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 400, consecutiveRejects: 3 }),
    ).toBe(true);
  });

  it('never starves the track no matter how long the signal stays poor', () => {
    // The actual regression: with an unconditional filter, every one of
    // these was dropped and the route stayed a single point forever.
    let consecutiveRejects = 0;
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      if (shouldAcceptFix({ isFirst: false, accuracyM: 250, consecutiveRejects })) {
        accepted++;
        consecutiveRejects = 0;
      } else {
        consecutiveRejects++;
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it('keeps a fix that reports no accuracy at all', () => {
    // Nothing to judge on — dropping these would discard usable positions on
    // any platform that omits the field.
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: null, consecutiveRejects: 0 }),
    ).toBe(true);
  });

  it('honours the boundary exactly', () => {
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 100, consecutiveRejects: 0, maxAccuracyM: 100 }),
    ).toBe(true);
    expect(
      shouldAcceptFix({ isFirst: false, accuracyM: 101, consecutiveRejects: 0, maxAccuracyM: 100 }),
    ).toBe(false);
  });
});

// geolocation.web.ts's watch() — the fix for the three expo-location web-shim
// defects (Web-First Pilot P0 brief, §2). These test the file directly by
// its `.web` suffix rather than through the '@/lib/geolocation' alias tsc
// resolves to geolocation.ts by default outside Metro; the point of these
// tests is the browser-specific throttle/remove/error-mapping logic that
// only geolocation.web.ts contains.
//
// A minimal stand-in for the browser's Geolocation API. Deliberately does
// NOT gate `trigger()` on a prior clearWatch() call — a real browser can
// still deliver an already-queued callback after clearWatch() runs, which is
// exactly the "late callback" scenario defect (a) needs guarding against.
// That guard has to live in geolocation.web.ts itself (the `removed` flag),
// not in this fake.
class FakeGeolocation {
  private success: PositionCallback | null = null;
  private error: PositionErrorCallback | null = null;
  private currentSuccess: PositionCallback | null = null;
  private currentError: PositionErrorCallback | null = null;
  lastWatchId = 0;
  /** Options watchPosition() was last called with — lets a test assert what
   *  actually reaches the browser (e.g. enableHighAccuracy). */
  lastWatchOptions: PositionOptions | undefined;
  lastGetCurrentOptions: PositionOptions | undefined;

  watchPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number {
    this.success = success;
    this.error = error ?? null;
    this.lastWatchOptions = options;
    this.lastWatchId += 1;
    return this.lastWatchId;
  }

  clearWatch(): void {
    // Intentionally a no-op — see the class comment.
  }

  getCurrentPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): void {
    this.currentSuccess = success;
    this.currentError = error ?? null;
    this.lastGetCurrentOptions = options;
  }

  trigger(position: GeolocationPosition): void {
    this.success?.(position);
  }

  triggerError(err: GeolocationPositionError): void {
    this.error?.(err);
  }

  triggerCurrent(position: GeolocationPosition): void {
    this.currentSuccess?.(position);
  }

  triggerCurrentError(err: GeolocationPositionError): void {
    this.currentError?.(err);
  }
}

function makePosition(lat: number, lng: number, ts: number, accuracy: number | null = 10): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: ts,
    toJSON: () => ({}),
  } as GeolocationPosition;
}

function makeError(code: number): GeolocationPositionError {
  return {
    code,
    message: '',
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe('geolocation.web watch()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops a fix that is both too soon and too close, but lets either threshold alone through', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixes: GeoFix[] = [];

    await watch({ timeIntervalMs: 2000, distanceIntervalM: 5, highAccuracy: true }, (f) => fixes.push(f), () => {});

    fakeGeo.trigger(makePosition(19.4, -99.1, 0)); // first fix — always emits
    fakeGeo.trigger(makePosition(19.4, -99.1, 1000)); // 1s, 0m — both fail, dropped
    fakeGeo.trigger(makePosition(19.4, -99.1, 3000)); // 3s, 0m — time alone passes
    fakeGeo.trigger(makePosition(19.4001, -99.1, 3500)); // 0.5s, ~11m — distance alone passes

    expect(fixes).toHaveLength(3);
  });

  it('always emits the first fix of a watch, however soon or close', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixes: GeoFix[] = [];

    await watch({ timeIntervalMs: 999_999, distanceIntervalM: 999_999, highAccuracy: true }, (f) => fixes.push(f), () => {});
    fakeGeo.trigger(makePosition(19.4, -99.1, 0));

    expect(fixes).toHaveLength(1);
  });

  it('ignores a late callback after remove() — the watch-id-recycling bug', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const fixes: GeoFix[] = [];

    const sub = await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true }, (f) => fixes.push(f), () => {});
    sub.remove();
    fakeGeo.trigger(makePosition(19.4, -99.1, 0));

    expect(fixes).toHaveLength(0);
  });

  it.each([
    [1, 'permission'],
    [2, 'unavailable'],
    [3, 'timeout'],
  ])('maps browser error code %d to %s', async (code, expectedKind) => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    const kinds: string[] = [];

    await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true }, () => {}, (kind) => kinds.push(kind));
    fakeGeo.triggerError(makeError(code));

    expect(kinds).toEqual([expectedKind]);
  });

  it("forwards GeoWatchOptions.highAccuracy as the browser's enableHighAccuracy", async () => {
    const fakeGeoOff = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeoOff });
    await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: false }, () => {}, () => {});
    expect(fakeGeoOff.lastWatchOptions?.enableHighAccuracy).toBe(false);

    const fakeGeoOn = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeoOn });
    await watch({ timeIntervalMs: 0, distanceIntervalM: 0, highAccuracy: true }, () => {}, () => {});
    expect(fakeGeoOn.lastWatchOptions?.enableHighAccuracy).toBe(true);
  });
});

// requestPermission()'s fallback probe (navigator.permissions unavailable, or
// its query resolved 'prompt'). P0.1 bug 1: the probe used to reuse the
// high-accuracy, 30s-timeout POSITION_OPTIONS meant for the real watch — a
// cold high-accuracy fix in an urban canyon can exceed 30s, and start() in
// tracking.ts awaits this probe, so a TIMEOUT there hard-failed Start on a
// phone with perfectly good GPS. A TIMEOUT means the user allowed access and
// the receiver is merely slow (PERMISSION_DENIED is the separate code for an
// actual denial) — the watcher, with its own longer timeout, is what
// actually recovers.
describe('geolocation.web requestPermission() probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves granted on a probe TIMEOUT, not unavailable', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });

    const resultPromise = requestPermission();
    fakeGeo.triggerCurrentError(makeError(3)); // TIMEOUT

    expect(await resultPromise).toBe('granted');
  });

  it('still resolves denied on PERMISSION_DENIED', async () => {
    const fakeGeo = new FakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: fakeGeo });

    const resultPromise = requestPermission();
    fakeGeo.triggerCurrentError(makeError(1)); // PERMISSION_DENIED

    expect(await resultPromise).toBe('denied');
  });
});
