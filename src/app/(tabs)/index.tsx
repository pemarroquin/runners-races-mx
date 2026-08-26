// Territory Mode's main screen: record a run, close it into a fence, save it.
// Phase 1 of the feature plan — no leaderboard and no cross-user overlap yet,
// but every saved run already lands in Supabase, so those read from real data
// when they land.
//
// The map is the screen, not a card on it: streets are visible from the
// moment the tab opens, and the controls sit over them. See track-map.tsx
// for why the route is baked into the Mapbox image rather than overlaid.
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
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

import { TrackMap } from '@/components/track-map';
import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { buildFenceMapUrl, FENCE_MAP_ASPECT } from '@/lib/mapbox';
import { buildFence, type FenceResult } from '@/lib/territory';
import { uploadRun, type SyncOutcome } from '@/lib/territory-sync';
import { formatArea, formatDistance, formatDuration, useRunTracker } from '@/lib/tracking';
import { useCurrentLocation } from '@/lib/use-current-location';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

// Not in constants/theme.ts: these are traffic-light semantics for one
// control pair, not part of the app's palette.
const PAUSE_COLOR = '#F5C518';
const STOP_COLOR = '#E5484D';

export default function TrackScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const tracker = useRunTracker();
  // Asks for permission on mount so the map can centre on the runner before
  // they press Start — the pin used to sit on the selected city's centre.
  const location = useCurrentLocation();

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

  // The finished run gets its own scrolling layout: there's a fence image,
  // three stats and two actions to fit, which is more than can sit legibly
  // over a live map.
  if (tracker.status === 'finished') {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
        <View style={styles.summaryClose}>
          <RoundButton
            label={t('track.close')}
            onPress={discard}
            background={c.backgroundElement}
            foreground={c.text}
            ios="xmark"
            android="close"
          />
        </View>
        <ScrollView contentContainerStyle={styles.summary}>
          <Text style={[styles.summaryTitle, { color: c.text }]}>{t('track.summaryTitle')}</Text>

          {fenceMapUrl && (
            <Animated.View entering={FadeIn.duration(400)} style={styles.fenceMapWrap}>
              <Image
                source={{ uri: fenceMapUrl }}
                style={styles.fenceMap}
                contentFit="cover"
                accessibilityLabel={t('track.summaryTitle')}
              />
            </Animated.View>
          )}

          <View style={styles.stats}>
            <Stat label={t('track.time')} value={formatDuration(tracker.elapsedS)} c={c} />
            <Stat label={t('track.distance')} value={formatDistance(tracker.distanceM)} c={c} />
            <Stat label={t('track.area')} value={fence ? formatArea(fence.areaM2) : '—'} c={c} />
          </View>

          {!fence && (
            <Text style={[styles.notice, { color: c.textSecondary }]}>{t('track.noFence')}</Text>
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

          <View style={styles.summaryActions}>
            {fence && saveState !== 'saved' && (
              <PrimaryButton
                label={
                  saveState === 'saving'
                    ? t('track.saving')
                    : saveState === 'failed'
                      ? t('track.retry')
                      : t('track.save')
                }
                onPress={save}
                disabled={saveState === 'saving'}
                busy={saveState === 'saving'}
                c={c}
              />
            )}
            <Pressable onPress={discard} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.secondary, { color: c.textSecondary }]}>
                {saveState === 'saved' ? t('track.close') : t('track.discard')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const running = tracker.status === 'running';
  const starting = tracker.status === 'starting';
  const paused = tracker.status === 'paused';
  // A session "owns" the screen from the moment Start is pressed: the map
  // goes full-bleed 3D, and the idle chrome (scrim + title + Start) gets out
  // of the way rather than sitting on top of the run.
  const inSession = running || starting || paused;

  return (
    <View style={[styles.stage, { backgroundColor: c.backgroundElement }]}>
      <TrackMap
        points={tracker.points}
        running={running}
        here={location.coords}
        active={inSession}
        dark={scheme === 'dark'}
        color={c.accent}
        placeholder={t('track.waiting')}
        placeholderColor={c.textSecondary}
        unavailable={t('track.mapUnavailable')}
      />

      {/* The map is always dark (MAP_ALWAYS_DARK), so a plain white scrim
          reliably lifts the title/button above it regardless of the app's
          own light/dark setting — this is contrast against the MAP, not
          against the screen's theme. Removed during a session: it exists to
          make the idle title readable, and there is no idle title then. */}
      {!inSession && (
        <LinearGradient
          colors={['rgba(255,255,255,1)', 'rgba(255,255,255,0)']}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}

      {/* Session controls, top-right. Pause is yellow and Stop is red, so
          the destructive one is never the one you hit by muscle memory. */}
      {inSession && (
        <SafeAreaView style={styles.controls} edges={['top']}>
          <Animated.View entering={FadeIn.duration(400)} style={styles.controlRow}>
            <RoundButton
              label={paused ? t('track.resume') : t('track.pause')}
              onPress={paused ? tracker.resume : tracker.pause}
              background={PAUSE_COLOR}
              foreground="#1A1A1A"
              ios={paused ? 'play.fill' : 'pause.fill'}
              android={paused ? 'play_arrow' : 'pause'}
            />
            <RoundButton
              label={t('track.stop')}
              onPress={tracker.stop}
              background={STOP_COLOR}
              foreground="#FFFFFF"
              ios="stop.fill"
              android="stop"
            />
          </Animated.View>
        </SafeAreaView>
      )}

      <SafeAreaView style={styles.overlay} edges={['top']}>
        <View style={[styles.overlayInner, inSession && styles.overlayInnerSession]}>
          {inSession ? (
            <Animated.View entering={FadeInDown.duration(400)} style={styles.liveStats}>
              <Text style={[styles.liveTime, { color: '#FFFFFF' }]}>
                {formatDuration(tracker.elapsedS)}
              </Text>
              <Text style={[styles.liveDistance, { color: 'rgba(255,255,255,0.75)' }]}>
                {formatDistance(tracker.distanceM)}
                {paused ? `  ·  ${t('track.paused')}` : ''}
              </Text>
              {/* Recording is foreground-only, so locking the phone ends the
                  run. Saying so is not optional: the failure is silent and
                  costs the runner the whole session. */}
              <Text style={[styles.keepOpen, { color: 'rgba(255,255,255,0.6)' }]}>
                {t('track.keepOpen')}
              </Text>
            </Animated.View>
          ) : (
            <>
              <Text style={[styles.stageTitle, { color: c.text }]}>{t('track.newSession')}</Text>
              {tracker.error === 'permission' && (
                <Text style={[styles.overlayNotice, { color: c.text }]}>{t('track.permission')}</Text>
              )}
              {tracker.error === 'unavailable' && (
                <Text style={[styles.overlayNotice, { color: c.text }]}>{t('track.unavailable')}</Text>
              )}
              <PrimaryButton label={t('track.start')} onPress={tracker.start} c={c} />
            </>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

function RoundButton({
  label,
  onPress,
  background,
  foreground,
  ios,
  android,
}: {
  label: string;
  onPress: () => void;
  background: string;
  foreground: string;
  ios: SFSymbol;
  android: AndroidSymbol;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: background, opacity: pressed ? 0.85 : 1 },
      ]}>
      <Icon ios={ios} android={android} size={20} color={foreground} />
    </Pressable>
  );
}

function Stat({ label, value, c }: { label: string; value: string; c: Record<ThemeColor, string> }) {
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
  stage: { flex: 1 },

  // box-none in style, not as a prop: the prop form is deprecated in
  // this RN version and warns on every render.
  overlay: { ...StyleSheet.absoluteFill, pointerEvents: 'box-none' },
  overlayInner: {
    flex: 1,
    pointerEvents: 'box-none',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    // Balances the floating tab bar so "centred" means centred in what the
    // eye actually sees, plus a small optical lift.
    paddingBottom: BottomTabInset + Spacing.three,
  },
  stageTitle: { fontSize: 30, fontWeight: '700', textAlign: 'center' },
  controls: { position: 'absolute', top: 0, right: 0, zIndex: 2 },
  controlRow: { flexDirection: 'row', gap: Spacing.two, padding: Spacing.three },
  round: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  summaryClose: { position: 'absolute', top: 0, right: 0, zIndex: 2, padding: Spacing.three },
  // During a session the stats sit high rather than centred: the lower half
  // of the screen is where the 3D route and fence are, and centring the
  // numbers would park them right on top of it.
  overlayInnerSession: { justifyContent: 'flex-start', paddingTop: Spacing.six },
  overlayNotice: { fontSize: 14, lineHeight: 20, textAlign: 'center' },

  liveStats: { alignItems: 'center', gap: Spacing.one },
  liveTime: { fontSize: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  liveDistance: { fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  keepOpen: { fontSize: 12, textAlign: 'center', marginTop: Spacing.two, maxWidth: 260 },

  summary: { padding: Spacing.three, gap: Spacing.three, paddingBottom: BottomTabInset },
  summaryTitle: { fontSize: 28, fontWeight: '700' },
  fenceMapWrap: {
    borderRadius: Spacing.three,
    overflow: 'hidden',
    aspectRatio: FENCE_MAP_ASPECT,
  },
  fenceMap: { width: '100%', height: '100%' },
  summaryActions: { gap: Spacing.three, alignItems: 'center', marginTop: Spacing.two },

  stats: { flexDirection: 'row', gap: Spacing.three },
  stat: { flex: 1, gap: Spacing.half },
  statLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  statValue: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },

  notice: { fontSize: 14, lineHeight: 20 },
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
