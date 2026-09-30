// Profile › Places I've been — one map, two layers (Pedro, 2026-09-30).
//
// My Achievements moved here from Leaderboard. The ground you hold RIGHT NOW
// (territory_tiles, tappable per run: stats, share, retry a pending upload)
// sits on top of everywhere you have EVER run, drawn faint underneath. Under
// conquest the top layer can fall while you sleep; the base layer never
// does, which is why it survived the merge rather than being dropped.
//
// On the BASE layer: a run that could NOT claim does not appear at all, and the comment
// this replaces claimed the opposite. claim_run_tiles raises CLAIM_TOO_OLD
// (and CLAIM_IMPLAUSIBLE) BEFORE its `insert into tile_visits`, so such a
// run writes no visit rows and this map has nothing to draw for it — while
// the runs row, and so the Saved tab's fence, is written either way. No run
// in production is in that state today (12 of 12 have tiles, checked
// 2026-09-09), which is exactly why the wrong comment survived: nothing
// contradicted it.
import { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AchievementsView } from '@/components/achievements-view';
import { Colors, Spacing } from '@/constants/theme';
import { groundOfRun, noiseHoles } from '@/lib/enclosure';
import { useI18n } from '@/lib/i18n';
import { fetchMyVisitedCells } from '@/lib/territory-sync';
import { DEFAULT_TILE_RES } from '@/lib/tiles';

type Base = { status: 'loading' } | { status: 'error' } | { status: 'ready'; cells: string[] };

export default function PlacesScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const { locale } = useI18n();
  const insets = useSafeAreaInsets();
  const [base, setBase] = useState<Base>({ status: 'loading' });

  useEffect(() => {
    let stale = false;
    // Deferred a tick, never called from the effect body — same React
    // Compiler rule as every other fetch effect here.
    const id = setTimeout(() => {
      fetchMyVisitedCells().then((outcome) => {
        if (stale) return;
        if (!outcome.ok) {
          setBase({ status: 'error' });
          return;
        }
        // Ground is assembled by the SAME rule a live run uses: cells
        // crossed, plus the interior of any loop THAT SINGLE SESSION closed.
        // Per run, never across runs — unioning first and enclosing that
        // would let a six-month city perimeter claim everything inside, the
        // failure enclosure.ts exists to refuse. Recomputed from the
        // append-only visit log rather than read from territory_tiles,
        // because territory is "what I hold NOW" and conquest takes ground
        // off you; this layer is the permanent record.
        //
        // Privacy: these cells were privacy-zone-trimmed on the way in (see
        // uploadRun), so enclosure derived from them can't expose a home
        // loop the mask removed.
        const ground = [
          ...new Set(outcome.runs.flatMap(({ cells }) => groundOfRun(cells, DEFAULT_TILE_RES))),
        ];
        // Sampling holes filled at enclosure.ts's measured cap: a session
        // that never closed its loop encloses nothing, so a cell the GPS
        // missed inside a band run dozens of times would otherwise show.
        setBase({ status: 'ready', cells: [...ground, ...noiseHoles(ground, DEFAULT_TILE_RES)] });
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: Colors[scheme].background }}>
      <AchievementsView
        locale={locale}
        scheme={scheme}
        baseCells={base.status === 'ready' ? base.cells : undefined}
        baseFailed={base.status === 'error'}
        // A Stack push: no tab bar underneath, only the home indicator.
        bottomInset={insets.bottom + Spacing.two}
      />
    </View>
  );
}
