// Web-only icon implementation.
//
// icon.tsx's SymbolView (native) loads the *entire* Material Symbols font
// via expo-font/expo-symbols to render each glyph as ligature text — on web
// that meant downloading @expo-google-fonts/material-symbols in full
// (934 KiB, uncached, blocking) just to show the ~14 icons this app actually
// uses (PageSpeed's "Use efficient cache lifetimes" + "Font display"
// findings, 2026-08-11). Metro resolves *.web.tsx over the base file for web
// builds, so this file replaces icon.tsx there entirely and expo-symbols/
// expo-font never enter the web bundle — a few hundred bytes of inline SVG
// instead of a megabyte-scale font. Native (iOS/Android) is untouched.
import type { ReactNode } from 'react';
import type { ColorValue } from 'react-native';

interface IconProps {
  ios: string;
  android: string;
  size?: number;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  color: ColorValue;
}

type Glyph = (color: string) => ReactNode;

// Hand-drawn equivalents of the Material Symbols glyphs this app references
// by name (see icon.tsx call sites) — not the licensed font's own path data.
const GLYPHS: Record<string, Glyph> = {
  home_filled: (c) => <path d="M12 3L3 11h2v9h5v-6h4v6h5v-9h2L12 3z" fill={c} />,
  home: (c) => (
    <path
      d="M4 11.5L12 4l8 7.5M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9"
      stroke={c}
      strokeWidth={2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  favorite: (c) => (
    <path
      d="M12 21s-6.72-4.35-9.43-8.09C.5 10.02 1.2 6.5 4.2 5.1c2.2-1 4.6-.3 5.8 1.5L12 9l2-2.4c1.2-1.8 3.6-2.5 5.8-1.5 3 1.4 3.7 4.92 1.63 7.81C18.72 16.65 12 21 12 21z"
      fill={c}
    />
  ),
  favorite_border: (c) => (
    <path
      d="M12 21s-6.72-4.35-9.43-8.09C.5 10.02 1.2 6.5 4.2 5.1c2.2-1 4.6-.3 5.8 1.5L12 9l2-2.4c1.2-1.8 3.6-2.5 5.8-1.5 3 1.4 3.7 4.92 1.63 7.81C18.72 16.65 12 21 12 21z"
      stroke={c}
      strokeWidth={1.6}
      fill="none"
      strokeLinejoin="round"
    />
  ),
  settings: (c) => (
    <>
      <circle cx="12" cy="12" r="3" stroke={c} strokeWidth={2} fill="none" />
      <path
        d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8"
        stroke={c}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
  check: (c) => (
    <path d="M5 13l4 4L19 7" stroke={c} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  close: (c) => <path d="M6 6l12 12M18 6L6 18" stroke={c} strokeWidth={2} strokeLinecap="round" fill="none" />,
  expand_more: (c) => (
    <path d="M6 9l6 6 6-6" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  my_location: (c) => (
    <>
      <circle cx="12" cy="12" r="7" stroke={c} strokeWidth={1.6} fill="none" />
      <circle cx="12" cy="12" r="2.5" fill={c} />
      <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
    </>
  ),
  open_in_new: (c) => (
    <>
      <path
        d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"
        stroke={c}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14 4h6v6M20 4L11 13" stroke={c} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  directions_walk: (c) => (
    <>
      <circle cx="12.5" cy="5" r="2" fill={c} />
      <path
        d="M12.5 7v5.5M12.5 12.5l-3 5.5M12.5 12.5l3.5 4M9.5 10l3-1.2 3 2"
        stroke={c}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  ),
  directions_run: (c) => (
    <>
      <circle cx="14" cy="5" r="2" fill={c} />
      <path
        d="M13 7l-1.5 4 3 2-1 6M9 12.5l3.5-1.5 2 2 3-1M12.5 11l-4 2.5M17 16l3 1"
        stroke={c}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  ),
  military_tech: (c) => (
    <>
      <path d="M9 2h6l-1.6 6-1.4-1-1.4 1L9 2z" fill={c} />
      <circle cx="12" cy="14.5" r="6.5" stroke={c} strokeWidth={1.8} fill="none" />
      <circle cx="12" cy="14.5" r="3" fill={c} />
    </>
  ),
  terrain: (c) => <path d="M5 19L9.5 9l2.5 4.5 2-2.8L20 19H5z" fill={c} />,
};

export function Icon({ android, size = 17, color }: IconProps) {
  const c = String(color);
  const glyph = GLYPHS[android];
  if (!glyph) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {glyph(c)}
    </svg>
  );
}
