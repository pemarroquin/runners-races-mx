// "My Achievements" — the Leaderboard's personal tab: every territory this
// identity has conquered, on one full-bleed map, tap a shape for its detail.
//
// Moved here 2026-09-17 (Pedro's nav restructure) from the old Saved tab's
// "Conquested Areas" segment (myraces.tsx) — same map, same detail bubble,
// same data. It moved because it answers a leaderboard question ("what have
// I taken"), not a bookmarking one, and the bottom nav dropped to three
// tabs (Run/Leaderboard/Races) with no room left for a standalone Saved tab.
// See leaderboard.tsx for the sub-tab shell this mounts inside.
//
// Self-contained on purpose: it owns its own fetch/focus/signal wiring
// (identical to myraces.tsx's old FencesView + its parent screen) so
// leaderboard.tsx only has to mount it, the same way DistrictMap/ShareBar
// there are handed data rather than owning it — this component is the one
// exception, because splitting its fetch effects across a shell that also
// juggles two other boards' own refetch-on-focus effects invited exactly the
// kind of cross-tab stale-state bug this codebase has hit before (see
// leaderboard.tsx's own loadTicketRef comment).
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';

import { cellsToMultiPolygon } from 'h3-js';
import type { MultiPolygon, Polygon } from 'geojson';

import { ShareSheet, type ShareSessionData } from '@/components/share-card';
import { TerritoriesMap, type TerritoryFeature } from '@/components/territories-map';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { onIdentityChanged } from '@/lib/auth-events';
import { groundOfRun } from '@/lib/enclosure';
import { onRunSaved, notifyRunSaved } from '@/lib/save-events';
import {
  deleteRun,
  fetchMyFences,
  fetchMyVisitedCells,
  type RunCells,
  uploadRun,
  type DeleteOutcome,
  type FencesOutcome,
  type MyFence,
  type SyncOutcome,
} from '@/lib/territory-sync';
import { DEFAULT_TILE_RES, pathToTiles, tilesAreaM2 } from '@/lib/tiles';
import { formatArea, formatDistance, formatDuration, formatPace } from '@/lib/tracking';
import { listQueued, removeQueued, type QueuedRun } from '@/lib/upload-queue';

/** Same three sync-failure keys myraces.tsx's DetailCard used — the
 *  `track.*` namespace is inherited from where this copy was first written,
 *  not from where it's read; see that file's own note before this moved. */
const SYNC_FAILURE_KEYS: Record<'disabled' | 'auth' | 'network', string> = {
  disabled: 'track.syncDisabled',
  auth: 'track.syncFailedAuth',
  network: 'track.syncFailedNetwork',
};

const DELETE_FAILURE_KEYS: Record<'disabled' | 'auth' | 'network' | 'denied', string> = {
  disabled: 'track.deleteFailedDisabled',
  auth: 'track.deleteFailedAuth',
  denied: 'track.deleteFailedDenied',
  network: 'track.deleteFailedNetwork',
};

interface Selection {
  id: string;
  kind: 'saved' | 'pending';
}

export function AchievementsView({
  locale,
  scheme,
}: {
  locale: string;
  scheme: 'dark' | 'light';
}) {
  const c = Colors[scheme];
  const { t } = useI18n();
  const isFocused = useIsFocused();

  const [fences, setFences] = useState<FencesOutcome | null>(null);
  const [runCells, setRunCells] = useState<RunCells[] | null>(null);
  const [queued, setQueued] = useState<QueuedRun[]>([]);
  const refreshQueued = useCallback(() => setQueued(listQueued()), []);

  // Same three refetch triggers myraces.tsx used: a run landing on the
  // server (autosave or a background flush promoting a queued one), the
  // identity swapping, and this screen's own delete handler — see that
  // file's now-removed FencesView for the full reasoning on each.
  const [saveSignal, setSaveSignal] = useState(0);
  useEffect(() => onRunSaved(() => setSaveSignal((v) => v + 1)), []);
  const [identitySignal, setIdentitySignal] = useState(0);
  useEffect(() => onIdentityChanged(() => setIdentitySignal((v) => v + 1)), []);
  const [deleteSignal, setDeleteSignal] = useState(0);

  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    const id = setTimeout(() => {
      setFences(null);
      refreshQueued();
      fetchMyFences().then((outcome) => {
        if (!stale) setFences(outcome);
      });
      fetchMyVisitedCells().then((outcome) => {
        if (!stale) setRunCells(outcome.ok ? outcome.runs : null);
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused, refreshQueued, saveSignal, identitySignal, deleteSignal]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    refreshQueued();
    const [outcome, cells] = await Promise.all([fetchMyFences(), fetchMyVisitedCells()]);
    setFences(outcome);
    setRunCells(cells.ok ? cells.runs : null);
    setRefreshing(false);
  }, [refreshQueued]);

  const [selection, setSelection] = useState<Selection | null>(null);

  if (fences === null) {
    return (
      <View style={styles.emptyWrap}>
        <ActivityIndicator color={c.textSecondary} />
      </View>
    );
  }

  if (!fences.ok) {
    return (
      <ScrollView
        contentContainerStyle={[styles.emptyWrap, styles.emptyWrapGrow]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={c.textSecondary} />
        }>
        <Animated.View entering={FadeIn.duration(400)}>
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {fences.reason === 'disabled' ? t('myraces.fencesDisabled') : t('myraces.fencesError')}
          </Text>
        </Animated.View>
      </ScrollView>
    );
  }

  // Same tiles-over-fence-polygon rule as before this moved — see the
  // deleted FencesView's own comment (myraces.tsx history) for why: the
  // fence is the path's outline, the tiles are what the game actually
  // scores, and a run that never closed a loop can have almost nothing to
  // enclose while still covering real ground.
  const cellsByRun = new Map((runCells ?? []).map(({ runId, cells }) => [runId, cells]));
  const savedFeatures: TerritoryFeature[] = fences.fences
    .map((f) => {
      const cells = cellsByRun.get(f.id);
      const geometry: Polygon | MultiPolygon | null = cells?.length
        ? { type: 'MultiPolygon', coordinates: cellsToMultiPolygon(groundOfRun(cells, DEFAULT_TILE_RES), true) }
        : f.geometry;
      return { fence: f, geometry };
    })
    .filter((f) => f.geometry !== null)
    .map(({ fence, geometry }) => ({
      id: fence.id,
      kind: 'saved' as const,
      geometry: geometry!,
      route: fence.route,
      startedAtMs: fence.startedAtMs,
    }));
  const pendingFeatures: TerritoryFeature[] = queued.map((q) => {
    const cells = groundOfRun(pathToTiles(q.run.points).cells, DEFAULT_TILE_RES);
    return {
      id: q.id,
      kind: 'pending' as const,
      geometry: cells.length
        ? ({ type: 'MultiPolygon', coordinates: cellsToMultiPolygon(cells, true) } as MultiPolygon)
        : q.run.fence.geometry.geometry,
      route: q.run.points,
      startedAtMs: q.run.startedAt,
    };
  });
  const features = [...savedFeatures, ...pendingFeatures];

  // The legend total: distinct tiles across every SAVED (uploaded) run,
  // deduped by cell id — summing each run's own count would double-count
  // ground two of your own runs both crossed. Queued runs are excluded: they
  // haven't cleared claim_run_tiles yet, so counting them would show a
  // number the server might not agree with the moment they upload. Not
  // scoped to a municipio or district on purpose — Pedro's ask: "no matter
  // municipio or any other filter, this is all i have conquest so far."
  //
  // Plain computation, not useMemo — this runs after two early returns
  // above, and a hook here would violate the rules of hooks the moment
  // `fences` is null or failed.
  const totalTilesSet = new Set<string>();
  for (const cells of cellsByRun.values()) {
    for (const cell of groundOfRun(cells, DEFAULT_TILE_RES)) totalTilesSet.add(cell);
  }
  const totalTiles = totalTilesSet.size;

  const selectedFence =
    selection?.kind === 'saved' ? fences.fences.find((f) => f.id === selection.id) : undefined;
  const selectedQueued =
    selection?.kind === 'pending' ? queued.find((q) => q.id === selection.id) : undefined;

  return (
    <View style={styles.stage}>
      <View style={styles.legendRow}>
        <Icon ios="square.grid.3x3.fill" android="grid_view" size={14} color={c.textSecondary} />
        <Text style={[styles.legendText, { color: c.textSecondary }]}>
          {t('leaderboard.totalTiles', { count: totalTiles })}
        </Text>
      </View>

      {features.length === 0 ? (
        <ScrollView
          contentContainerStyle={[styles.emptyWrap, styles.emptyWrapGrow]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={c.textSecondary} />
          }>
          <Animated.View entering={FadeIn.duration(400)}>
            <Text style={[styles.empty, { color: c.textSecondary }]}>{t('myraces.fencesEmpty')}</Text>
          </Animated.View>
        </ScrollView>
      ) : (
        <View style={styles.mapStage}>
          <TerritoriesMap
            features={features}
            onSelect={(id, kind) => setSelection({ id, kind })}
            controls={{
              zoomInLabel: t('track.zoomIn'),
              zoomOutLabel: t('track.zoomOut'),
              refitLabel: t('myraces.fencesRefit'),
            }}
            controlsBottomOffset={BottomTabInset + Spacing.three}
            // This screen lives inside a Tabs navigator, which never
            // unmounts a tab on switching away from it — without this, the
            // map's two animation timers (gradient flow + shimmer) kept
            // running full-speed after leaving Leaderboard for Run or
            // Races. See TerritoriesMap's own `active` prop doc.
            active={isFocused}
          />
          {(selectedFence || selectedQueued) && (
            <DetailCard
              fence={selectedFence}
              queued={selectedQueued}
              cells={selection ? cellsByRun.get(selection.id) : undefined}
              locale={locale}
              scheme={scheme}
              onClose={() => setSelection(null)}
              onDeleted={() => {
                setDeleteSignal((v) => v + 1);
                setSelection(null);
              }}
            />
          )}
        </View>
      )}
    </View>
  );
}

function DetailCard({
  fence,
  queued,
  cells,
  locale,
  scheme,
  onClose,
  onDeleted,
}: {
  fence?: MyFence;
  queued?: QueuedRun;
  cells?: string[];
  locale: string;
  scheme: 'dark' | 'light';
  onClose: () => void;
  onDeleted: () => void;
}) {
  const c = Colors[scheme];
  const { t } = useI18n();

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<DeleteOutcome | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryFailure, setRetryFailure] = useState<SyncOutcome | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const startedAtMs = fence?.startedAtMs ?? queued?.run.startedAt ?? 0;
  const tiled = cells?.length
    ? groundOfRun(cells, DEFAULT_TILE_RES)
    : queued
      ? groundOfRun(pathToTiles(queued.run.points).cells, DEFAULT_TILE_RES)
      : [];
  const areaM2 = tiled.length ? tilesAreaM2(tiled) : (fence?.areaM2 ?? queued?.run.fence.areaM2 ?? 0);
  const distanceM = fence?.distanceM ?? queued?.run.distanceM ?? 0;
  const durationS = fence?.durationS ?? (queued ? (queued.run.endedAt - queued.run.startedAt) / 1000 : 0);
  const pace = formatPace(distanceM, durationS);
  const date = new Date(startedAtMs).toLocaleDateString(locale === 'es' ? 'es-MX' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  // The share sheet's input — same shape as the run-end summary's. A queued
  // (not yet uploaded) run still has its own route (queued.run.points), so
  // sharing works before the first successful save too, not only after.
  const shareRoute = fence?.route ?? queued?.run.points ?? null;
  const shareData: ShareSessionData | null =
    shareRoute && shareRoute.length >= 2
      ? {
          route: shareRoute,
          distanceM,
          durationS,
          tiles: tiled.length,
        }
      : null;

  const handleDeleteSaved = useCallback(async () => {
    if (!fence) return;
    setDeleting(true);
    setDeleteFailure(null);
    const outcome = await deleteRun(fence.id);
    if (!outcome.ok) {
      setDeleting(false);
      setDeleteFailure(outcome);
      setConfirmingDelete(false);
      return;
    }
    onDeleted();
  }, [fence, onDeleted]);

  const handleDeleteQueued = useCallback(() => {
    if (!queued) return;
    removeQueued(queued.id);
    onDeleted();
  }, [queued, onDeleted]);

  const handleRetry = useCallback(async () => {
    if (!queued) return;
    setRetrying(true);
    setRetryFailure(null);
    const outcome = await uploadRun(queued.run);
    if (!outcome.ok) {
      setRetrying(false);
      setRetryFailure(outcome);
      return;
    }
    removeQueued(queued.id);
    notifyRunSaved();
    onDeleted();
  }, [queued, onDeleted]);

  return (
    <Animated.View entering={FadeInDown.duration(280)} style={styles.detailBubbleWrap}>
      {isLiquidGlassAvailable() ? (
        <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme="dark" />
      ) : (
        <GlassSurface scheme="dark" radius={GlassRadii.sheet} style={StyleSheet.absoluteFill} />
      )}
      <View style={styles.detailHeader}>
        <View style={styles.detailMeta}>
          <Text style={[styles.detailDate, { color: ON_DARK_TEXT }]}>{date}</Text>
          <Text style={[styles.detailStats, { color: ON_DARK_TEXT_SECONDARY }]}>
            {formatArea(areaM2)}  ·  {formatDistance(distanceM)}
          </Text>
        </View>
        <View style={styles.detailHeaderActions}>
          {shareData && (
            <Pressable
              onPress={() => setShareOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t('share.title')}
              hitSlop={10}>
              <Icon ios="square.and.arrow.up" android="share" size={18} color={ON_DARK_TEXT_SECONDARY} />
            </Pressable>
          )}
          <Pressable onPress={onClose} accessibilityRole="button" hitSlop={10}>
            <Icon ios="xmark" android="close" size={18} color={ON_DARK_TEXT_SECONDARY} />
          </Pressable>
        </View>
      </View>
      <ShareSheet visible={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />

      {/* Distance/Pace/Time/Tiles — the four stats Pedro asked this bubble
          to carry once it became the Leaderboard's own detail view, not just
          a saved-run card. Pace/time read '—' rather than 0:00 when duration
          is missing (older rows predate duration_s, or a queued run with a
          zero-length clock) — a fabricated pace is worse than an honest gap. */}
      <View style={styles.statRow}>
        <Stat label={t('track.distance')} value={formatDistance(distanceM)} />
        <Stat label={t('track.pace')} value={pace ?? '—'} />
        <Stat label={t('track.time')} value={durationS > 0 ? formatDuration(durationS) : '—'} />
        <Stat label={t('track.tiles')} value={String(tiled.length)} />
      </View>

      {queued && (
        <View style={styles.pendingBadge}>
          <ActivityIndicator size="small" color={ON_DARK_TEXT_SECONDARY} />
          <Text style={[styles.pendingBadgeText, { color: ON_DARK_TEXT_SECONDARY }]}>
            {t('myraces.pendingLabel')}
          </Text>
        </View>
      )}

      {fence?.flagged && (
        <View style={styles.detailNoticeRow}>
          <Icon ios="exclamationmark.triangle.fill" android="warning" size={12} color={c.accent} />
          <Text style={[styles.detailNoticeText, { color: c.accent }]}>{t('myraces.fenceFlagged')}</Text>
        </View>
      )}
      {fence && fence.lostM2 > 0 && (
        <View style={styles.detailNoticeRow}>
          <Icon ios="flag.slash" android="flag" size={12} color={c.accent} />
          <Text style={[styles.detailNoticeText, { color: c.accent }]}>
            {fence.geometry === null
              ? t('myraces.fenceFullyTaken')
              : t('myraces.fenceLost', { area: formatArea(fence.lostM2) })}
          </Text>
        </View>
      )}

      {retryFailure && !retryFailure.ok && (
        <Text style={[styles.detailNoticeText, { color: c.accent }]}>{t(SYNC_FAILURE_KEYS[retryFailure.reason])}</Text>
      )}
      {deleteFailure && !deleteFailure.ok && (
        <Text style={[styles.detailNoticeText, { color: c.accent }]}>{t(DELETE_FAILURE_KEYS[deleteFailure.reason])}</Text>
      )}

      {confirmingDelete ? (
        <View style={styles.detailConfirm}>
          <Text style={[styles.detailNoticeText, { color: ON_DARK_TEXT_SECONDARY }]}>{t('track.deleteConfirmBody')}</Text>
          <View style={styles.detailActions}>
            <Pressable onPress={() => setConfirmingDelete(false)} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.detailAction, { color: ON_DARK_TEXT_SECONDARY }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => void (queued ? handleDeleteQueued() : handleDeleteSaved())}
              disabled={deleting}
              accessibilityRole="button"
              hitSlop={10}>
              <Text style={[styles.detailAction, { color: c.accent, opacity: deleting ? 0.5 : 1 }]}>
                {deleting ? t('track.deleting') : t('track.deleteConfirmAction')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.detailActions}>
          {queued && (
            <Pressable onPress={() => void handleRetry()} disabled={retrying} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.detailAction, { color: c.accent, opacity: retrying ? 0.5 : 1 }]}>
                {retrying ? t('track.saving') : t('common.retry')}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => setConfirmingDelete(true)}
            disabled={deleting || retrying}
            accessibilityRole="button"
            hitSlop={10}>
            <Text style={[styles.detailAction, { color: ON_DARK_TEXT_SECONDARY, opacity: deleting || retrying ? 0.5 : 1 }]}>
              {t('track.deleteRun')}
            </Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: ON_DARK_TEXT }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: ON_DARK_TEXT_SECONDARY }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const ON_DARK_TEXT = '#ffffff';
const ON_DARK_TEXT_SECONDARY = 'rgba(255,255,255,0.65)';

const styles = StyleSheet.create({
  stage: { flex: 1 },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  legendText: { fontSize: 13, fontWeight: '600' },
  mapStage: { flex: 1 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: Spacing.six },
  emptyWrapGrow: { flexGrow: 1 },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22, paddingHorizontal: Spacing.four },

  detailBubbleWrap: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: BottomTabInset + Spacing.three,
    overflow: 'hidden',
    borderRadius: GlassRadii.sheet,
    padding: Spacing.three,
    gap: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  detailMeta: { gap: Spacing.half },
  detailHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  detailDate: { fontSize: 16, fontWeight: '700' },
  detailStats: { fontSize: 13, fontWeight: '600' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { gap: 1 },
  statValue: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11, fontWeight: '600' },
  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.half,
    paddingHorizontal: Spacing.two,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  pendingBadgeText: { fontSize: 12, fontWeight: '700' },
  detailNoticeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  detailNoticeText: { fontSize: 13, lineHeight: 18 },
  detailConfirm: { gap: Spacing.two },
  detailActions: { flexDirection: 'row', gap: Spacing.four, justifyContent: 'flex-end' },
  detailAction: { fontSize: 14, fontWeight: '700' },
});
