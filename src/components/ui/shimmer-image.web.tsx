// Web override for ShimmerImage (see shimmer-image.tsx for the native
// version and the full rationale comment).
//
// The only thing this component actually animates is a decorative loading
// pulse — but on native that pulse pulled in react-native-reanimated's
// entire ~740 KiB worklet runtime (27% of the whole web bundle), for every
// screen that renders a single ShimmerImage, including the feed's own hero
// card, which is also the page's LCP element. Reanimated's worklet
// architecture needs its full runtime regardless of which specific hooks
// are called, so there's no lighter deep-import path the way
// react-native-gesture-handler had. The actual fix is this: the pulse is a
// pure opacity oscillation, which is exactly what CSS @keyframes already
// do natively, with zero JS runtime cost. See the `.shimmer-pulse` rule in
// global.css for the animation itself — this file only needs to apply the
// class name.
//
// A plain `<div>` for the pulse overlay (rather than RN's `View`) is
// deliberate: it needs a `className` for the CSS animation, and RN Web's
// `View` doesn't accept one — the whole point here is to route around
// React Native's style system, not fight it. Everything else (the
// image itself, its own crossfade transition, layout) stays on RN Web's
// normal `View`/`Image`, unchanged from the native version's structure.
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';

interface ShimmerImageProps {
  source: ImageSourcePropType;
  accent: string;
  tint: string;
  style?: StyleProp<ViewStyle>;
  priority?: 'low' | 'normal' | 'high';
}

const REVEAL_MS = 250;

export function ShimmerImage({ source, accent, tint, style, priority }: ShimmerImageProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  return (
    <View style={[styles.container, { backgroundColor: tint }, style]}>
      {status !== 'loaded' && status !== 'error' && (
        // Real <div>, not RN's View — see file header for why.
        <div
          className="shimmer-pulse"
          style={{ position: 'absolute', inset: 0, backgroundColor: accent, pointerEvents: 'none' }}
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
          loading={priority === 'high' ? 'eager' : undefined}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
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
