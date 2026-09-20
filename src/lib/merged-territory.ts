// The merged-territory dissolve — ONE shared implementation for a geometry
// algorithm that used to be hand-written twice, once per platform
// (territories-map.web.tsx's buildMergedFills/buildMergedRimData and
// territories-map.tsx's buildMergedGroups). Both copies were doing the exact
// same thing: map every cell to the run that currently owns it (last write
// wins by startedAtMs), cluster the union by H3 adjacency (clusterCells,
// tiles.ts), then for each cluster pick the most-recent contributing run for
// colour + click routing and emit cellsToMultiPolygon(cluster.cells, true).
//
// Why this exists as its own module: everything else in this codebase's map
// geometry lives inside a .tsx component file, which vitest.config.ts's
// `environment: 'node'` (no React renderer) cannot see AT ALL — so a fix to
// one platform's copy has silently missed the other before (commit 40fa9ce,
// "fix: implement territory merge on native (was web-only)"). This module has
// no React, no Mapbox, no react-native-maps — it is pure data in, data out —
// so it is actually reachable by a test, and there is exactly one copy of the
// algorithm left to drift.
//
// This module does NOT change behaviour on either platform. Each component
// still owns adapting this shared output to its own renderer:
//   - web wraps each entry into a Feature with
//     properties: { id, kind: 'saved', color } and
//     geometry: { type: 'MultiPolygon', coordinates }
//   - native wraps each into its existing MergedGroup shape
//     ({ id, geometry: { type: 'MultiPolygon', coordinates }, color })
import { cellsToMultiPolygon } from 'h3-js';

import { clusterCells } from '@/lib/tiles';

/** The minimal shape both platforms' TerritoryFeature can be narrowed to —
 *  everything buildMergedTerritories needs and nothing it doesn't, so this
 *  module has no dependency on either component file's own feature type. */
export interface MergeableFeature {
  id: string;
  kind: 'saved' | 'pending';
  /** H3 tile IDs for this feature's ground. Only 'saved' features with a
   *  non-empty cells array ever contribute — see buildMergedTerritories. */
  cells: string[];
  startedAtMs: number;
}

export interface MergedTerritory {
  /** Run id of the most-recent contributing run in this connected
   *  component — both platforms use this for click routing AND colour
   *  (looked up from colorMap by the caller, or already baked in via
   *  `color` below). */
  id: string;
  color: string;
  /** cellsToMultiPolygon(cells, true) output for this cluster's cells. */
  coordinates: number[][][][];
}

/**
 * Dissolves every 'saved' feature's cells into connected components (by H3
 * grid adjacency, via clusterCells), so adjacent territories from different
 * runs merge into one shape rather than sitting as overlapping separate
 * fills. Disconnected areas stay separate and keep their own identity
 * colour.
 *
 * `kind: 'pending'` features and features with zero cells are excluded
 * entirely — only saved, non-empty features ever contribute a cell. Where
 * two saved runs claim the SAME cell, the run with the greater
 * `startedAtMs` (strictly greater — a tie keeps whichever was seen first in
 * `features`, matching both platforms' pre-extraction behaviour) owns that
 * cell for colour + click-routing purposes within its cluster.
 *
 * Returns `[]` for empty input or input with no saved/non-empty features.
 */
export function buildMergedTerritories(
  features: MergeableFeature[],
  colorMap: Map<string, string>,
  fallbackColor: string,
): MergedTerritory[] {
  const savedFeatures = features.filter((f) => f.kind === 'saved' && f.cells.length > 0);
  if (savedFeatures.length === 0) return [];

  // Map each cell to the run that owns it — last-write-wins by startedAtMs
  // so a more-recent run's colour shows when two runs share the same tile.
  const cellToRun = new Map<string, { id: string; startedAtMs: number; color: string }>();
  for (const f of savedFeatures) {
    const color = colorMap.get(f.id) ?? fallbackColor;
    for (const cell of f.cells) {
      const existing = cellToRun.get(cell);
      if (!existing || f.startedAtMs > existing.startedAtMs) {
        cellToRun.set(cell, { id: f.id, startedAtMs: f.startedAtMs, color });
      }
    }
  }

  const clusters = clusterCells([...cellToRun.keys()]);
  return clusters.map((cluster) => {
    // Pick the most-recent run in this component for colour + click routing.
    let latestMs = -Infinity;
    let latestId = '';
    let latestColor = fallbackColor;
    for (const cell of cluster.cells) {
      const run = cellToRun.get(cell);
      if (run && run.startedAtMs > latestMs) {
        latestMs = run.startedAtMs;
        latestId = run.id;
        latestColor = run.color;
      }
    }
    return {
      id: latestId,
      color: latestColor,
      coordinates: cellsToMultiPolygon(cluster.cells, true),
    };
  });
}

/** A single exterior boundary line — one per outer ring found. */
export interface MergedRimLine {
  coordinates: number[][];
}

/**
 * Extracts the OUTER ring of every polygon across a set of merged
 * territories, as LineStrings — the true exterior boundary of claimed
 * ground, with no internal edges between adjacent runs' territories (those
 * were already dissolved away by buildMergedTerritories/clusterCells before
 * this ever runs).
 *
 * Preserves current behaviour EXACTLY, including a real limitation that is
 * NOT this pass's to fix: only `polygon[0]` (the outer ring) is taken, and
 * any hole rings (`polygon[1..]` — e.g. a donut-shaped claimed area with an
 * unclaimed pocket in the middle) are silently discarded, so a hole's own
 * inner boundary never gets a rim line. Whether holes should ALSO be rimmed
 * is an open product decision the user has not made (see the trifecta brief
 * for this extraction, "2. Extract the merged-territory geometry" — do not
 * change this without that decision).
 */
export function buildMergedRimLines(territories: MergedTerritory[]): MergedRimLine[] {
  const lines: MergedRimLine[] = [];
  for (const t of territories) {
    for (const polygon of t.coordinates) {
      if (polygon[0] && polygon[0].length >= 2) {
        lines.push({ coordinates: polygon[0] });
      }
    }
  }
  return lines;
}
