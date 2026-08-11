// The seam between the Feed's hero/grid card layout and the (separately
// in-flight, Higgsfield-generated) region-identity illustration set. This
// file is intentionally decoupled from that generation run: it ships with
// every region mapped to an empty array so the app works correctly, today,
// with zero images — cards fall back to their existing text-only rendering
// (see pickRegionArt below) rather than being blocked on art that doesn't
// exist yet.
//
// Populated from Source Data/Outputs/Running App/region-art-manifest.json
// once that generation run completes — replace the empty arrays with that
// file's URLs grouped by regionId. Do not hardcode Higgsfield CDN URLs here
// yet; that data doesn't exist as of this commit.
import { REGIONS } from '@/lib/regions';

export interface RegionArtEntry {
  key: string; // e.g. 'mty-fundidora'
  url: string;
}

export const REGION_ART: Record<string, RegionArtEntry[]> = Object.fromEntries(
  REGIONS.map((r) => [r.id, []]),
);

// Small, dependency-free FNV-1a hash — good enough for picking a stable
// index into a short array, no crypto needed.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically picks one region-art URL for a given race, so the same
 * race always shows the same image across renders/sessions while different
 * races in the same region get visual variety. Returns `undefined` when the
 * region has no art yet (the actual state of every region right now) — that
 * is the fallback path that keeps cards text-only until art lands, and it
 * must work correctly against an empty/missing array.
 */
export function pickRegionArt(regionId: string, raceId: string): string | undefined {
  const entries = REGION_ART[regionId];
  if (!entries || entries.length === 0) return undefined;
  const index = fnv1a(raceId) % entries.length;
  return entries[index].url;
}
