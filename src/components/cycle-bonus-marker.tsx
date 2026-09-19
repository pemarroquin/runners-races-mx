// Blue "Xpt" cycle-bonus marker — same teardrop silhouette as ConquestMarker
// but blue, shown when a run's path significantly re-covers the runner's own
// existing territory (10 pts per qualifying run). See lib/conquest-marker.ts
// for the shared geometry rationale and CYCLE_MARKER palette.
import Svg, { Defs, FeGaussianBlur, Filter, G, LinearGradient, Path, Stop } from 'react-native-svg';
import { StyleSheet, Text, View } from 'react-native';

import { CYCLE_MARKER, cycleBonusMarkerGeometry } from '@/lib/conquest-marker';

const FILL_ID = 'cycleBonusMarkerFill';
const SHADOW_ID = 'cycleBonusMarkerShadow';

export function CycleBonusMarker({ pts }: { pts: number }) {
  const g = cycleBonusMarkerGeometry(pts);
  return (
    <View style={{ width: g.boxWidth, height: g.boxHeight }}>
      <Svg width={g.boxWidth} height={g.boxHeight} viewBox={g.viewBox}>
        <Defs>
          <LinearGradient id={FILL_ID} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={CYCLE_MARKER.fillTop} />
            <Stop offset="1" stopColor={CYCLE_MARKER.fillBottom} />
          </LinearGradient>
          <Filter id={SHADOW_ID} x="-50%" y="-50%" width="200%" height="200%">
            <FeGaussianBlur stdDeviation={CYCLE_MARKER.shadowBlurStdDeviation} />
          </Filter>
        </Defs>
        <G filter={`url(#${SHADOW_ID})`} opacity={CYCLE_MARKER.shadowOpacity}>
          <Path d={g.shadowPath} fill={CYCLE_MARKER.shadowColor} />
        </G>
        <Path
          d={g.path}
          fill={`url(#${FILL_ID})`}
          stroke={CYCLE_MARKER.ring}
          strokeWidth={CYCLE_MARKER.stroke}
          strokeLinejoin="round"
        />
      </Svg>
      <View
        pointerEvents="none"
        style={[styles.label, { top: g.bleed, width: g.boxWidth, height: g.centerY * 2 }]}>
        <Text style={styles.text}>{pts}pt</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    position: 'absolute',
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#fff',
    fontWeight: '700',
    fontSize: CYCLE_MARKER.fontSize,
    lineHeight: CYCLE_MARKER.lineHeight,
    fontVariant: ['tabular-nums'],
  },
});
