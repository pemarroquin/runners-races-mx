// Blue "+N" lap marker — same teardrop silhouette as ConquestMarker, blue,
// N = laps of the same ground (laps.ts's detectLaps, shown only once the run
// qualifies). Rendered live on the Track map AND on the session summary. See
// lib/conquest-marker.ts for the shared geometry and LAP_MARKER palette, and
// lib/lap-marker-web.ts for the web twin of the animation below.
//
// The animation: the bubble drops onto its point and squashes on landing,
// a ring bursts out of the body, and every new lap bumps it. Everything
// pivots on the TIP, so the coordinate it marks never moves while it plays.
//
// react-native-maps only redraws a custom marker view while the Marker's
// `tracksViewChanges` is true (Android snapshots it to a bitmap), so the
// parent must hold that on while this plays — `useLapMarkerTracking` below.
// JS driver, not native: a snapshot of a natively-driven view can miss the
// animated frames on Android.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, FeGaussianBlur, Filter, G, LinearGradient, Path, Stop } from 'react-native-svg';

import { LAP_MARKER, lapMarkerGeometry } from '@/lib/conquest-marker';

const FILL_ID = 'lapMarkerFill';
const SHADOW_ID = 'lapMarkerShadow';
/** How long a marker keeps redrawing after it appears or its count changes —
 *  the drop + burst, with margin. */
const LAP_MARKER_ANIM_MS = 1000;

/** True while the marker for `laps` is still animating — pass it straight
 *  to `<Marker tracksViewChanges>`. Settles to false on its own; a new
 *  count turns it back on. Derived (settled key vs current key) rather than
 *  set from the effect body, which the React Compiler lint flags. */
export function useLapMarkerTracking(laps: number | null): boolean {
  const [settled, setSettled] = useState<number | null>(null);
  useEffect(() => {
    // Marker gone: forget the settled count, so the NEXT session's "+2" (a
    // freshly mounted view that needs its first frames drawn) tracks again.
    const id =
      laps === null
        ? setTimeout(() => setSettled(null), 0)
        : setTimeout(() => setSettled(laps), LAP_MARKER_ANIM_MS);
    return () => clearTimeout(id);
  }, [laps]);
  return laps !== null && settled !== laps;
}

export function LapMarker({ laps }: { laps: number }) {
  const g = lapMarkerGeometry(laps);
  // useState, not useRef: reading ref.current during render is flagged by
  // the react-hooks lint, and these values never need replacing.
  const [scale] = useState(() => new Animated.Value(0));
  const [drop] = useState(() => new Animated.Value(-18));
  const [burst] = useState(() => new Animated.Value(1));
  const prevLaps = useRef<number | null>(null);

  useEffect(() => {
    const prev = prevLaps.current;
    prevLaps.current = laps;
    if (prev !== null && laps <= prev) return;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (cancelled) return;
        if (reduce) {
          scale.setValue(1);
          drop.setValue(0);
          burst.setValue(1);
          return;
        }
        burst.setValue(0);
        const burstAnim = Animated.timing(burst, {
          toValue: 1,
          duration: 760,
          delay: 140,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        });
        if (prev === null) {
          // First appearance: drop in and land.
          scale.setValue(0.2);
          drop.setValue(-18);
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, friction: 4, tension: 140, useNativeDriver: false }),
            Animated.timing(drop, {
              toValue: 0,
              duration: 280,
              easing: Easing.out(Easing.quad),
              useNativeDriver: false,
            }),
            burstAnim,
          ]).start();
        } else {
          // A new lap: bump.
          Animated.parallel([
            Animated.sequence([
              Animated.timing(scale, { toValue: 1.24, duration: 150, useNativeDriver: false }),
              Animated.spring(scale, { toValue: 1, friction: 4, tension: 160, useNativeDriver: false }),
            ]),
            burstAnim,
          ]).start();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [laps, scale, drop, burst]);

  const burstScale = burst.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.8] });
  // 1.8, not web's 2.3: a native marker view is clipped to its own box (the
  // Android snapshot is exactly that bitmap), and 1.8x the body still fits
  // inside the shadow bleed.
  const burstOpacity = burst.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });

  return (
    <View style={{ width: g.boxWidth, height: g.boxHeight }}>
      <View
        pointerEvents="none"
        style={[
          styles.burst,
          {
            left: g.bleed + g.centerX - g.radius,
            top: g.bleed + g.centerY - g.radius,
            width: g.diameter,
            height: g.diameter,
            borderRadius: g.radius,
          },
        ]}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.burstRing,
            { borderRadius: g.radius, opacity: burstOpacity, transform: [{ scale: burstScale }] },
          ]}
        />
      </View>
      <Animated.View
        style={{
          width: g.boxWidth,
          height: g.boxHeight,
          // Pivot on the tip, so the marked coordinate holds still.
          transformOrigin: [g.boxWidth / 2, g.tipFromTop, 0],
          transform: [{ translateY: drop }, { scale }],
        }}>
        <Svg width={g.boxWidth} height={g.boxHeight} viewBox={g.viewBox}>
          <Defs>
            <LinearGradient id={FILL_ID} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={LAP_MARKER.fillTop} />
              <Stop offset="1" stopColor={LAP_MARKER.fillBottom} />
            </LinearGradient>
            <Filter id={SHADOW_ID} x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation={LAP_MARKER.shadowBlurStdDeviation} />
            </Filter>
          </Defs>
          <G filter={`url(#${SHADOW_ID})`} opacity={LAP_MARKER.shadowOpacity}>
            <Path d={g.shadowPath} fill={LAP_MARKER.shadowColor} />
          </G>
          <Path
            d={g.path}
            fill={`url(#${FILL_ID})`}
            stroke={LAP_MARKER.ring}
            strokeWidth={LAP_MARKER.stroke}
            strokeLinejoin="round"
          />
        </Svg>
        <View
          pointerEvents="none"
          style={[styles.label, { top: g.bleed, width: g.boxWidth, height: g.centerY * 2 }]}>
          <Text style={styles.text}>+{laps}</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  burst: {
    position: 'absolute',
  },
  burstRing: {
    borderWidth: 3,
    borderColor: LAP_MARKER.ring,
  },
  label: {
    position: 'absolute',
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#fff',
    fontWeight: '700',
    fontSize: LAP_MARKER.fontSize,
    lineHeight: LAP_MARKER.lineHeight,
    fontVariant: ['tabular-nums'],
  },
});
