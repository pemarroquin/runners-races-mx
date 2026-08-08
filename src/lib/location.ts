// Region detection: GPS first (asks permission), IP geolocation as fallback
// (no permission needed). Both funnel into nearestRegion(), Mexico-bound.
// A `null` from nearestRegion() (out of MX coverage, or the calls below
// timing out) is treated as an ordinary detection failure here, so a
// too-far-away or unresolved coordinate falls through the same "none" path
// as a denied permission or a network error — never silently as Monterrey.
import * as Location from 'expo-location';

import { nearestRegion, type Region } from '@/lib/regions';

export type DetectMethod = 'gps' | 'ip' | 'none';

export interface DetectResult {
  region: Region | null;
  method: DetectMethod;
}

const GPS_TIMEOUT_MS = 10_000;
const IP_TIMEOUT_MS = 8_000;

/** Race a promise against a timer; resolves `null` (never rejects) on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function detectViaGps(): Promise<Region | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    // expo-location has no AbortSignal support, so getCurrentPositionAsync
    // can hang indoors — bound it with a timer race instead. The GPS call
    // itself keeps running in the background if it loses the race; its
    // result is simply discarded.
    const pos = await withTimeout(
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Low, // city-level is all we need
      }),
      GPS_TIMEOUT_MS,
    );
    if (!pos) return null; // timed out
    return nearestRegion(pos.coords.latitude, pos.coords.longitude);
  } catch {
    return null;
  }
}

async function detectViaIp(): Promise<Region | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IP_TIMEOUT_MS);
  try {
    // Free, https, keyless. Only lat/lng are read; nothing is stored.
    // Rate-limited on the free tier (1000 req/day/IP) — a failure here is
    // expected in normal operation, not exceptional; handle it like any
    // other "couldn't detect" path.
    const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const lat = Number(j?.latitude);
    const lng = Number(j?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return nearestRegion(lat, lng);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GPS (permission prompt) → IP fallback → null (caller keeps default). */
export async function detectRegion(): Promise<DetectResult> {
  const gps = await detectViaGps();
  if (gps) return { region: gps, method: 'gps' };
  const ip = await detectViaIp();
  if (ip) return { region: ip, method: 'ip' };
  return { region: null, method: 'none' };
}
