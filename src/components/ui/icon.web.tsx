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
  // Added for the Track tab's camera-mode cycle button (track-map.web.tsx) —
  // the icon it shows while in follow mode, offering a switch to overview.
  // A folded map: outer zigzag panel plus two fold-crease lines.
  map: (c) => (
    <>
      <path
        d="M4 6.5l5-2 6 2 5-2v13l-5 2-6-2-5 2V6.5z"
        stroke={c}
        strokeWidth={1.8}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M9 4.5v13M15 6.5v13" stroke={c} strokeWidth={1.4} strokeLinecap="round" />
    </>
  ),
  add: (c) => <path d="M12 5v14M5 12h14" stroke={c} strokeWidth={2} strokeLinecap="round" />,
  remove: (c) => <path d="M5 12h14" stroke={c} strokeWidth={2} strokeLinecap="round" />,
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
  sprint: (c) => (
    <>
      <circle cx="15" cy="4.6" r="2.1" fill={c} />
      <path
        d="M9.6 21.4l2.3-5.3-2.5-2.3c-.7-.7-.9-1.7-.5-2.5l1.8-3.6c.4-.9 1.4-1.3 2.3-1l3 .8c.5.1 1 .5 1.2 1l1 2.2 2 .7-.6 1.9-2.7-.9c-.5-.2-.9-.5-1.1-1l-.4-.9-1.2 2.8 2.3 2.2c.5.4.6 1.1.4 1.7l-1.4 4.3-2-.6 1.2-3.7-3.1-2.9-1.8 4.2-2-.9z"
        fill={c}
      />
      <path d="M2.4 9.6h3.8M1.4 13.1h3.4M3 16.6h2.9" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
    </>
  ),
  // Added 2026-08-27 for Territory Mode's flag/loss markers. Both were used
  // on native for a full session before anyone noticed they drew nothing on
  // web — the third time this exact trap has been hit. Add the glyph in the
  // SAME change as the call site.
  location_on: (c) => (
    <>
      <path
        d="M12 21.2s6.6-6.1 6.6-11a6.6 6.6 0 1 0-13.2 0c0 4.9 6.6 11 6.6 11z"
        stroke={c}
        strokeWidth={1.8}
        fill="none"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10.1" r="2.4" stroke={c} strokeWidth={1.8} fill="none" />
    </>
  ),
  warning: (c) => (
    <>
      <path
        d="M12 3.8 2.9 19.4h18.2L12 3.8z"
        stroke={c}
        strokeWidth={1.8}
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M12 9.6v4.2" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
      <circle cx="12" cy="16.6" r="1.05" fill={c} />
    </>
  ),
  flag: (c) => (
    <>
      <path d="M5.6 21V3.6" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
      <path
        d="M5.6 4.4h11.2l-2 3.6 2 3.6H5.6z"
        stroke={c}
        strokeWidth={1.8}
        fill="none"
        strokeLinejoin="round"
      />
    </>
  ),
  trophy: (c) => (
    <>
      <path d="M8 3.5h8v4.8a4 4 0 0 1-8 0V3.5z" stroke={c} strokeWidth={1.8} fill="none" strokeLinejoin="round" />
      <path
        d="M8 5.2H5.4a2.6 2.6 0 0 0 2.6 2.6M16 5.2h2.6A2.6 2.6 0 0 1 16 7.8"
        stroke={c}
        strokeWidth={1.7}
        fill="none"
        strokeLinecap="round"
      />
      <path d="M12 12.3v3.4M9 20.2h6M10.2 20.2l.5-4.5M13.8 20.2l-.5-4.5" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  emoji_events: (c) => (
    <>
      <path d="M8 3h8v5.3a4 4 0 0 1-8 0V3z" fill={c} />
      <path
        d="M8 5.2H5.4a2.6 2.6 0 0 0 2.6 2.6M16 5.2h2.6A2.6 2.6 0 0 1 16 7.8"
        stroke={c}
        strokeWidth={1.7}
        fill="none"
        strokeLinecap="round"
      />
      <path d="M12 12.3v3.4" stroke={c} strokeWidth={1.9} strokeLinecap="round" />
      <path d="M9.2 20.4l.7-4.4h4.2l.7 4.4z" fill={c} />
    </>
  ),
  person: (c) => (
    <>
      <circle cx="12" cy="8" r="3.7" fill={c} />
      <path d="M4.6 20.2c0-4 3.3-6.3 7.4-6.3s7.4 2.3 7.4 6.3z" fill={c} />
    </>
  ),
  pause: (c) => (
    <>
      <rect x="6.5" y="4.5" width="3.8" height="15" rx="1.2" fill={c} />
      <rect x="13.7" y="4.5" width="3.8" height="15" rx="1.2" fill={c} />
    </>
  ),
  play_arrow: (c) => <path d="M7.5 4.8v14.4a1 1 0 0 0 1.53.85l11.2-7.2a1 1 0 0 0 0-1.7L9.03 3.95A1 1 0 0 0 7.5 4.8z" fill={c} />,
  stop: (c) => <rect x="5.5" y="5.5" width="13" height="13" rx="2" fill={c} />,
  account_circle: (c) => (
    <>
      <circle cx="12" cy="12" r="9" stroke={c} strokeWidth={1.8} fill="none" />
      <circle cx="12" cy="9.8" r="3" stroke={c} strokeWidth={1.7} fill="none" />
      <path
        d="M6.3 18.8c1.2-2.2 3.3-3.4 5.7-3.4s4.5 1.2 5.7 3.4"
        stroke={c}
        strokeWidth={1.7}
        fill="none"
        strokeLinecap="round"
      />
    </>
  ),
};

export function Icon({ android, size = 17, color }: IconProps) {
  const c = String(color);
  const glyph = GLYPHS[android];
  if (!glyph) {
    // This registry only covers the handful of names the app actually uses,
    // while the `android` prop is typed against all ~4000 Material Symbols —
    // so a valid symbol name typechecks fine and then renders NOTHING here.
    // That shipped once: the Track and Leaderboard tabs were blank on web
    // while iOS was fine, and tsc/lint/build were all green. Fail loudly in
    // development instead of drawing an invisible icon.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[Icon] no web glyph for "${android}". Add it to GLYPHS in components/ui/icon.web.tsx — the icon renders as nothing until you do.`,
      );
    }
    return null;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {glyph(c)}
    </svg>
  );
}
