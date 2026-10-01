// Which stats the share sticker shows (Pedro, 2026-09-30: let the runner
// pick). Pure, so the rules are tested: order is always the sticker's own
// order, and the selection can never be empty — an empty sticker would copy
// a blank card that reads as the copy having failed.

export type ShareStat = 'distance' | 'pace' | 'time' | 'tiles';

/** The sticker's column order, and the default: everything. */
export const SHARE_STATS: readonly ShareStat[] = ['distance', 'pace', 'time', 'tiles'];

export const SHARE_STATS_STORAGE_KEY = 'share.stats.v1';

/** Toggle one stat, keeping sticker order. Refuses to drop the last one. */
export function toggleStat(selected: readonly ShareStat[], stat: ShareStat): ShareStat[] {
  const on = new Set(selected);
  if (on.has(stat)) {
    if (on.size === 1) return [...selected];
    on.delete(stat);
  } else {
    on.add(stat);
  }
  return SHARE_STATS.filter((s) => on.has(s));
}

/** Centre x of each of `n` evenly spaced columns across `width` — for four
 *  across 300 that's 37.5, 112.5, 187.5, 262.5, the sticker's original
 *  layout. */
export function columnXs(n: number, width: number): number[] {
  return Array.from({ length: n }, (_, i) => (width * (2 * i + 1)) / (2 * n));
}

/** A stored selection, validated; the default for anything unusable. */
export function parseStoredStats(raw: string | null): ShareStat[] {
  if (!raw) return [...SHARE_STATS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...SHARE_STATS];
    const picked = SHARE_STATS.filter((s) => parsed.includes(s));
    return picked.length > 0 ? picked : [...SHARE_STATS];
  } catch {
    return [...SHARE_STATS];
  }
}
