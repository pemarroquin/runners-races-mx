// Filter sheet — full-height panel sliding in from the right edge (reference:
// eBay's filter UI), not a centered modal. Shell borrows buy-sheet.tsx's
// spring-slide scaffold with the axis swapped (translateX instead of
// translateY); the WebView-specific progress bar and drag gesture don't
// apply to a static chip list, so they're dropped.
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
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { GlassButton } from '@/components/ui/glass-button';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { DISTANCE_TAGS, distanceTagLabelKey, type DistanceTag } from '@/lib/races';

const SHEET_RATIO = 0.9;

interface FilterSheetProps {
  visible: boolean;
  onClose: () => void;
  distances: Set<DistanceTag>;
  onToggleDistance: (tag: DistanceTag) => void;
  months: Set<string>; // month keys + 'tbd'
  onToggleMonth: (key: string) => void;
  availableMonths: { key: string; label: string }[];
  onClear: () => void;
  resultCount: number;
}

export function FilterSheet({
  visible,
  onClose,
  distances,
  onToggleDistance,
  months,
  onToggleMonth,
  availableMonths,
  onClear,
  resultCount,
}: FilterSheetProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { width: windowW } = useWindowDimensions();
  const sheetW = windowW * SHEET_RATIO;
  const reduced = useReducedMotion();

  // Keep the Modal mounted while the exit animation plays.
  const [mounted, setMounted] = useState(false);
  const translateX = useSharedValue(sheetW);
  const backdrop = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateX.value = reduced
        ? withTiming(0, { duration: 0 })
        : withSpring(0, { duration: 500, dampingRatio: 1 });
      backdrop.value = withTiming(1, {
        duration: reduced ? 0 : 250,
        easing: Easing.out(Easing.quad),
      });
    } else if (mounted) {
      backdrop.value = withTiming(0, {
        duration: reduced ? 0 : 200,
        easing: Easing.out(Easing.quad),
      });
      translateX.value = withTiming(
        sheetW,
        { duration: reduced ? 0 : 220, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sheetW, reduced]);

  const close = useCallback(() => onClose(), [onClose]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  if (!mounted) return null;

  return (
    <Modal transparent statusBarTranslucent visible onRequestClose={close} animationType="none">
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>

        <Animated.View
          style={[styles.sheet, { width: sheetW, backgroundColor: c.background }, sheetStyle]}>
          <GlassSurface
            scheme={scheme}
            radius={0}
            noShadow
            style={[styles.header, { borderBottomColor: c.backgroundSelected }]}
            contentStyle={styles.headerContent}>
            <GlassButton
              scheme={scheme}
              onPress={close}
              size={32}
              radius={16}
              accessibilityLabel={t('detail.close')}>
              <Icon ios="xmark" android="close" size={14} color={c.text} />
            </GlassButton>
            <Text style={[styles.title, { color: c.text }]}>{t('filters.title')}</Text>
            <Pressable onPress={onClear} hitSlop={8}>
              <Text style={[styles.resetText, { color: c.accent }]}>{t('filters.reset')}</Text>
            </Pressable>
          </GlassSurface>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>
              {t('filters.distance')}
            </Text>
            <View style={styles.chipGrid}>
              {DISTANCE_TAGS.map((tag) => {
                const active = distances.has(tag);
                const label = <Text style={[styles.chipText, { color: active ? c.background : c.text }]}>{t(distanceTagLabelKey(tag))}</Text>;
                return active ? (
                  <Pressable key={tag} onPress={() => onToggleDistance(tag)} style={[styles.chip, { backgroundColor: c.text }]}>
                    {label}
                  </Pressable>
                ) : (
                  <Pressable key={tag} onPress={() => onToggleDistance(tag)}>
                    <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chip}>
                      {label}
                    </GlassSurface>
                  </Pressable>
                );
              })}
            </View>

            <Text
              style={[styles.sectionTitle, { color: c.textSecondary, marginTop: Spacing.four }]}>
              {t('filters.date')}
            </Text>
            <View style={styles.chipGrid}>
              {availableMonths.map((m) => {
                const active = months.has(m.key);
                const label = (
                  <Text style={[styles.chipText, { color: active ? c.background : c.text }]}>
                    {m.key === 'tbd' ? t('common.tbd') : m.label}
                  </Text>
                );
                return active ? (
                  <Pressable key={m.key} onPress={() => onToggleMonth(m.key)} style={[styles.chip, { backgroundColor: c.text }]}>
                    {label}
                  </Pressable>
                ) : (
                  <Pressable key={m.key} onPress={() => onToggleMonth(m.key)}>
                    <GlassSurface scheme={scheme} radius={GlassRadii.chip} noShadow contentStyle={styles.chip}>
                      {label}
                    </GlassSurface>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          <GlassSurface
            scheme={scheme}
            radius={0}
            noShadow
            style={[styles.footer, { borderTopColor: c.backgroundSelected }]}
            contentStyle={styles.footerContent}>
            <Pressable
              onPress={close}
              style={[styles.showBtn, { backgroundColor: c.text }]}>
              <Text style={[styles.showBtnText, { color: c.background }]}>
                {t('filters.showResults', { count: resultCount })}
              </Text>
            </Pressable>
          </GlassSurface>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: { height: '100%' },
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.two,
  },
  title: { fontSize: 17, fontWeight: '700' },
  resetText: { fontSize: 14, fontWeight: '600' },
  body: { flex: 1 },
  bodyContent: { padding: Spacing.three },
  sectionTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  chip: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.one, borderRadius: GlassRadii.chip },
  chipText: { fontSize: 13, fontWeight: '600' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
  footerContent: { padding: Spacing.three },
  showBtn: {
    borderRadius: GlassRadii.pill,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  showBtnText: { fontSize: 15, fontWeight: '700' },
});
