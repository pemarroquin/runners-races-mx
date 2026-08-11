// Web override for CinematicSplash (see splash.tsx for the native version).
//
// The native version deliberately holds a full-screen opaque overlay for a
// minimum ~1.1s before even starting its ~420ms exit fade (~1.5s total) —
// a native-app launch convention ("app launch is the rarest interaction,
// motion is fully welcome"). On web that convention doesn't apply: there is
// no OS-level splash hand-off to smooth over, and the page is already
// hidden behind a blank/loading state for however long the JS bundle takes
// to boot on the user's connection. Layering an artificial 1.5s hold on top
// of that measured, live via PageSpeed Insights (2026-08-11): LCP was
// ~10s against a JS-boot gap Lighthouse's own LCP subpart breakdown
// couldn't fully account for — this was a real, unaccounted contributor,
// not a rounding error.
//
// SplashScreen.hideAsync() is still called for parity/safety even though
// expo-splash-screen has no .web.* implementation (likely a no-op on web
// already) — cheap and avoids relying on that being true forever.
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

export function CinematicSplash() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return null;
}
