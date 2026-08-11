// Branded loading state for AI-generated race-art images (this app's take on
// the workspace-wide convention: any AI-generated content gets a
// brand-colored gradient shimmer while it materializes, then a quick
// fade-in reveal — never a bare spinner, never an instant pop-in). Here
// that's a soft accent-tinted pulse over the image's own footprint (so
// there's zero layout shift when the real image lands), handed off to
// expo-image's own crossfade transition once the bytes arrive.
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
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
  uri: string;
  accent: string;
  /** Base surface color underneath the shimmer/image — a themed neutral, not a hardcoded gray. */
  tint: string;
  style?: StyleProp<ViewStyle>;
}

const REVEAL_MS = 250; // expo-image's own crossfade on load — mid the requested 200-300ms band

export function ShimmerImage({ uri, accent, tint, style }: ShimmerImageProps) {
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
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={REVEAL_MS}
          cachePolicy="memory-disk"
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
