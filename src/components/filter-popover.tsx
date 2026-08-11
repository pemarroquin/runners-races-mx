// Compact per-facet filter popover — replaces the old 90%-height FilterSheet.
// Competitor teardown (Strava's Races directory): each filter dimension gets
// its own pill, tapping one opens a small card anchored near that pill with
// a fixed Reset/Done footer, and the list underneath stays visible the whole
// time. A full-screen takeover costs more per change than that — no full
// takeover, no losing your place in the list, one tap to reopen a different
// facet.
//
// Anchoring: `top` is computed by the caller from the facet chip row's own
// onLayout height (see index.tsx) — good enough to land the card just below
// the row without measureInWindow gymnastics. The card sizes to its content
// up to a capped width, left-aligned under the chip row rather than
// edge-to-edge.
import { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import {
  DISTANCE_TAGS,
  currentMonthKey,
  distanceTagLabelKey,
  nextMonthKeys,
  type DistanceTag,
} from '@/lib/races';

const CARD_MAX_WIDTH = 380;

export type FilterFacet = 'distance' | 'month' | null;

interface FilterPopoverProps {
  facet: FilterFacet;
  onClose: () => void;
  top: number;
  distances: Set<DistanceTag>;
  onToggleDistance: (tag: DistanceTag) => void;
  onResetDistances: () => void;
  months: Set<string>;
  onToggleMonth: (key: string) => void;
  onSetMonths: (keys: Set<string>) => void;
  onResetMonths: () => void;
  availableMonths: { key: string; label: string }[];
}

function sameKeys(a: Set<string>, b: string[]): boolean {
  return a.size === b.length && b.every((k) => a.has(k));
}

export function FilterPopover({
  facet,
  onClose,
  top,
  distances,
  onToggleDistance,
  onResetDistances,
  months,
  onToggleMonth,
  onSetMonths,
  onResetMonths,
  availableMonths,
}: FilterPopoverProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { width: windowW } = useWindowDimensions();
  const reduced = useReducedMotion();
  const visible = facet !== null;

  // Keep the Modal mounted while the exit animation plays.
  const [mounted, setMounted] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.value = withTiming(1, {
        duration: reduced ? 0 : 180,
        easing: Easing.out(Easing.quad),
      });
    } else if (mounted) {
      progress.value = withTiming(
        0,
        { duration: reduced ? 0 : 120, easing: Easing.in(Easing.quad) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduced]);

  const close = useCallback(() => onClose(), [onClose]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.96 + progress.value * 0.04 }],
  }));

  if (!mounted) return null;

  const isDistance = facet === 'distance';
  const title = isDistance ? t('filters.distance') : t('filters.date');
  const onReset = isDistance ? onResetDistances : onResetMonths;
  const cardWidth = Math.min(windowW - Spacing.three * 2, CARD_MAX_WIDTH);

  const presets: { key: string; label: string; keys: string[] }[] = [
    { key: 'thisMonth', label: t('filters.presetThisMonth'), keys: [currentMonthKey()] },
    { key: 'next3', label: t('filters.presetNext3'), keys: nextMonthKeys(3) },
    { key: 'all', label: t('filters.presetAll'), keys: [] },
  ];

  return (
    <Modal transparent statusBarTranslucent visible onRequestClose={close} animationType="none">
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t('filters.done')} />
        </Animated.View>

        <Animated.View style={[styles.cardWrap, { top, width: cardWidth }, cardStyle]}>
          <GlassSurface scheme={scheme} radius={GlassRadii.card} contentStyle={styles.cardContent}>
            <Text style={[styles.title, { color: c.text }]}>{title}</Text>

            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              {isDistance ? (
                <View style={styles.chipGrid}>
                  {DISTANCE_TAGS.map((tag) => {
                    const active = distances.has(tag);
                    const label = (
                      <Text style={[styles.chipText, { color: active ? c.background : c.text }]}>
                        {t(distanceTagLabelKey(tag))}
                      </Text>
                    );
                    return active ? (
                      <Pressable
                        key={tag}
                        onPress={() => onToggleDistance(tag)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: true }}
                        style={[styles.chip, { backgroundColor: c.text }]}>
                        {label}
                      </Pressable>
                    ) : (
                      <Pressable
                        key={tag}
                        onPress={() => onToggleDistance(tag)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: false }}>
                        <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chip}>
                          {label}
                        </GlassSurface>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <>
                  {/* Fast-path presets ahead of the full month grid — Strava
                      front-loads the common case (segmented pills) before
                      falling through to the escape hatch (full picker). */}
                  <View style={[styles.segmentTrack, { backgroundColor: c.backgroundElement }]}>
                    {presets.map((preset) => {
                      const active = sameKeys(months, preset.keys);
                      return (
                        <Pressable
                          key={preset.key}
                          onPress={() => onSetMonths(new Set(preset.keys))}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: active }}
                          style={[styles.segment, active && { backgroundColor: c.text }]}>
                          <Text
                            style={[styles.segmentText, { color: active ? c.background : c.text }]}>
                            {preset.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <View style={styles.chipGrid}>
                    {availableMonths.map((m) => {
                      const active = months.has(m.key);
                      const label = (
                        <Text style={[styles.chipText, { color: active ? c.background : c.text }]}>
                          {m.key === 'tbd' ? t('common.tbd') : m.label}
                        </Text>
                      );
                      return active ? (
                        <Pressable
                          key={m.key}
                          onPress={() => onToggleMonth(m.key)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: true }}
                          style={[styles.chip, { backgroundColor: c.text }]}>
                          {label}
                        </Pressable>
                      ) : (
                        <Pressable
                          key={m.key}
                          onPress={() => onToggleMonth(m.key)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: false }}>
                          <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chip}>
                            {label}
                          </GlassSurface>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}
            </ScrollView>

            <View style={[styles.footer, { borderTopColor: c.backgroundSelected }]}>
              <Pressable onPress={onReset} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.resetText, { color: c.accent }]}>{t('filters.reset')}</Text>
              </Pressable>
              <Pressable onPress={close} hitSlop={8} accessibilityRole="button">
                <View style={[styles.doneBtn, { backgroundColor: c.text }]}>
                  <Text style={[styles.doneText, { color: c.background }]}>{t('filters.done')}</Text>
                </View>
              </Pressable>
            </View>
          </GlassSurface>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  cardWrap: {
    position: 'absolute',
    left: Spacing.three,
  },
  cardContent: { padding: Spacing.three },
  title: { fontSize: 15, fontWeight: '700', marginBottom: Spacing.two },
  body: { maxHeight: 340 },
  bodyContent: { paddingBottom: Spacing.one },
  segmentTrack: {
    flexDirection: 'row',
    borderRadius: GlassRadii.pill,
    padding: 3,
    gap: 2,
    marginBottom: Spacing.three,
  },
  segment: {
    flex: 1,
    borderRadius: GlassRadii.pill,
    paddingVertical: Spacing.one + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { fontSize: 12, fontWeight: '700' },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: GlassRadii.chip,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.three,
    paddingTop: Spacing.three,
  },
  resetText: { fontSize: 14, fontWeight: '600' },
  doneBtn: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.one + 4,
    borderRadius: GlassRadii.pill,
  },
  doneText: { fontSize: 14, fontWeight: '700' },
});
