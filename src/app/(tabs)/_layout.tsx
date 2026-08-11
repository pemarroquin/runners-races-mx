import { Tabs } from 'expo-router';
// expo-router's own `Tabs` export doesn't carry this type (it's deprecated
// in favor of `expo-router/js-tabs`, same underlying component) — pull the
// type from there without switching the runtime import used app-wide.
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Image, Pressable, StyleSheet, View, useWindowDimensions, type ColorValue } from 'react-native';

import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { useI18n } from '@/lib/i18n';

// Floating icon-only pill, Instagram-style — always dark chrome regardless of
// the app's own light/dark theme, since it floats *over* content rather than
// docking at the screen edge.
//
// This is a fully custom `tabBar` (not `screenOptions.tabBarStyle` /
// `tabBarItemStyle` on the default one) on purpose: the default bar's
// per-item width comes from its own internal flex/padding logic, which
// doesn't reliably split evenly across items — with 2 tabs the active icon's
// highlight circle visibly crowded the pill's right end while the inactive
// icon on the left sat with room to spare (flagged repeatedly, never fixed by
// re-tuning BAR_WIDTH because BAR_WIDTH was never the actual bug). Owning the
// row directly with `flex: 1` per item guarantees every tab gets an equal
// share of the pill width, so the layout stays symmetric no matter how many
// tabs there are.
const BAR_HEIGHT = 56;
const BAR_BOTTOM_MARGIN = 16;
const ICON_SIZE = 24;
const ICON_WRAP_SIZE = 44;
// Per-tab slot width: icon circle + fixed breathing room each side. Matches
// the spacing the pill originally shipped with for 2 icons (70px/icon) —
// the pill's total width simply scales with tab count now instead of being
// a hand-tuned constant that silently stopped fitting when a 3rd tab (or a
// 4th, later) was added.
const ITEM_WIDTH = ICON_WRAP_SIZE + 26;
const MIN_SIDE_MARGIN = 16;

export default function TabsLayout() {
  const { t } = useI18n();

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}>
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
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ focused, color }) => (
            <TabSymbolIcon focused={focused} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

// Renders the whole pill: chrome background + one equally-sized Pressable
// per route. Mirrors the tabPress event contract the default bottom-tab bar
// uses, so `<Link>`/programmatic navigation and the (unused here) label/href
// behavior of screens stay standard.
function FloatingTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { width: windowWidth } = useWindowDimensions();
  const barWidth = state.routes.length * ITEM_WIDTH;
  const sideMargin = Math.max((windowWidth - barWidth) / 2, MIN_SIDE_MARGIN);

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          left: sideMargin,
          right: sideMargin,
          bottom: insets.bottom + BAR_BOTTOM_MARGIN,
          height: BAR_HEIGHT,
          borderRadius: BAR_HEIGHT / 2,
        },
      ]}>
      <TabBarBackground />
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const focused = state.index === index;
          const color: ColorValue = focused ? '#ffffff' : 'rgba(255,255,255,0.55)';

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityState={focused ? { selected: true } : {}}
              accessibilityLabel={options.title}
              style={styles.item}>
              {options.tabBarIcon?.({ focused, color, size: ICON_SIZE })}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// isLiquidGlassAvailable() is false on Android, web, and pre-26 iOS (also
// Expo Go — GlassView is a real UIVisualEffectView, so it needs a compiled
// dev client) — GlassView itself already no-ops to a plain <View> there, but
// we still need real chrome those platforms actually render, so we branch
// explicitly to our own hand-built glass material rather than relying on
// GlassView's flat fallback.
function TabBarBackground() {
  if (isLiquidGlassAvailable()) {
    return <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme="dark" />;
  }
  return (
    <GlassSurface
      scheme="dark"
      radius={GlassRadii.pill}
      noShadow
      style={StyleSheet.absoluteFill}
    />
  );
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

// Settings has no bundled raster icon (unlike home/explore) — SF Symbol /
// Material Symbol via the shared Icon component instead of generating new
// @1x/@2x/@3x PNGs for one tab.
function TabSymbolIcon({ focused, color }: { focused: boolean; color: ColorValue }) {
  return (
    <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
      <Icon
        ios={focused ? 'gearshape.fill' : 'gearshape'}
        android="settings"
        size={ICON_SIZE - 2}
        color={color}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  row: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
