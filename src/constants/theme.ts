/**
 * The app's colors, fonts and spacing scale, in light and dark.
 *
 * `light` and `dark` carry the same keys deliberately — `ThemeColor` is their
 * intersection, so adding a color to one and not the other makes it
 * unaddressable rather than undefined at runtime.
 */

// Side-effect import: global.css defines the CSS custom properties the web
// font stack below (`var(--font-display)` etc.) resolves against, so it has
// to be loaded wherever Fonts is.
import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
    accent: '#E4572E',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
    accent: '#E4572E',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

// Clears the floating pill tab bar (see (tabs)/_layout.tsx) + its bottom
// margin + a bit of breathing room, for scrollable screens' bottom padding.
// Safe-area bottom inset is handled separately by the bar's own positioning
// and by each screen's SafeAreaView, so this stays a flat number rather than
// per-platform.
export const BottomTabInset = 96;
