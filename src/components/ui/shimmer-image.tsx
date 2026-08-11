// Branded loading state for AI-generated race-art images (this app's take on
// the workspace-wide convention: any AI-generated content gets a
// brand-colored gradient shimmer while it materializes, then a quick
// fade-in reveal — never a bare spinner, never an instant pop-in). Here
// that's a soft accent-tinted pulse over the image's own footprint (so
// there's zero layout shift when the real image lands), handed off to
// expo-image's own crossfade transition once the bytes arrive. Region art is
// a bundled local asset (see region-art.ts) rather than a remote fetch, so in
// practice this decode is near-instant and the pulse rarely gets seen — kept
// anyway since it's still correct on a slow device and this component makes
// no assumption about where `source` comes from.
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

interface ShimmerImageProps {
  /** A bundled require() asset today (region art is local, not remote) — typed
   * broadly since expo-image's own `source` prop already accepts a remote
   * `{ uri }` too, so this component works unchanged if that ever changes. */
  source: ImageSourcePropType;
  accent: string;
  /** Base surface color underneath the shimmer/image — a themed neutral, not a hardcoded gray. */
  tint: string;
  style?: StyleProp<ViewStyle>;
  /** Passed straight through to expo-image's own loader-priority hint. Unset
   * (expo-image's default, effectively 'normal') for the compact grid images —
   * there can be a dozen of them mounted per screen and none of them is more
   * urgent than the rest. Hero cards pass 'high': there's at most one on
   * screen at a time and it's the single largest, most visually prominent
   * element in the feed, so it should win any contention for decode/network
   * priority against the grid images around it. */
  priority?: 'low' | 'normal' | 'high';
}

// expo-image's web renderer defaults the underlying <img>'s `loading` to
// 'lazy' whenever the `loading` prop isn't passed explicitly — regardless of
// `priority`. Confirmed live via PageSpeed Insights (2026-08-11): the hero
// card's image shipped BOTH `fetchpriority="high"` and `loading="lazy"`,
// which directly contradict each other and flagged as a failing LCP audit
// ("LCP resources should not use loading=lazy"). A 'high'-priority image is
// by definition the one image on screen we want the browser to fetch eagerly
// — 'low'/'normal'/unset keep the default lazy behavior, which is still
// correct for the dozen unprioritized grid images per screen.
function resolveLoading(priority: ShimmerImageProps['priority']) {
  return priority === 'high' ? 'eager' : undefined;
}

const REVEAL_MS = 250; // expo-image's own crossfade on load — mid the requested 200-300ms band

export function ShimmerImage({ source, accent, tint, style, priority }: ShimmerImageProps) {
  const reduced = useReducedMotion();
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      // Infinite motion is exactly what reduced-motion opts out of — hold a
      // static mid-tint instead of looping.
      pulse.value = 0.5;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 700, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 700, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
  }, [reduced, pulse]);

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: 0.1 + pulse.value * 0.22,
  }));

  return (
    <View style={[styles.container, { backgroundColor: tint }, style]}>
      {status !== 'loaded' && status !== 'error' && (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: accent }, shimmerStyle]}
        />
      )}
      {status !== 'error' && (
        <Image
          source={source}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={REVEAL_MS}
          cachePolicy="memory-disk"
          priority={priority}
          loading={resolveLoading(priority)}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
          // Decorative — the card's own Pressable already carries the full
          // accessibility label (name, date, city, status).
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
