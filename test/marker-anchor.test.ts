// pickMarkerAnchor — where the session-summary "+N" conquest bubble
// actually lands (index.tsx's takenClusters, src/lib/marker-anchor.ts).
//
// Reported 2026-09-20, real screenshot: a run traced a wide V opening
// westward and the bubble sat in the empty gap between the two arms —
// ground the runner never ran. The old code (clusterCells' per-cluster
// centres, weighted-averaged into one arithmetic mean over every taken
// cell — see this file's own "reproduces the reported bug" test below)
// computes the mean of a non-convex set, which can fall outside the set
// entirely. This module picks the largest cluster, then SNAPS to that
// cluster's own nearest member cell, so the returned point is always
// ground the runner actually took.
//
// Cell fixtures are real H3 res-12 cells (DEFAULT_TILE_RES, tiles.ts)
// around a Monterrey coordinate, generated with h3-js's own
// latLngToCell/gridDisk/gridPathCells — never hand-written H3 id strings,
// same convention as test/merged-territory.test.ts and test/tiles.test.ts.
import { cellToLatLng, gridDisk, gridPathCells, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { pickMarkerAnchor } from '@/lib/marker-anchor';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

const MTY = { lat: 25.6714, lng: -100.369 };
const CELL = latLngToCell(MTY.lat, MTY.lng, DEFAULT_TILE_RES);
// Far enough away (well over a km) to guarantee no adjacency with CELL or
// its disk, so it always lands in its own cluster.
const FAR_CELL = latLngToCell(25.75, -100.2, DEFAULT_TILE_RES);

/** The OLD, buggy computation this module replaces: clusterCells' own
 *  per-cluster centres (each already a plain mean of that cluster's
 *  member cells), weighted-averaged by cell count into ONE point across
 *  every cluster. Reimplemented here, independent of tiles.ts/index.tsx,
 *  purely so the V-case test below can show it lands in the gap — this is
 *  not a regression test for that code, which no longer exists. */
function oldWeightedMeanCentroid(cells: string[]): { lat: number; lng: number } {
  // Local, minimal clusterCells reimplementation (grid-adjacency BFS) —
  // deliberately independent of src/lib/tiles.ts so this helper keeps
  // working even if that implementation changes.
  const remaining = new Set(cells);
  const clusters: { cells: string[]; center: { lat: number; lng: number } }[] = [];
  for (const start of cells) {
    if (!remaining.has(start)) continue;
    const group: string[] = [];
    const queue = [start];
    remaining.delete(start);
    while (queue.length > 0) {
      const cell = queue.pop()!;
      group.push(cell);
      for (const neighbor of gridDisk(cell, 1)) {
        if (remaining.has(neighbor)) {
          remaining.delete(neighbor);
          queue.push(neighbor);
        }
      }
    }
    let latSum = 0;
    let lngSum = 0;
    for (const cell of group) {
      const [lat, lng] = cellToLatLng(cell);
      latSum += lat;
      lngSum += lng;
    }
    clusters.push({ cells: group, center: { lat: latSum / group.length, lng: lngSum / group.length } });
  }
  let latSum = 0;
  let lngSum = 0;
  let total = 0;
  for (const c of clusters) {
    latSum += c.center.lat * c.cells.length;
    lngSum += c.center.lng * c.cells.length;
    total += c.cells.length;
  }
  return { lat: latSum / total, lng: lngSum / total };
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True if `point` matches some input cell's own centre exactly (as
 *  cellToLatLng would report it) — the membership test used throughout:
 *  "is this point actually ground the runner took". */
function isMemberOfCells(point: { lat: number; lng: number }, cells: string[]): boolean {
  return cells.some((cell) => {
    const [lat, lng] = cellToLatLng(cell);
    return lat === point.lat && lng === point.lng;
  });
}

describe('pickMarkerAnchor', () => {
  it('returns null for empty input, so the caller renders no marker', () => {
    expect(pickMarkerAnchor([])).toBeNull();
  });

  it('anchors a single cell on that cell itself', () => {
    const [lat, lng] = cellToLatLng(CELL);
    expect(pickMarkerAnchor([CELL])).toEqual({ lat, lng });
  });

  describe('the reported V-case bug', () => {
    // Two arms sharing a vertex, each a straight grid path ~1 km long,
    // diverging north-west and south-west of the vertex — a wide V opening
    // westward, same shape as the reported screenshot. Both arms are
    // mutually grid-adjacent through the shared vertex, so this whole
    // shape is ONE connected cluster (verified below): a real run is a
    // single connected path, and the bug was never about cluster
    // selection, only about the mean of a non-convex cluster falling
    // outside it.
    const vertex = CELL;
    const armNorthEnd = latLngToCell(MTY.lat + 0.004, MTY.lng - 0.01, DEFAULT_TILE_RES);
    const armSouthEnd = latLngToCell(MTY.lat - 0.004, MTY.lng - 0.01, DEFAULT_TILE_RES);
    const armNorth = gridPathCells(vertex, armNorthEnd);
    const armSouth = gridPathCells(vertex, armSouthEnd);
    const vCells = Array.from(new Set([...armNorth, ...armSouth]));

    it('sanity-checks its own fixture: the V is one connected shape, and the old centroid lands in the gap', () => {
      // The old weighted-mean centroid should be nowhere near any actual
      // cell — this is the reported bug, reproduced. If this assertion
      // ever fails, the fixture below no longer exercises the bug and
      // needs reshaping (wider/longer arms), not deleting.
      const oldCentroid = oldWeightedMeanCentroid(vCells);
      expect(isMemberOfCells(oldCentroid, vCells)).toBe(false);
      let nearestM = Infinity;
      for (const cell of vCells) {
        const [lat, lng] = cellToLatLng(cell);
        nearestM = Math.min(nearestM, haversineM(oldCentroid, { lat, lng }));
      }
      // Res-12 cells are ~10.8 m edge; the old centroid landing over 100 m
      // from the nearest actual cell means it is unambiguously off the
      // conquered ground, not just a rounding wobble.
      expect(nearestM).toBeGreaterThan(100);
    });

    it('anchors on a cell the runner actually took, not in the gap between the arms', () => {
      const anchor = pickMarkerAnchor(vCells);
      expect(anchor).not.toBeNull();
      // This is the whole fix: the returned point is a MEMBER of the
      // taken-cell set, which by construction cannot be in the gap.
      expect(isMemberOfCells(anchor!, vCells)).toBe(true);
      // Belt and suspenders: explicitly not the old (buggy) centroid.
      const oldCentroid = oldWeightedMeanCentroid(vCells);
      expect(anchor).not.toEqual(oldCentroid);
    });
  });

  it('anchors in the LARGER of two disconnected patches, not the smaller one', () => {
    const small = gridDisk(CELL, 1);
    const large = gridDisk(FAR_CELL, 3);
    expect(large.length).toBeGreaterThan(small.length);
    const anchor = pickMarkerAnchor([...small, ...large]);
    expect(anchor).not.toBeNull();
    expect(isMemberOfCells(anchor!, large)).toBe(true);
    expect(isMemberOfCells(anchor!, small)).toBe(false);
  });

  it('is deterministic across equal-sized clusters, regardless of input order', () => {
    const clusterA = gridDisk(CELL, 1);
    const clusterB = gridDisk(FAR_CELL, 1);
    expect(clusterA.length).toBe(clusterB.length);

    const forward = pickMarkerAnchor([...clusterA, ...clusterB]);
    const reversed = pickMarkerAnchor([...clusterB, ...clusterA]);
    // Interleaved rather than sorted/shuffled — deterministically a
    // different order from both `forward` and `reversed` above, with no
    // dependency on a particular sort/shuffle implementation.
    const interleaved: string[] = [];
    const maxLen = Math.max(clusterA.length, clusterB.length);
    for (let i = 0; i < maxLen; i++) {
      if (clusterB[i]) interleaved.push(clusterB[i]);
      if (clusterA[i]) interleaved.push(clusterA[i]);
    }
    const shuffled = pickMarkerAnchor(interleaved);
    expect(forward).not.toBeNull();
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(shuffled);

    // Repeated calls with the exact same input agree too — no hidden
    // randomness (e.g. Set/Map iteration order) in the tie-break.
    const repeat = pickMarkerAnchor([...clusterA, ...clusterB]);
    expect(repeat).toEqual(forward);
  });

  it('does not push the anchor to an edge of a compact, symmetric blob', () => {
    const blob = gridDisk(CELL, 3);
    const anchor = pickMarkerAnchor(blob);
    expect(anchor).not.toBeNull();
    expect(isMemberOfCells(anchor!, blob)).toBe(true);
    // A disk is symmetric around its center cell, so the true mean sits
    // at (or extremely near) CELL's own center — the snap should resolve
    // back to CELL itself, not to some cell out on the rim.
    const [lat, lng] = cellToLatLng(CELL);
    expect(anchor).toEqual({ lat, lng });
  });
});
