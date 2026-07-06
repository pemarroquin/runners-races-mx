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
  const { region, setRegionId, detect, detecting } = useRegion();
  const [detectFailed, setDetectFailed] = useState(false);

  async function useMyLocation() {
    setDetectFailed(false);
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
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Animated.View
          entering={FadeInDown.duration(300)}
          style={[styles.card, { backgroundColor: c.background }]}>
          <Text style={[styles.title, { color: c.text }]}>{t('city.title')}</Text>

          <Pressable
            onPress={useMyLocation}
            disabled={detecting}
            style={[styles.locateBtn, { backgroundColor: c.text }]}>
            {detecting ? (
              <ActivityIndicator size="small" color={c.background} />
            ) : (
              <Text style={[styles.locateText, { color: c.background }]}>
                ◎ {t('city.useLocation')}
              </Text>
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
                    style={[styles.row, active && { backgroundColor: c.backgroundElement }]}>
                    <Text
                      style={[
                        styles.rowText,
                        { color: c.text },
                        active && styles.rowTextActive,
                      ]}>
                      {r.name}
                    </Text>
                    {active && <Text style={{ color: c.accent }}>●</Text>}
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
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  title: { fontSize: 18, fontWeight: '700' },
  locateBtn: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
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
  hint: { fontSize: 12, textAlign: 'center' },
});
