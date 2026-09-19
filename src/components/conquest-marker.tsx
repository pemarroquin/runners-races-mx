// The "+N" conquest marker, native side. Web draws the same silhouette from
// the same geometry (lib/conquest-marker.ts → conquestMarkerHtml), called
// from fence-map.web.tsx. Every value traces to the Figma master.
//
// Why SVG rather than the Views this used to be: the body and tail are one
// path so they take one stroke and one fill — see lib/conquest-marker.ts for
// the full reasoning. A View can't draw a shape whose outline crosses from
// an arc into two straight lines.
//
// The shadow is drawn INSIDE the svg. Two reasons it can't sit on the
// wrapping View: react-native-maps snapshots a custom marker into a bitmap,
// which drops a layer shadow that falls outside the view's bounds, and
// Android's `elevation` draws from the view's rectangular outline — a box
// behind a teardrop. It is built from feGaussianBlur alone because that is
// the only filter primitive react-native-svg 15 implements natively on BOTH
// platforms (there is no native FeDropShadow on either).
//
// The count is a real <Text> on top rather than an SVG <Text>: it keeps the
// app's font and `tabular-nums`, which react-native-svg's text does not
// expose.

import Svg, { Defs, FeGaussianBlur, Filter, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { StyleSheet, Text, View } from 'react-native';

import { CONQUEST_MARKER, conquestMarkerGeometry } from '@/lib/conquest-marker';

const FILL_ID = 'conquestMarkerFill';
const SHADOW_ID = 'conquestMarkerShadow';

export function ConquestMarker({ count }: { count: number }) {
  const g = conquestMarkerGeometry(count);
  return (
    <View style={{ width: g.boxWidth, height: g.boxHeight }}>
      <Svg width={g.boxWidth} height={g.boxHeight} viewBox={g.viewBox}>
        <Defs>
          <LinearGradient id={FILL_ID} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={CONQUEST_MARKER.fillTop} />
            <Stop offset="1" stopColor={CONQUEST_MARKER.fillBottom} />
          </LinearGradient>
          <Filter id={SHADOW_ID} x="-50%" y="-50%" width="200%" height="200%">
            <FeGaussianBlur stdDeviation={CONQUEST_MARKER.shadowBlurStdDeviation} />
          </Filter>
        </Defs>
        <G filter={`url(#${SHADOW_ID})`} opacity={CONQUEST_MARKER.shadowOpacity}>
          <Path d={g.shadowPath} fill={CONQUEST_MARKER.shadowColor} />
        </G>
        <Path
          d={g.path}
          fill={`url(#${FILL_ID})`}
          stroke={CONQUEST_MARKER.ring}
          strokeWidth={CONQUEST_MARKER.stroke}
          strokeLinejoin="round"
        />
      </Svg>
      {/* Centred on the body circle, not on the drawing surface. */}
      <View
        pointerEvents="none"
        style={[
          styles.countWrap,
          { top: g.bleed, width: g.boxWidth, height: g.centerY * 2 },
        ]}>
        <Text style={styles.count}>+{count}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  countWrap: {
    position: 'absolute',
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: {
    color: '#fff',
    fontWeight: '700',
    fontSize: CONQUEST_MARKER.fontSize,
    lineHeight: CONQUEST_MARKER.lineHeight,
    fontVariant: ['tabular-nums'],
  },
});
