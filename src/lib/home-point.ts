// Storage for the privacy zone's home point. Deliberately LOCAL ONLY — see
// privacy-zone.ts's header for why this must never be uploaded (the
// `profiles` table is world-readable, so a home point stored there would be
// published to every user of the app).
//
// Uses the same prefs store as the theme and locale (db.ts / db.web.ts), so
// it inherits that store's behaviour: it survives restarts, it is wiped by
// deleting the app or clearing site data, and a browser that blocks storage
// degrades to "no zone" rather than throwing.
import { getPref, setPref } from '@/lib/db';
import { DEFAULT_ZONE_RADIUS_M, type PrivacyZone } from '@/lib/privacy-zone';
import type { LatLng } from '@/lib/territory';

const PREF_HOME_POINT = 'privacyHomePoint';

/**
 * The saved zone, or null if the runner hasn't set one.
 *
 * Returns null on any parse problem rather than throwing: a corrupted pref
 * must not take down the Track tab. The cost of that choice is that a
 * corrupted value silently disables masking, so the value is validated
 * strictly enough that a half-written record can't read as valid coordinates.
 */
export function getHomeZone(): PrivacyZone | null {
  const raw = getPref(PREF_HOME_POINT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { lat?: unknown; lng?: unknown; radiusM?: unknown };
    const { lat, lng, radiusM } = parsed;
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return null;
    }
    return {
      home: { lat, lng },
      radiusM: typeof radiusM === 'number' && radiusM > 0 ? radiusM : DEFAULT_ZONE_RADIUS_M,
    };
  } catch {
    return null;
  }
}

/** Saves the zone. Returns false if the store rejected it (blocked storage). */
export function setHomeZone(home: LatLng, radiusM = DEFAULT_ZONE_RADIUS_M): boolean {
  return setPref(
    PREF_HOME_POINT,
    JSON.stringify({ lat: home.lat, lng: home.lng, radiusM }),
  );
}

/** Removes the zone — runs upload unmasked again. */
export function clearHomeZone(): boolean {
  return setPref(PREF_HOME_POINT, '');
}
