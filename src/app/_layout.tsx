import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';
// Deep import, not the package's barrel `react-native-gesture-handler` — the
// barrel's index re-exports the whole library (Gesture, GestureDetector,
// every native handler spec) as one non-tree-shakeable module graph, so
// `import { GestureHandlerRootView } from 'react-native-gesture-handler'`
// pulled in all 207 KiB of it into the ROOT layout (every screen, including
// the feed, which never uses a gesture) just for a component whose own web
// implementation is a plain View + context provider. No `exports` map in
// the package restricts deep imports, and Metro's platform-extension
// resolution (.web.js/.android.js/.js) still applies at this path — verify
// against a react-native-gesture-handler version bump, since deep import
// paths aren't a stable public API the way the barrel export is.
import GestureHandlerRootView from 'react-native-gesture-handler/lib/module/components/GestureHandlerRootView';

import { EmailLinkBanner } from '@/components/email-link-banner';
import { PortraitGate } from '@/components/portrait-gate';
import { CinematicSplash } from '@/components/splash';
import { LocaleProvider } from '@/lib/i18n';
import { RacesProvider } from '@/lib/races-provider';
import { RegionProvider } from '@/lib/region-context';
import { RemindersProvider } from '@/lib/reminders-provider';
import { SavedProvider } from '@/lib/saved';
import { ThemeModeProvider } from '@/lib/theme-mode';
import { TodayProvider } from '@/lib/today';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Static, locale-agnostic fallback — this is what's actually present
          in the STATIC PRERENDERED html (web.output: "static"), before any
          client JS runs. Was missing entirely: PageSpeed flagged a real
          `document-title`/`meta-description` gap (SEO, Accessibility's
          document-title check, and Agentic Browsing's accessibility-tree
          check all failed on it, 2026-09-16). expo-router/head's <Head> is
          the supported way to set this — react-helmet-async under the
          hood, already wired up by expo-router itself (confirmed by the
          `data-rh` attribute already on the empty <title> before this
          change) — and it's a safe no-op on native (Head.ios/.android fall
          back to rendering null outside a bare Handoff/Spotlight build).
          Any screen that wants its OWN title can still render its own
          <Head> further down the tree — react-helmet-async lets a
          later-mounted one win. */}
      <Head>
        <title>Runners&apos; Races MX</title>
        <meta
          name="description"
          content="Encuentra carreras en México y compite por territorio mientras corres."
        />
      </Head>
      <ThemeModeProvider>
      <LocaleProvider>
        <TodayProvider>
        <RacesProvider>
        <RegionProvider>
        <SavedProvider>
        {/* Inside SavedProvider and RacesProvider: it syncs the notification
            schedule off saved ids + race data, so it has to consume both. */}
        <RemindersProvider>
          <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="race/[id]" options={{ title: '' }} />
              {/* Profile — a root push (2026-09-17 nav restructure), same
                  level as race/[id], reached from the floating avatar pill
                  on the three tabs rather than from the tab bar itself. Its
                  own nested Stack (profile/_layout.tsx) owns every header
                  inside it, so this outer screen stays chromeless. */}
              <Stack.Screen name="profile" options={{ headerShown: false }} />
            </Stack>
            {/* Rendered after the Stack so it overlays the app during launch */}
            <CinematicSplash />
            {/* Also an overlay, for the same reason: a redirect from a
                clicked email link can land on any route, and the
                confirmation has to show regardless of which one. */}
            <EmailLinkBanner />
            {/* LAST, so it covers the splash and the banner too. Web-only
                and a no-op on native, which the OS already portrait-locks.
                Rendered here rather than per-screen because it must not
                unmount anything behind it — a session recording on the
                Track tab keeps recording while the phone is sideways. */}
            <PortraitGate />
          </ThemeProvider>
        </RemindersProvider>
        </SavedProvider>
        </RegionProvider>
        </RacesProvider>
        </TodayProvider>
      </LocaleProvider>
      </ThemeModeProvider>
    </GestureHandlerRootView>
  );
}
