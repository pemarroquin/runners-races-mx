// Cinematic launch splash. App launch is the rarest "interaction" there is,
// so this is the one place expressive motion is fully welcome.
//
// Sequence (~1.5s total):
//   1. Native splash (black) hides → seamless hand-off to this black overlay.
//   2. Title materializes: fade 450ms + spring settle (translateY 16→0,
//      scale 0.94→1, dampingRatio 1 — no overshoot, deliberate weight).
//   3. Accent bar draws in from the left (scaleX, 350ms, ease-out).
//   4. Hold a beat, then the whole overlay exits with a gentle push-through
//      (opacity out + scale 1→1.04) — the app is already rendered beneath.
// Reduced motion: no movement, brief static title, quick fade.
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Colors } from '@/constants/theme';

const EXIT_AT = 1100; // ms after mount when the overlay starts leaving

export function CinematicSplash() {
  const [done, setDone] = useState(false);
  const reduced = useReducedMotion();

  const titleOpacity = useSharedValue(0);
  const titleY = useSharedValue(16);
  const titleScale = useSharedValue(0.94);
  const bar = useSharedValue(0);
  const overlayOpacity = useSharedValue(1);
  const overlayScale = useSharedValue(1);

  useEffect(() => {
    SplashScreen.hideAsync();

    if (reduced) {
      titleOpacity.value = 1;
      titleY.value = 0;
      titleScale.value = 1;
      bar.value = 1;
      overlayOpacity.value = withDelay(
        500,
        withTiming(0, { duration: 150 }, (f) => {
          if (f) runOnJS(setDone)(true);
        }),
      );
      return;
    }

    titleOpacity.value = withTiming(1, { duration: 450, easing: Easing.out(Easing.cubic) });
    titleY.value = withSpring(0, { duration: 700, dampingRatio: 1 });
    titleScale.value = withSpring(1, { duration: 700, dampingRatio: 1 });
    bar.value = withDelay(
      300,
      withTiming(1, { duration: 350, easing: Easing.out(Easing.cubic) }),
    );
    overlayScale.value = withDelay(
      EXIT_AT,
      withTiming(1.04, { duration: 420, easing: Easing.in(Easing.quad) }),
    );
    overlayOpacity.value = withDelay(
      EXIT_AT,
      withTiming(0, { duration: 420, easing: Easing.in(Easing.quad) }, (f) => {
        if (f) runOnJS(setDone)(true);
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
    transform: [{ scale: overlayScale.value }],
  }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: titleOpacity.value,
    transform: [{ translateY: titleY.value }, { scale: titleScale.value }],
  }));
  const barStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: bar.value }],
  }));

  if (done) return null;

  return (
    <Animated.View style={[styles.overlay, overlayStyle]} pointerEvents="none">
      <Animated.View style={titleStyle}>
        <Text style={styles.title}>Runners' Races MX</Text>
        <Animated.View
          style={[styles.bar, { backgroundColor: Colors.dark.accent }, barStyle]}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 0.3,
    textAlign: 'center',
    maxWidth: 280,
  },
  bar: {
    height: 4,
    borderRadius: 2,
    marginTop: 10,
    width: 64,
    transformOrigin: 'left',
  },
});
