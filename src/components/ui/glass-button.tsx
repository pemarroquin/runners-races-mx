// Pill/circular glass chrome for secondary actions (icon buttons, segmented
// toggles, chips) — GlassSurface + the app's existing tactile press feedback
// (instant scale/opacity, no animation lib — see race-card.tsx).
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { GlassRadii, type GlassScheme } from '@/constants/glass';

import { GlassSurface } from './glass-surface';

interface GlassButtonProps {
  scheme: GlassScheme;
  onPress: () => void;
  size?: number;
  radius?: number;
  disabled?: boolean;
  hitSlop?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function GlassButton({
  scheme,
  onPress,
  size,
  radius = GlassRadii.button,
  disabled,
  hitSlop = 6,
  accessibilityLabel,
  style,
  children,
}: GlassButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityLabel={accessibilityLabel}>
      {({ pressed }) => (
        <GlassSurface
          scheme={scheme}
          radius={radius}
          style={[size !== undefined && { width: size, height: size }, pressed && styles.pressed, disabled && styles.disabled, style]}
          contentStyle={styles.content}>
          {children}
        </GlassSurface>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.96 }] },
  disabled: { opacity: 0.4 },
});
