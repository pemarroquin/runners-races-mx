// The iOS 27 Liquid Glass material as a reusable RN primitive: real
// backdrop blur (expo-blur) + a translucent tint + the specular-edge
// boxShadow recipe from constants/glass.ts. The ambient (outer) shadow has
// to live on a non-clipped wrapper — overflow:hidden on the blurred/tinted
// layer would cut it off — so this renders two nested views, not one.
import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassMaterial, GlassRadii, type GlassScheme } from '@/constants/glass';

interface GlassSurfaceProps {
  scheme: GlassScheme;
  radius?: number;
  /** Skip the ambient drop shadow — for chrome already sitting inside a clipped/shadowed parent. */
  noShadow?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function GlassSurface({
  scheme,
  radius = GlassRadii.button,
  noShadow,
  style,
  contentStyle,
  children,
}: GlassSurfaceProps) {
  const material = GlassMaterial[scheme];
  return (
    // The blur/tint layer is absolute-fill, so it can't size the box itself —
    // the outer View's size comes from `style` (explicit dims, e.g. a fixed
    // icon-button size) or from the foreground content sibling below.
    <View
      style={[
        { borderRadius: radius },
        !noShadow && { boxShadow: material.ambientShadow },
        style,
      ]}>
      <View style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: radius }]}>
        <BlurView intensity={material.blur} tint={scheme} style={StyleSheet.absoluteFill} />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: material.background,
              borderWidth: material.borderWidth,
              borderColor: material.borderColor,
              borderRadius: radius,
              boxShadow: material.insetShadow,
            },
          ]}
        />
      </View>
      {children !== undefined && <View style={contentStyle}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
