// The floating profile pill — Amazon-style avatar circle, top-right,
// present on all three main tabs (Run/Leaderboard/Races). Added 2026-09-17
// when the nav restructure dropped Profile/Settings off the bottom tab bar
// entirely: it used to be a tab (person.crop.circle icon), it is now the
// only way back into that screen, which now lives outside the tab
// navigator at the root (`src/app/profile/`) so it gets a real back button
// instead of the old hidden-tab-bar hack — see (tabs)/_layout.tsx's git
// history for what that used to take.
//
// Always dark glass regardless of the app's own theme, same reasoning as
// the bottom tab bar's own TabBarBackground: this floats OVER whatever the
// screen under it is showing (a map, a list, a feed), not docked against a
// page's own background.
import { useRouter } from 'expo-router';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { Icon } from '@/components/ui/icon';
import { Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';

const SIZE = 40;
const TOP_MARGIN = Spacing.two;
const SIDE_MARGIN = Spacing.three;

export function ProfilePill() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <Pressable
        onPress={() => router.push('/profile')}
        accessibilityRole="button"
        accessibilityLabel={t('tabs.settings')}
        hitSlop={8}
        style={[
          styles.pill,
          { top: insets.top + TOP_MARGIN, right: SIDE_MARGIN },
        ]}>
        {isLiquidGlassAvailable() ? (
          <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme="dark" />
        ) : (
          <GlassSurface scheme="dark" radius={GlassRadii.pill} noShadow style={StyleSheet.absoluteFill} />
        )}
        {/* react-native-web gives every View `position: relative` by default,
            which is what makes absolute overlays and normal siblings paint in
            DOM order almost everywhere in this app. icon.web.tsx's <Icon>
            breaks that: it returns a bare <svg>, so on web it stays
            `position: static` and paints BEFORE the absolutely-positioned
            glass layer above regardless of JSX order — the glyph rendered,
            just buried under the glass. Every other <Icon> call site in the
            app is wrapped in at least a Pressable/View, which inherits the
            relative-by-default position and stacks correctly; this is the
            one place it sat bare next to an absolute sibling. */}
        <View>
          <Icon ios="person.fill" android="person" size={23} color="#ffffff" />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFill, zIndex: 10 },
  pill: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
});
