// Region detection: GPS first (asks permission), IP geolocation as fallback
// (no permission needed). Both funnel into nearestRegion(), Mexico-bound.
import * as Location from 'expo-location';

import { nearestRegion, type Region } from '@/lib/regions';

export type DetectMethod = 'gps' | 'ip' | 'none';

export interface DetectResult {
  region: Region | null;
  method: DetectMethod;
}

async function detectViaGps(): Promise<Region | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Low, // city-level is all we need
    });
    return nearestRegion(pos.coords.latitude, pos.coords.longitude);
  } catch {
    return null;
  }
}

async function detectViaIp(): Promise<Region | null> {
  try {
    // Free, https, keyless. Only lat/lng are read; nothing is stored.
    const res = await fetch('https://ipapi.co/json/');
    if (!res.ok) return null;
    const j = await res.json();
    const lat = Number(j?.latitude);
    const lng = Number(j?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return nearestRegion(lat, lng);
  } catch {
    return null;
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
