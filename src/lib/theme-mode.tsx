// Explicit Light/Dark/System override for the whole app. Every screen
// already keys its colors off `useColorScheme()` (see constants/theme.ts's
// `Colors.light`/`Colors.dark`), which normally just mirrors the OS setting
// — `Appearance.setColorScheme()` is the one call that overrides what that
// hook returns app-wide, so this file has nothing to do beyond persisting
// the user's choice and calling it; no theme context/wrapper needed on every
// screen.
//
// That holds on iOS/Android, where `Appearance.setColorScheme` is a real
// native-backed function. It does NOT hold on web: react-native-web's
// `Appearance` shim (node_modules/react-native-web/src/exports/Appearance)
// only ever derives `getColorScheme()` from `matchMedia('(prefers-color-
// scheme: dark)')` and has no `setColorScheme` at all — the property is
// `undefined`, so calling it throws, and the override silently never
// happens. `patchWebAppearance` below gives that same shared `Appearance`
// object (react-native-web resolves 'react-native' to it, so every existing
// `useColorScheme()` call site in the app — including ones this file
// doesn't own — picks this up for free) a real `setColorScheme`, by
// layering an override on top of the OS query instead of replacing it.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, Platform } from 'react-native';
import { getPref, initDb, setPref } from '@/lib/db';

export type ThemeMode = 'system' | 'light' | 'dark';

const PREF_THEME_MODE = 'themeMode';

type ColorSchemeName = 'light' | 'dark' | null;
type ChangeListener = (prefs: { colorScheme: ColorSchemeName }) => void;
type PatchableAppearance = {
  getColorScheme: () => ColorSchemeName;
  addChangeListener: (listener: ChangeListener) => { remove: () => void };
  setColorScheme?: (scheme: 'light' | 'dark' | 'unspecified' | null) => void;
  __racesmxWebPatched?: boolean;
};

function patchWebAppearance(): void {
  const target = Appearance as unknown as PatchableAppearance;
  if (target.__racesmxWebPatched) return; // idempotent — module can re-evaluate in dev/fast-refresh
  target.__racesmxWebPatched = true;

  const getSystemScheme = target.getColorScheme.bind(target);
  const addSystemListener = target.addChangeListener.bind(target);
  const overrideListeners = new Set<ChangeListener>();
  let override: 'light' | 'dark' | null = null;

  target.getColorScheme = () => override ?? getSystemScheme();

  target.setColorScheme = (scheme) => {
    override = scheme === 'unspecified' || scheme == null ? null : scheme;
    const colorScheme = target.getColorScheme();
    overrideListeners.forEach((listener) => listener({ colorScheme }));
  };

  target.addChangeListener = (listener) => {
    overrideListeners.add(listener);
    // Still forward real OS changes, but only while no explicit override is
    // active — once the user has picked Light/Dark, the device preference
    // stops mattering until they switch back to System.
    const { remove: removeSystemListener } = addSystemListener((prefs) => {
      if (override == null) listener(prefs);
    });
    return {
      remove: () => {
        overrideListeners.delete(listener);
        removeSystemListener();
      },
    };
  };
}

if (Platform.OS === 'web') {
  // Runs once at module-evaluation time — before any component's first
  // `useColorScheme()` call — so there's no effect-ordering window where an
  // early read sees the unpatched shim. See ThemeModeProvider below: its own
  // rehydration effect calls `applyMode`, which depends on this having
  // already run.
  patchWebAppearance();
}

function applyMode(mode: ThemeMode): void {
  // 'unspecified' is RN's actual reset value here, not `null` — passing it
  // makes setColorScheme re-read and report the real OS scheme (see
  // react-native/Libraries/Utilities/Appearance.js, and patchWebAppearance
  // above for the web equivalent), so `useColorScheme()` goes back to
  // following the device again.
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
