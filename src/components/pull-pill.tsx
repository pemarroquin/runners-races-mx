// The place pill that is also the pull-to-refresh handle (Local Leaders).
//
// On a full-bleed map every drag belongs to the map, so the usual "pull the
// list down" has nowhere to live — and react-native-web's RefreshControl
// renders nothing at all, so on the live web app it would not exist either.
// Pull-to-refresh starts at the TOP of the screen, and the one thing up
// there that isn't map is this pill. Drag it down: it pulls away on a
// tether, the chevron flips when letting go would refresh, and it springs
// back with a spinner while the board reloads.
//
// RN core responder props + Animated, not gesture-handler: the responder
// system runs on both platforms (mouse and touch on web), and this is one
// component with one gesture.
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type ViewStyle,
} from 'react-native';

import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { Spacing } from '@/constants/theme';
import { PULL_THRESHOLD, isPullGesture, pullDistance, shouldRefresh } from '@/lib/pull-refresh';

export const PULL_PILL_H = 36;

// The browser must not scroll, zoom or pull-to-reload the page while the
// pill is being dragged; react-native-web passes touchAction through as CSS.
const NO_BROWSER_GESTURES = { touchAction: 'none' } as unknown as ViewStyle;

export function PullPill({
  top,
  label,
  releaseLabel,
  refreshingLabel,
  a11yHint,
  refreshing,
  onRefresh,
}: {
  top: number;
  label: string;
  releaseLabel: string;
  refreshingLabel: string;
  a11yHint: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  // Lazily-initialised state, not a ref read during render (the React
  // Compiler rejects `.current` in render).
  const [stretch] = useState(() => new Animated.Value(0));
  // Only flips when the pull crosses the threshold, never per frame — the
  // stretch itself runs on the Animated value, not state.
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const refreshingRef = useRef(refreshing);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    refreshingRef.current = refreshing;
    onRefreshRef.current = onRefresh;
  }, [refreshing, onRefresh]);

  // Where the touch started. Plain responder props rather than a
  // PanResponder: these are ordinary event handlers, so reading refs in them
  // is fine, where PanResponder.create runs during render.
  const startRef = useRef({ x: 0, y: 0 });
  const settle = () => {
    armedRef.current = false;
    setArmed(false);
    Animated.spring(stretch, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
  };
  const travel = (e: GestureResponderEvent) => ({
    dx: e.nativeEvent.pageX - startRef.current.x,
    dy: e.nativeEvent.pageY - startRef.current.y,
  });
  const claims = (e: GestureResponderEvent) => {
    if (refreshingRef.current) return false;
    const { dx, dy } = travel(e);
    return isPullGesture(dx, dy);
  };

  // The chevron turns as the pull approaches the threshold, pointing up once
  // letting go would refresh — the classic arrow flip, driven by the stretch.
  const rotate = stretch.interpolate({
    inputRange: [0, PULL_THRESHOLD * 0.6, PULL_THRESHOLD],
    outputRange: ['0deg', '0deg', '180deg'],
    extrapolate: 'clamp',
  });
  const tetherOpacity = stretch.interpolate({
    inputRange: [0, 12, PULL_THRESHOLD],
    outputRange: [0, 0.35, 0.7],
    extrapolate: 'clamp',
  });

  const text = refreshing ? refreshingLabel : armed ? releaseLabel : label;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top }]}>
      <Animated.View style={[styles.tether, { height: stretch, opacity: tetherOpacity }]} />
      <View
        onStartShouldSetResponder={(e) => {
          startRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
          return false;
        }}
        onMoveShouldSetResponder={claims}
        onMoveShouldSetResponderCapture={claims}
        onResponderTerminationRequest={() => false}
        onResponderMove={(e) => {
          const d = pullDistance(travel(e).dy);
          stretch.setValue(d);
          const nowArmed = shouldRefresh(d);
          if (nowArmed !== armedRef.current) {
            armedRef.current = nowArmed;
            setArmed(nowArmed);
          }
        }}
        onResponderRelease={(e) => {
          if (shouldRefresh(pullDistance(travel(e).dy))) onRefreshRef.current();
          settle();
        }}
        onResponderTerminate={settle}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={a11yHint}
        // Screen readers can't drag; a double-tap refreshes instead.
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={() => {
          if (!refreshing) onRefresh();
        }}
        style={NO_BROWSER_GESTURES}>
        <GlassSurface scheme="dark" radius={GlassRadii.pill} contentStyle={styles.pill}>
          <Text style={styles.text} numberOfLines={1}>
            {text}
          </Text>
          <View style={styles.glyph}>
            {refreshing ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Animated.View style={{ transform: [{ rotate }] }}>
                <Icon ios="chevron.down" android="expand_more" size={14} color="rgba(255,255,255,0.7)" />
              </Animated.View>
            )}
          </View>
        </GlassSurface>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  tether: { width: 2, borderRadius: 1, backgroundColor: '#ffffff' },
  pill: {
    height: PULL_PILL_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two + 2,
    maxWidth: 280,
  },
  text: { flexShrink: 1, color: '#ffffff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },
  glyph: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
});
