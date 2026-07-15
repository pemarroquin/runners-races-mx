import { Tabs } from 'expo-router';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Image, StyleSheet, View, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/lib/i18n';

// Floating icon-only pill, Instagram-style — always dark chrome regardless of
// the app's own light/dark theme, since it floats *over* content rather than
// docking at the screen edge. Height/margins are fixed rather than derived
// from BottomTabInset (that constant sizes list content's bottom padding to
// clear this bar + its floating gap, not the bar itself).
const BAR_HEIGHT = 56;
const BAR_BOTTOM_MARGIN = 16;
const BAR_SIDE_MARGIN = 90;
const ICON_SIZE = 24;
const ICON_WRAP_SIZE = 44;

export default function TabsLayout() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarActiveTintColor: '#ffffff',
        tabBarInactiveTintColor: 'rgba(255,255,255,0.55)',
        // Real Liquid Glass on iOS 26+ (expo-glass-effect); everywhere else
        // (older iOS, Android, web) TabBarBackground below falls back to the
        // flat dark pill this bar shipped with originally.
        tabBarBackground: () => <TabBarBackground />,
        tabBarStyle: {
          position: 'absolute',
          left: BAR_SIDE_MARGIN,
          right: BAR_SIDE_MARGIN,
          bottom: insets.bottom + BAR_BOTTOM_MARGIN,
          height: BAR_HEIGHT,
          borderRadius: BAR_HEIGHT / 2,
          overflow: 'hidden',
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 8,
          shadowColor: '#000',
          shadowOpacity: 0.25,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
        },
        tabBarItemStyle: {
          height: BAR_HEIGHT,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.feed'),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon focused={focused} color={color} source={require('../../../assets/images/tabIcons/home.png')} />
          ),
        }}
      />
      <Tabs.Screen
        name="myraces"
        options={{
          title: t('tabs.myRaces'),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon
              focused={focused}
              color={color}
              source={require('../../../assets/images/tabIcons/explore.png')}
            />
          ),
        }}
      />
    </Tabs>
  );
}

// isLiquidGlassAvailable() is false on Android, web, and pre-26 iOS — GlassView
// itself already no-ops to a plain <View> there, but we still need to supply
// the flat-color look those platforms actually want (Liquid Glass has no
// equivalent, it's an Apple-only material), so we branch explicitly rather
// than relying on GlassView's fallback rendering.
function TabBarBackground() {
  if (isLiquidGlassAvailable()) {
    return <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme="dark" />;
  }
  return <View style={[StyleSheet.absoluteFill, styles.fallbackBackground]} />;
}

function TabIcon({
  focused,
  color,
  source,
}: {
  focused: boolean;
  color: ColorValue;
  source: number;
}) {
  return (
    <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
      <Image source={source} style={{ width: ICON_SIZE, height: ICON_SIZE, tintColor: color }} />
    </View>
  );
}

const styles = StyleSheet.create({
  fallbackBackground: {
    backgroundColor: 'rgba(20,20,22,0.92)',
  },
  iconWrap: {
    width: ICON_WRAP_SIZE,
    height: ICON_WRAP_SIZE,
    borderRadius: ICON_WRAP_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: {
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
});
