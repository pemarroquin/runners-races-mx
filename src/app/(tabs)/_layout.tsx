import { Tabs } from 'expo-router';
// expo-router's own `Tabs` export doesn't carry this type (it's deprecated
// in favor of `expo-router/js-tabs`, same underlying component) — pull the
// type from there without switching the runtime import used app-wide.
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View, useWindowDimensions, type ColorValue } from 'react-native';

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
// Labelled now, not icon-only: at five tabs the glyphs alone stopped being
// self-explanatory (a runner and a trophy read as almost anything). The icon
// circle shrank to make room for the label rather than the pill growing
// taller than a thumb's reach.
const BAR_HEIGHT = 64;
const BAR_BOTTOM_MARGIN = 16;
const ICON_SIZE = 21;
const ICON_WRAP_SIZE = 32;
const LABEL_SIZE = 10;
// Per-tab slot width: sized to the longest label rather than to the icon
// circle, since the label is now the wider element ("Leaderboard" is the
// widest string at ~60px). The pill's total width scales with tab count, so
// adding a tab never silently overflows.
const ITEM_WIDTH = 74;
// Breathing room inside the pill's rounded ends. Without it the first and
// last items' highlight circles sit flush against the curve and read as
// clipped — the row is a flex container, so the padding has to be counted
// into the pill's own width or it just squeezes the items instead.
const BAR_PADDING_H = 12;
const MIN_SIDE_MARGIN = 16;

export default function TabsLayout() {
  const { t } = useI18n();

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}>
      {/* Declaration order IS tab-bar order (expo-router doesn't sort by
          filename). Territory Mode leads the app now, so Track is the `index`
          route — an actual file rename, not just a reorder: `index` is what
          `/` resolves to, so making Track the landing screen on web too meant
          it had to BE the index file. The race feed moved to `races.tsx` and
          its web URL is now /races; nothing linked to `/` (shares point at
          /race/<id>), so no external link broke. */}
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.track'),
          tabBarIcon: ({ focused, color }) => (
            <TabGlyph focused={focused} color={color} ios="figure.run" iosInactive="figure.run" android="sprint" androidInactive="directions_run" />
          ),
        }}
      />
      <Tabs.Screen
        name="leaderboard"
        options={{
          title: t('tabs.leaderboard'),
          tabBarIcon: ({ focused, color }) => (
            <TabGlyph focused={focused} color={color} ios="trophy.fill" iosInactive="trophy" android="emoji_events" androidInactive="trophy" />
          ),
        }}
      />
      <Tabs.Screen
        name="races"
        options={{
          title: t('tabs.feed'),
          tabBarIcon: ({ focused, color }) => (
            <TabGlyph focused={focused} color={color} ios="house.fill" iosInactive="house" android="home_filled" androidInactive="home" />
          ),
        }}
      />
      <Tabs.Screen
        name="myraces"
        options={{
          title: t('tabs.myRaces'),
          // Heart, not a generic explore/compass glyph — this tab is
          // literally "the races you hearted" (see the save toggle on
          // race/[id].tsx, same icon pair), so the tab bar should say that.
          tabBarIcon: ({ focused, color }) => (
            <TabGlyph focused={focused} color={color} ios="heart.fill" iosInactive="heart" android="favorite" androidInactive="favorite_border" />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          // A person, not a gear: this tab is the account/profile surface now
          // (it carries the privacy statement and will carry the runner's own
          // territory), and a gear reads as "app preferences" only.
          tabBarIcon: ({ focused, color }) => (
            <TabGlyph focused={focused} color={color} ios="person.crop.circle.fill" iosInactive="person.crop.circle" android="person" androidInactive="account_circle" />
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
  const barWidth = state.routes.length * ITEM_WIDTH + BAR_PADDING_H * 2;
  const sideMargin = Math.max((windowWidth - barWidth) / 2, MIN_SIDE_MARGIN);

  // Settings is the one tab whose own content is a nested Stack (see
  // (tabs)/settings/_layout.tsx) — pushing a sub-page there never changes
  // which TOP-LEVEL tab is focused, so without this check the pill kept
  // floating over a sub-page's back button and content, reading as chrome
  // that belongs to a screen it isn't part of. React Navigation already
  // reports the focused tab's own nested navigator state on `route.state`
  // once it has mounted; a Stack's `index` is 0 on its initial route
  // (settings/index.tsx) and >0 once anything is pushed on top of it —
  // exactly "a sub-page is open". No new navigation machinery: this reads
  // state the tab bar is already handed every render.
  const focusedRoute = state.routes[state.index];
  const onSettingsSubpage =
    focusedRoute.name === 'settings' && (focusedRoute.state?.index ?? 0) > 0;
  if (onSettingsSubpage) return null;

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
              <Text
                numberOfLines={1}
                // The label is decoration for screen readers — the Pressable
                // already carries the same string as its accessibilityLabel,
                // so exposing it twice would make VoiceOver read it twice.
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={[styles.label, { color }]}>
                {options.title}
              </Text>
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

// Every tab renders through the same vector-symbol path (SF Symbols
// on iOS, Material Symbols on Android/web via expo-symbols) — home/myraces
// used to be tiny bundled PNGs (24-73px source) that read as pixelated next
// to the settings tab's crisp gearshape, since they never scale past their
// baked-in bitmap resolution. expo-symbols already ships ~4000 Material
// Symbols bundled (`node_modules/expo-symbols/build/android/symbols.json`)
// with solid sports/running coverage — figure.run, flag.checkered, trophy,
// directions_run, sprint, etc. — so there was no need to pull in a separate
// icon package for that; this app already had one.
function TabGlyph({
  focused,
  color,
  ios,
  iosInactive,
  android,
  androidInactive,
}: {
  focused: boolean;
  color: ColorValue;
  ios: SFSymbol;
  iosInactive: SFSymbol;
  android: AndroidSymbol;
  androidInactive: AndroidSymbol;
}) {
  return (
    <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
      <Icon
        ios={focused ? ios : iosInactive}
        android={focused ? android : androidInactive}
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
    paddingHorizontal: BAR_PADDING_H,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  label: {
    fontSize: LABEL_SIZE,
    fontWeight: '600',
    letterSpacing: 0.1,
    textAlign: 'center',
    paddingHorizontal: 2,
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
