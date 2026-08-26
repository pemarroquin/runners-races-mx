// City/metro picker — small centered modal in the app's motion vocabulary:
// quick backdrop fade + card materialize (FadeInDown), staggered rows.
// "Use my location" runs GPS (permission prompt) → IP fallback.
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { useRegion } from '@/lib/region-context';
import { REGIONS } from '@/lib/regions';

interface CityPickerProps {
  visible: boolean;
  onClose: () => void;
}

export function CityPicker({ visible, onClose }: CityPickerProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { region, setRegionId, detect, clearManualPick, detecting } = useRegion();
  const [detectFailed, setDetectFailed] = useState(false);

  async function useMyLocation() {
    setDetectFailed(false);
    // The user is explicitly asking to be located, so this must override the
    // "a manual pick wins over in-flight detection" guard in RegionProvider.
    clearManualPick();
    const method = await detect();
    if (method === 'none') {
      setDetectFailed(true); // stay open so the user can pick manually
    } else {
      onClose();
    }
  }

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Animated.View entering={FadeIn.duration(180)} style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('detail.close')}
        />
        <Animated.View entering={FadeInDown.duration(300)} style={styles.card}>
          <GlassSurface scheme={scheme} radius={GlassRadii.card} style={StyleSheet.absoluteFill} noShadow />
          <Text style={[styles.title, { color: c.text }]}>{t('city.title')}</Text>

          <Pressable
            onPress={useMyLocation}
            disabled={detecting}
            accessibilityRole="button"
            accessibilityLabel={t('city.useLocation')}
            accessibilityState={{ disabled: detecting, busy: detecting }}
            style={[styles.locateBtn, { backgroundColor: c.text }]}>
            {detecting ? (
              <ActivityIndicator size="small" color={c.background} />
            ) : (
              <View style={styles.locateRow}>
                <Icon ios="location.fill" android="my_location" size={15} color={c.background} />
                <Text style={[styles.locateText, { color: c.background }]}>
                  {t('city.useLocation')}
                </Text>
              </View>
            )}
          </Pressable>
          {detectFailed && (
            <Text style={[styles.failed, { color: c.accent }]}>{t('city.detectFailed')}</Text>
          )}

          <ScrollView style={styles.list}>
            {REGIONS.map((r, i) => {
              const active = r.id === region.id;
              return (
                <Animated.View key={r.id} entering={FadeInDown.duration(220).delay(i * 25)}>
                  <Pressable
                    onPress={() => {
                      setRegionId(r.id);
                      onClose();
                    }}
                    accessibilityRole="radio"
                    accessibilityLabel={r.name}
                    accessibilityState={{ selected: active }}
                    // react-native-web doesn't turn accessibilityState into
                    // ARIA attributes on View-based components — flat
                    // aria-checked is what actually reaches the DOM
                    // (PageSpeed Insights, 2026-08-11).
                    aria-checked={active}
                    // Row has ~34pt of visual height (padding + one line of
                    // text) — hitSlop brings the tappable area up toward
                    // Apple HIG's 44pt minimum control size without inflating
                    // the visible row.
                    hitSlop={{ top: 5, bottom: 5 }}
                    style={[styles.row, active && { backgroundColor: c.backgroundElement }]}>
                    <Text
                      style={[
                        styles.rowText,
                        { color: c.text },
                        active && styles.rowTextActive,
                      ]}>
                      {r.name}
                    </Text>
                    {active && (
                      <View style={[styles.checkDot, { backgroundColor: c.text }]}>
                        <Icon ios="checkmark" android="check" size={11} weight="bold" color={c.background} />
                      </View>
                    )}
                  </Pressable>
                </Animated.View>
              );
            })}
          </ScrollView>

          <Text style={[styles.hint, { color: c.textSecondary }]}>{t('city.mxOnly')}</Text>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '75%',
    borderRadius: GlassRadii.card,
    overflow: 'hidden',
    padding: Spacing.three,
    gap: Spacing.two,
  },
  title: { fontSize: 18, fontWeight: '700' },
  locateBtn: {
    borderRadius: GlassRadii.pill,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    // Apple HIG default control size for iOS/iPadOS is 44x44pt.
    minHeight: 44,
  },
  locateRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  locateText: { fontSize: 14, fontWeight: '600' },
  failed: { fontSize: 13 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.one,
  },
  rowText: { fontSize: 15 },
  rowTextActive: { fontWeight: '700' },
  checkDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { fontSize: 12, textAlign: 'center' },
});
