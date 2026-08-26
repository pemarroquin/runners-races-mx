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
import { getPref, initDb, setPref } from '@/lib/db';

const EXIT_AT = 1100; // ms after mount when the overlay starts leaving
const PREF_SPLASH_SEEN = 'splashSeen';

/** True once the full sequence has played on this device. Never throws. */
function hasSeenSplash(): boolean {
  try {
    initDb(); // idempotent — no dependency on provider ordering
    return getPref(PREF_SPLASH_SEEN) === '1';
  } catch {
    // Storage unavailable: fall back to showing it. A repeated splash is a
    // far better failure than never showing the app's one branded moment.
    return false;
  }
}

function markSplashSeen(): void {
  try {
    initDb();
    setPref(PREF_SPLASH_SEEN, '1');
  } catch {
    // Non-fatal — worst case the splash plays again next launch.
  }
}

export function CinematicSplash() {
  // Whether the full ~1.5s sequence has already played on this device. Read
  // synchronously in a lazy initializer (not an effect) so the first render
  // already knows — an effect would flash the overlay before hiding it.
  //
  // The sequence is worth its 1.5s the first time and friction every time
  // after: this is a utility app people open to check a date, and the web
  // build already skips the hold entirely for the same reason (PR #20). A
  // returning user gets a plain hand-off from the native splash instead.
  const [alreadySeen] = useState(hasSeenSplash);
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

    if (alreadySeen) {
      // Nothing to animate — `alreadySeen` alone already suppresses the
      // overlay in render, so there is no setDone here (which would be a
      // synchronous setState in an effect for no behavioural gain). Still
      // re-mark it, harmlessly, in case the first run's write failed.
      markSplashSeen();
      return;
    }
    markSplashSeen();

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

  if (done || alreadySeen) return null;

  return (
    <Animated.View style={[styles.overlay, overlayStyle]} pointerEvents="none">
      <Animated.View style={titleStyle}>
        <Text style={styles.title}>Runners&apos; Races MX</Text>
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
