// iOS 27 "Liquid Glass" material tokens — ported from Apple's UIVisualEffectView
// specs (via the iOS 27 Safari UI / iOS-and-iPadOS-27 Figma kits) into RN's
// CSS-syntax `boxShadow` style, natively supported since RN 0.78 on Fabric and
// 1:1 on web. This is the material's STRUCTURE (blur + specular edge + ambient
// lift), not a re-theme — colors stay this app's own neutrals/accent, never
// Apple's system blue.
export type GlassScheme = 'light' | 'dark';

interface GlassSpec {
  blur: number;
  background: string;
  borderColor: string;
  borderWidth: number;
  /** Outer drop shadow — must be applied OUTSIDE any overflow:hidden clip. */
  ambientShadow: string;
  /** Inset specular highlight — safe inside a clipped/bordered view. */
  insetShadow: string;
}

export const GlassMaterial: Record<GlassScheme, GlassSpec> = {
  // Chrome floating over light content: crisp bright top edge, faint
  // bottom-inner shade — light catching a rounded glass rim.
  light: {
    blur: 20,
    background: 'rgba(255,255,255,0.45)',
    borderColor: 'rgba(0,0,0,0.1)',
    borderWidth: 0.5,
    ambientShadow: '0px 2px 40px rgba(0,0,0,0.10)',
    insetShadow:
      'inset 0px 0.5px 0px rgba(0,0,0,0.1), inset 0px 1.5px 1px rgba(255,255,255,0.7)',
  },
  // Chrome floating over dark content: soft light falloff from the top,
  // deeper dark falloff at the bottom — same rim, inverted light source.
  dark: {
    blur: 20,
    background: 'rgba(28,28,30,0.7)',
    borderColor: 'rgba(255,255,255,0.14)',
    borderWidth: 0.5,
    ambientShadow: '0px 6px 24px rgba(0,0,0,0.28)',
    insetShadow:
      'inset 0px 20px 10px -18px rgba(255,255,255,0.12), inset 0px -20px 14px -18px rgba(0,0,0,0.5)',
  },
};

// Concentric-corner scale (Apple's iOS 26+ radii grew markedly vs. iOS <18):
// pills stay fully round, bars/sheets/cards all got noticeably rounder.
export const GlassRadii = {
  chip: 18,
  button: 22,
  bar: 28,
  sheet: 32,
  card: 28,
  pill: 999,
} as const;
