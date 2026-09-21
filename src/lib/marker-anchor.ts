// Where the "+N" conquest bubble actually LANDS — split out from
// index.tsx's takenClusters so it is reachable by a test at all (same
// reasoning as merged-territory.ts's own header: vitest.config.ts is
// `environment: 'node'` with no React renderer, so anything left inside a
// .tsx component file is untestable, and every map-marker bug this project
// has chased has lived in exactly that layer).
//
// The bug (reported 2026-09-20, real screenshot): a run traced a wide V
// opening westward, and the "+N" bubble sat in the empty gap between the
// two arms — ground the runner never set foot on. Cause: the old code took
// clusterCells' per-cluster centres and averaged THOSE, weighted by cell
// count, into one arithmetic mean over every taken cell. The mean of a
// non-convex set (a V, an L, a horseshoe — i.e. any real running route) can
// fall outside the set entirely. A mean is not a place.
//
// Fix, in two steps:
//   1. Pick the LARGEST cluster by cell count — "the main conquered area".
//      Smaller disconnected patches are real ground too, but only one pin
//      exists, so it marks the main body, not an average of every patch.
//   2. SNAP to the cluster's own nearest member cell, rather than using the
//      cluster's arithmetic-mean centre directly. A convex-enough cluster's
//      mean can still land on a cell the runner didn't take (e.g. the
//      inside of an L), and the whole point of this fix is that the pin
//      sits on ground actually run over.
import { cellToLatLng } from 'h3-js';

import { clusterCells } from '@/lib/tiles';
import { haversineM } from '@/lib/territory';

export interface MarkerAnchor {
  lat: number;
  lng: number;
}

/**
 * Picks one point for the conquest marker: the centre of the LARGEST
 * connected cluster of `cells` (by cell count — "the main conquered area"),
 * snapped to whichever member cell of that cluster is nearest the cluster's
 * own mean centre. The returned point is always one of the input cells' own
 * centres, so it is guaranteed to be ground the runner actually took.
 *
 * Ties in cluster size are broken by the cluster's lexicographically-lowest
 * member cell id, computed over the cluster's own cell set (not input
 * order) — so the same set of taken cells always picks the same cluster,
 * regardless of what order they were recorded or passed in.
 *
 * Returns null for empty input — callers should render no marker, exactly
 * as today's `[]` result does.
 */
export function pickMarkerAnchor(cells: string[]): MarkerAnchor | null {
  if (cells.length === 0) return null;

  const clusters = clusterCells(cells);
  if (clusters.length === 0) return null;

  let winner = clusters[0];
  let winnerMinCell = minCell(winner.cells);
  for (let i = 1; i < clusters.length; i++) {
    const candidate = clusters[i];
    if (candidate.count > winner.count) {
      winner = candidate;
      winnerMinCell = minCell(candidate.cells);
      continue;
    }
    if (candidate.count === winner.count) {
      const candidateMinCell = minCell(candidate.cells);
      if (candidateMinCell < winnerMinCell) {
        winner = candidate;
        winnerMinCell = candidateMinCell;
      }
    }
  }

  // Snap: the member cell of the winning cluster whose own centre is
  // nearest the cluster's mean centre (winner.center), using great-circle
  // distance — a raw degree comparison would bias the pick east-west,
  // since a degree of longitude shrinks toward the poles while a degree of
  // latitude does not.
  let bestCell = winner.cells[0];
  let bestLatLng = cellToLatLng(bestCell);
  let bestDistanceM = haversineM(
    { lat: bestLatLng[0], lng: bestLatLng[1] },
    winner.center,
  );
  for (let i = 1; i < winner.cells.length; i++) {
    const cell = winner.cells[i];
    const [lat, lng] = cellToLatLng(cell);
    const distanceM = haversineM({ lat, lng }, winner.center);
    if (distanceM < bestDistanceM) {
      bestCell = cell;
      bestLatLng = [lat, lng];
      bestDistanceM = distanceM;
    }
  }

  return { lat: bestLatLng[0], lng: bestLatLng[1] };
}

/** Lexicographically-smallest cell id in a cluster's own cell set — the
 *  tie-break key, computed from the cluster's contents rather than input
 *  order so it can never depend on how the caller happened to list cells. */
function minCell(cells: string[]): string {
  let min = cells[0];
  for (let i = 1; i < cells.length; i++) {
    if (cells[i] < min) min = cells[i];
  }
  return min;
}
