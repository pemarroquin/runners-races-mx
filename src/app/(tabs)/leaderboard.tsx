// Placeholder for Phase 2. The tab exists now so the bar's final five-slot
// shape is real on device, but it deliberately promises nothing it can't
// show: runs saved today DO count toward this board, because they're already
// in Supabase with the area computed — Phase 2 is a read query over rows
// that will exist by then, not a migration.
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';

export default function LeaderboardScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('leaderboard.title')}</Text>
      <Animated.View entering={FadeIn.duration(400)} style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: c.backgroundElement }]}>
          <Icon ios="trophy" android="trophy" size={28} color={c.textSecondary} />
        </View>
        <Text style={[styles.soonTitle, { color: c.text }]}>{t('leaderboard.soonTitle')}</Text>
        <Text style={[styles.soonBody, { color: c.textSecondary }]}>
          {t('leaderboard.soonBody')}
        </Text>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.five,
    paddingBottom: BottomTabInset,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  soonTitle: { fontSize: 20, fontWeight: '700' },
  soonBody: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
