// A city's real subdivisions as leaderboard arenas (Pedro, 2026-09-30):
// municipios in Monterrey, arrondissements in Paris — each city's
// TOP_SUBDIVISIONS most populated, from scripts/extract-subdivisions.ts.
//
// This REVERSES "the arena is an H3 res-7 district, NOT a municipio". What
// that entry measured, and rightly rejected, was GUESSING a municipio by
// truncating park cells to a coarse hexagon: 21.3% of districts straddle two
// municipios. Here each tile's centre is tested against the real boundary
// polygon, so there is no guess. The district survives as the fallback
// wherever no subdivision is mapped (outside the top 10, other cities).
//
// Every tile counts in EXACTLY ONE subdivision, never two, and that is what
// subdivisionAt's order guarantees: the first outline containing the point
// wins, and a point in a sliver between two independently simplified
// outlines goes to the nearest within SLIVER_M. Pure, so vitest covers it.
import turfArea from '@turf/area';
import {
  cellToBoundary,
  cellToLatLng,
  getHexagonAreaAvg,
  getResolution,
  gridDisk,
  polygonToCellsExperimental,
} from 'h3-js';

import bundled from '@/assets/data/subdivisions.json';
import { DISTRICT_RES, districtOf, districtScope, type ArenaScope } from '@/lib/district';
import type { CellBounds } from '@/lib/local-leaders';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

export type SubdivisionGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface Subdivision {
  id: string;
  name: string;
  population: number;
  /** GeoJSON order: [lng, lat]. */
  geometry: SubdivisionGeometry;
}

/** Everything a board needs about where it is. */
export interface Arena extends ArenaScope {
  /** Stable id: the subdivision's OSM id, or the district's H3 id. */
  key: string;
  kind: 'district' | 'subdivision';
  /** The subdivision's name; null for a district, whose caption the screen
   *  derives on its own (districtLabel, then the metro name). */
  name: string | null;
  /** Districts covering the arena: what the server-side reads filter on.
   *  A superset — `contains` does the exact cut on device. */
  districts: string[];
  /** Outline as MultiPolygon coordinates, [lng, lat]. */
  outline: number[][][][];
  bounds: CellBounds;
}

/** A point this close to an outline, but inside none, belongs to the nearest.
 *  Outlines are simplified to ~10 m independently, so neighbours can leave
 *  slivers; this is comfortably wider than those and narrower than any real
 *  gap worth respecting. */
export const SLIVER_M = 40;

const M_PER_DEG_LAT = 111_320;

function polygonsOf(g: SubdivisionGeometry): number[][][][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

function inRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside an outer ring and outside its holes, for any polygon of the shape. */
export function pointInGeometry(lng: number, lat: number, g: SubdivisionGeometry): boolean {
  return polygonsOf(g).some(
    ([outer, ...holes]) => inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h)),
  );
}

/** Metres from a point to the nearest edge of the outline (local flat
 *  approximation — fine at the tens of metres this is used for). */
export function distanceToGeometryM(lng: number, lat: number, g: SubdivisionGeometry): number {
  const kx = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const poly of polygonsOf(g)) {
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const ax = (ring[i][0] - lng) * kx;
        const ay = (ring[i][1] - lat) * M_PER_DEG_LAT;
        const bx = (ring[i + 1][0] - lng) * kx;
        const by = (ring[i + 1][1] - lat) * M_PER_DEG_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

interface Prepared {
  sub: Subdivision;
  box: { minLng: number; maxLng: number; minLat: number; maxLat: number };
}

const preparedCache = new WeakMap<Subdivision[], Prepared[]>();

function prepare(subs: Subdivision[]): Prepared[] {
  const cached = preparedCache.get(subs);
  if (cached) return cached;
  const out = subs.map((sub) => {
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const poly of polygonsOf(sub.geometry)) {
      for (const [lng, lat] of poly[0]) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return { sub, box: { minLng, maxLng, minLat, maxLat } };
  });
  preparedCache.set(subs, out);
  return out;
}

/** The one subdivision a point belongs to, or null outside them all. */
export function subdivisionAt(subs: Subdivision[], lat: number, lng: number): Subdivision | null {
  const prepared = prepare(subs);
  for (const { sub, box } of prepared) {
    if (lng < box.minLng || lng > box.maxLng || lat < box.minLat || lat > box.maxLat) continue;
    if (pointInGeometry(lng, lat, sub.geometry)) return sub;
  }
  // A sliver between two outlines: nearest within SLIVER_M. The box check
  // is padded by the same distance (~0.0005° is ~50 m at any latitude we
  // serve), so this stays cheap.
  const pad = 0.0005;
  let best: Subdivision | null = null;
  let bestM = SLIVER_M;
  for (const { sub, box } of prepared) {
    if (lng < box.minLng - pad || lng > box.maxLng + pad || lat < box.minLat - pad || lat > box.maxLat + pad) {
      continue;
    }
    const d = distanceToGeometryM(lng, lat, sub.geometry);
    if (d <= bestM) {
      best = sub;
      bestM = d;
    }
  }
  return best;
}

/** The subdivision a tile counts in: its centre point, tile resolution only
 *  (an unconverted res-11 tile counts nowhere, same rule as districtOfCell). */
export function subdivisionOfCell(subs: Subdivision[], h3: string): Subdivision | null {
  if (getResolution(h3) !== DEFAULT_TILE_RES) return null;
  const [lat, lng] = cellToLatLng(h3);
  return subdivisionAt(subs, lat, lng);
}

/**
 * Districts that together cover a subdivision: every district overlapping
 * it, plus one ring around them. The ring is not padding for taste — a
 * tile's district is its TRUNCATION parent, which near an edge is not the
 * hexagon geometrically under it, so a tile just inside the outline can
 * belong to a district that doesn't itself overlap. One ring always covers
 * that (children stay within a parent's immediate neighbours).
 */
export function coveringDistricts(g: SubdivisionGeometry): string[] {
  const set = new Set<string>();
  for (const poly of polygonsOf(g)) {
    for (const cell of polygonToCellsExperimental(poly, DISTRICT_RES, 'containmentOverlapping', true)) {
      for (const near of gridDisk(cell, 1)) set.add(near);
    }
  }
  return [...set].sort();
}

const TILE_AREA_M2 = getHexagonAreaAvg(DEFAULT_TILE_RES, 'm2');

export function subdivisionArena(sub: Subdivision, all: Subdivision[]): Arena {
  // Membership is decided across ALL subdivisions, not this outline alone,
  // so a sliver tile counted by a neighbour is never counted here too.
  // Cached: both boards and the map ask about the same tiles on every render.
  const memo = new Map<string, boolean>();
  const outline = polygonsOf(sub.geometry);
  return {
    key: sub.id,
    kind: 'subdivision',
    name: sub.name,
    districts: coveringDistricts(sub.geometry),
    contains: (h3) => {
      let hit = memo.get(h3);
      if (hit === undefined) {
        hit = subdivisionOfCell(all, h3)?.id === sub.id;
        memo.set(h3, hit);
      }
      return hit;
    },
    totalCells: Math.round(turfArea({ type: 'Feature', properties: {}, geometry: sub.geometry }) / TILE_AREA_M2),
    outline,
    bounds: boundsOfOutline(outline),
  };
}

export function districtArena(district: string): Arena {
  const outline = [[cellToBoundary(district, true)]];
  return {
    key: district,
    kind: 'district',
    name: null,
    districts: [district],
    ...districtScope(district),
    outline,
    bounds: boundsOfOutline(outline),
  };
}

function boundsOfOutline(outline: number[][][][]): CellBounds {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const poly of outline) {
    for (const [lng, lat] of poly[0]) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  return { minLat, maxLat, minLng, maxLng };
}

function centreDistanceM(b: CellBounds, lat: number, lng: number): number {
  const cLat = (b.minLat + b.maxLat) / 2;
  const cLng = (b.minLng + b.maxLng) / 2;
  const kx = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return Math.hypot((cLng - lng) * kx, (cLat - lat) * M_PER_DEG_LAT);
}

/**
 * The switcher's list, first entry = where the runner stands.
 *
 * Inside a subdivision: that one, then the rest nearest first. Outside them
 * all (or in a city with none): the runner's own district first, then — if
 * the city has any — its subdivisions nearest first, so the arrows still
 * browse the city.
 */
export function arenasFor(subs: Subdivision[], at: { lat: number; lng: number }): Arena[] {
  const home = subdivisionAt(subs, at.lat, at.lng);
  const rest = subs
    .filter((s) => s.id !== home?.id)
    .map((s) => subdivisionArena(s, subs))
    .sort((a, b) => centreDistanceM(a.bounds, at.lat, at.lng) - centreDistanceM(b.bounds, at.lat, at.lng));
  const first = home ? subdivisionArena(home, subs) : districtArena(districtOf(at));
  return [first, ...rest];
}

// ---- data --------------------------------------------------------------

export const REMOTE_SUBDIVISIONS_URL =
  'https://raw.githubusercontent.com/pemarroquin/runners-races-mx/main/assets/data/subdivisions.json';

function isGeometry(g: unknown): g is SubdivisionGeometry {
  if (!g || typeof g !== 'object') return false;
  const { type, coordinates } = g as { type?: unknown; coordinates?: unknown };
  return (type === 'Polygon' || type === 'MultiPolygon') && Array.isArray(coordinates) && coordinates.length > 0;
}

function isSubdivision(s: unknown): s is Subdivision {
  if (!s || typeof s !== 'object') return false;
  const r = s as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.population === 'number' && isGeometry(r.geometry);
}

/** Validated subdivisions per region id from a subdivisions.json payload.
 *  Null for anything unusable, so a bad remote copy never replaces a good
 *  bundled one. A region whose list contains a bad record is dropped whole —
 *  a partial list would silently merge the missing ground into the
 *  district fallback. */
export function parseSubdivisions(json: unknown): Record<string, Subdivision[]> | null {
  const regions = (json as { regions?: unknown } | null)?.regions;
  if (!regions || typeof regions !== 'object') return null;
  const out: Record<string, Subdivision[]> = {};
  for (const [id, list] of Object.entries(regions as Record<string, unknown>)) {
    if (Array.isArray(list) && list.length > 0 && list.every(isSubdivision)) out[id] = list;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const BUNDLED_SUBDIVISIONS: Record<string, Subdivision[]> = parseSubdivisions(bundled) ?? {};

const FETCH_TIMEOUT_MS = 10_000;

/** The GitHub copy, or null. No custom headers and `cache: 'no-cache'`, for
 *  the same CORS-preflight and ETag reasons as fetchRemoteRaces. */
export async function fetchRemoteSubdivisions(): Promise<Record<string, Subdivision[]> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REMOTE_SUBDIVISIONS_URL, { cache: 'no-cache', signal: controller.signal });
    if (!res.ok) return null;
    return parseSubdivisions(await res.json());
  } catch {
    // Offline or blocked: the bundled copy stays, which is the designed
    // behaviour rather than a hidden failure — nothing is claimed as fresh.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
