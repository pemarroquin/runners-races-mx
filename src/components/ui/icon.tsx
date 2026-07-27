// Thin SymbolView wrapper — real SF Symbols on iOS (matching the iOS 27 kit's
// own iconography), Material Symbols on Android/web. Replaces the Unicode
// glyphs (✕ ↗ ◎ ♥ ♡ ✓ ▾) the app used as icon stand-ins.
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import type { ColorValue } from 'react-native';

interface IconProps {
  ios: SFSymbol;
  android: AndroidSymbol;
  size?: number;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  color: ColorValue;
}

export function Icon({ ios, android, size = 17, weight = 'semibold', color }: IconProps) {
  return (
    <SymbolView
      name={{ ios, android, web: android }}
      size={size}
      weight={weight}
      tintColor={color}
    />
  );
}
