// Explicit Light/Dark/System override for the whole app. Every screen
// already keys its colors off `useColorScheme()` (see constants/theme.ts's
// `Colors.light`/`Colors.dark`), which normally just mirrors the OS setting
// — `Appearance.setColorScheme()` is the one call that overrides what that
// hook returns app-wide, so this file has nothing to do beyond persisting
// the user's choice and calling it; no theme context/wrapper needed on every
// screen.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance } from 'react-native';
import { getPref, initDb, setPref } from '@/lib/db';

export type ThemeMode = 'system' | 'light' | 'dark';

const PREF_THEME_MODE = 'themeMode';

function applyMode(mode: ThemeMode): void {
  // 'unspecified' is RN's actual reset value here, not `null` — passing it
  // makes setColorScheme re-read and report the real OS scheme (see
  // react-native/Libraries/Utilities/Appearance.js), so `useColorScheme()`
  // goes back to following the device again.
  Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
}

interface ThemeModeValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeValue | null>(null);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');

  // Rehydrate a previously persisted choice on mount, same pattern as
  // LocaleProvider in i18n.tsx — initDb() is idempotent so this has no
  // dependency on provider ordering elsewhere in the tree.
  useEffect(() => {
    try {
      initDb();
    } catch {
      // Ignore — getPref below degrades to null when the db isn't open.
    }
    try {
      const stored = getPref(PREF_THEME_MODE);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        applyMode(stored);
        setModeState(stored);
      }
    } catch {
      // Storage failure — keep following the OS (the 'system' default).
    }
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    applyMode(m);
    setModeState(m);
    try {
      setPref(PREF_THEME_MODE, m);
    } catch {
      // A storage failure must never crash the theme toggle.
    }
  }, []);

  const value = useMemo<ThemeModeValue>(() => ({ mode, setMode }), [mode, setMode]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used within a ThemeModeProvider');
  return ctx;
}
