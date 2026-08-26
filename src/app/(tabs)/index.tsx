// Territory Mode's main screen: record a run, close it into a fence, save it.
// Phase 1 of the feature plan — no leaderboard and no cross-user overlap yet,
// but every saved run already lands in Supabase, so those read from real data
// when they land.
import { Image } from 'expo-image';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RouteTrace } from '@/components/route-trace';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { buildFenceMapUrl, FENCE_MAP_ASPECT } from '@/lib/mapbox';
import { buildFence, type FenceResult } from '@/lib/territory';
import { uploadRun, type SyncOutcome } from '@/lib/territory-sync';
import { formatArea, formatDistance, formatDuration, useRunTracker } from '@/lib/tracking';

const TRACE_HEIGHT = 260;
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export default function TrackScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const tracker = useRunTracker();

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [failure, setFailure] = useState<SyncOutcome | null>(null);

  // Only computed once the run is over — running this on every fix would
  // redo the whole simplify/unkink/union pipeline several times a minute
  // for a shape nobody is looking at yet.
  const fence: FenceResult | null = useMemo(
    () => (tracker.status === 'finished' ? buildFence(tracker.points) : null),
    [tracker.status, tracker.points],
  );

  const fenceMapUrl = useMemo(
    () => (fence ? buildFenceMapUrl(fence.geometry.geometry, scheme === 'dark') : null),
    [fence, scheme],
  );

  const save = useCallback(async () => {
    if (!fence || tracker.startedAt === null || tracker.endedAt === null) return;
    setSaveState('saving');
    setFailure(null);
    const outcome = await uploadRun({
      points: tracker.points,
      fence,
      distanceM: tracker.distanceM,
      startedAt: tracker.startedAt,
      endedAt: tracker.endedAt,
    });
    if (outcome.ok) {
      setSaveState('saved');
    } else {
      // Keep the run on screen. It only exists in memory, so clearing it on
      // a failed upload would destroy the thing the runner just earned.
      setSaveState('failed');
      setFailure(outcome);
    }
  }, [fence, tracker.points, tracker.distanceM, tracker.startedAt, tracker.endedAt]);

  const discard = useCallback(() => {
    setSaveState('idle');
    setFailure(null);
    tracker.reset();
  }, [tracker]);

  const isFinished = tracker.status === 'finished';
  const isRunning = tracker.status === 'running' || tracker.status === 'starting';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: c.text }]}>
          {isFinished ? t('track.summaryTitle') : t('track.title')}
        </Text>

        {tracker.status === 'idle' && (
          <Text style={[styles.intro, { color: c.textSecondary }]}>{t('track.intro')}</Text>
        )}

        {/* Live trace while running; the closed fence once it's over. */}
        {(isRunning || isFinished) && (
          <View style={[styles.traceCard, { backgroundColor: c.backgroundElement }]}>
            {tracker.points.length < 2 ? (
              <View style={[styles.tracePlaceholder, { height: TRACE_HEIGHT }]}>
                <Text style={[styles.placeholderText, { color: c.textSecondary }]}>
                  {t('track.waiting')}
                </Text>
              </View>
            ) : (
              <RouteTrace
                points={tracker.points}
                closed={isFinished && fence !== null}
                color={c.accent}
                height={TRACE_HEIGHT}
              />
            )}
          </View>
        )}

        {(isRunning || isFinished) && (
          <View style={styles.stats}>
            <Stat label={t('track.time')} value={formatDuration(tracker.elapsedS)} c={c} />
            <Stat label={t('track.distance')} value={formatDistance(tracker.distanceM)} c={c} />
            {isFinished && (
              <Stat
                label={t('track.area')}
                value={fence ? formatArea(fence.areaM2) : '—'}
                c={c}
              />
            )}
          </View>
        )}

        {tracker.status === 'running' && (
          <Text style={[styles.hint, { color: c.textSecondary }]}>{t('track.keepOpen')}</Text>
        )}

        {/* The fence over real streets. Only worth a network request once,
            at the end — see route-trace.tsx for why the live view is SVG. */}
        {isFinished && fenceMapUrl && (
          <Animated.View entering={FadeIn.duration(400)} style={styles.mapWrap}>
            <Image
              source={{ uri: fenceMapUrl }}
              style={styles.map}
              contentFit="cover"
              accessibilityLabel={t('track.summaryTitle')}
            />
          </Animated.View>
        )}

        {isFinished && !fence && (
          <Text style={[styles.notice, { color: c.textSecondary }]}>{t('track.noFence')}</Text>
        )}

        {tracker.error === 'permission' && (
          <Text style={[styles.notice, { color: c.textSecondary }]}>{t('track.permission')}</Text>
        )}
        {tracker.error === 'unavailable' && (
          <Text style={[styles.notice, { color: c.textSecondary }]}>{t('track.unavailable')}</Text>
        )}

        {saveState === 'failed' && failure && !failure.ok && (
          <Text style={[styles.notice, { color: c.accent }]}>
            {failure.reason === 'disabled'
              ? t('track.syncDisabled')
              : failure.reason === 'auth'
                ? t('track.syncFailedAuth')
                : t('track.syncFailedNetwork')}
          </Text>
        )}
        {saveState === 'saved' && (
          <Animated.Text
            entering={FadeInDown.duration(320)}
            style={[styles.notice, { color: c.accent }]}>
            {t('track.saved')}
          </Animated.Text>
        )}

        <View style={styles.actions}>
          {tracker.status === 'idle' && (
            <PrimaryButton label={t('track.start')} onPress={tracker.start} c={c} />
          )}
          {tracker.status === 'starting' && (
            <PrimaryButton label={t('track.starting')} onPress={() => {}} disabled c={c} />
          )}
          {tracker.status === 'running' && (
            <PrimaryButton label={t('track.stop')} onPress={tracker.stop} c={c} />
          )}
          {isFinished && (
            <>
              {fence && saveState !== 'saved' && (
                <PrimaryButton
                  label={saveState === 'saving' ? t('track.saving') : saveState === 'failed' ? t('track.retry') : t('track.save')}
                  onPress={save}
                  disabled={saveState === 'saving'}
                  busy={saveState === 'saving'}
                  c={c}
                />
              )}
              <Pressable onPress={discard} accessibilityRole="button" hitSlop={10}>
                <Text style={[styles.secondary, { color: c.textSecondary }]}>
                  {t('track.discard')}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: Record<ThemeColor, string>;
}) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.textSecondary }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.statValue, { color: c.text }]}>{value}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  c,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  c: Record<ThemeColor, string>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : {}}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: c.accent, opacity: disabled ? 0.6 : pressed ? 0.85 : 1 },
      ]}>
      {busy && <ActivityIndicator color="#ffffff" style={styles.spinner} />}
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.three, paddingBottom: BottomTabInset },
  title: { fontSize: 28, fontWeight: '700' },
  intro: { fontSize: 15, lineHeight: 22 },
  traceCard: { borderRadius: Spacing.three, overflow: 'hidden' },
  tracePlaceholder: { alignItems: 'center', justifyContent: 'center', padding: Spacing.three },
  placeholderText: { fontSize: 14, textAlign: 'center' },
  stats: { flexDirection: 'row', gap: Spacing.three },
  stat: { flex: 1, gap: Spacing.half },
  statLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  statValue: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hint: { fontSize: 13, textAlign: 'center' },
  notice: { fontSize: 14, lineHeight: 20 },
  mapWrap: { borderRadius: Spacing.three, overflow: 'hidden', aspectRatio: FENCE_MAP_ASPECT },
  map: { width: '100%', height: '100%' },
  actions: { gap: Spacing.three, alignItems: 'center', marginTop: Spacing.two },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.five,
    borderRadius: 999,
    minWidth: 220,
  },
  primaryLabel: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  spinner: { marginRight: Spacing.one },
  secondary: { fontSize: 15, fontWeight: '600' },
});
