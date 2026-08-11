import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
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

import { CinematicSplash } from '@/components/splash';
import { LocaleProvider } from '@/lib/i18n';
import { RacesProvider } from '@/lib/races-provider';
import { RegionProvider } from '@/lib/region-context';
import { SavedProvider } from '@/lib/saved';
import { ThemeModeProvider } from '@/lib/theme-mode';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeModeProvider>
      <LocaleProvider>
        <RacesProvider>
        <RegionProvider>
        <SavedProvider>
          <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="race/[id]" options={{ title: '' }} />
            </Stack>
            {/* Rendered after the Stack so it overlays the app during launch */}
            <CinematicSplash />
          </ThemeProvider>
        </SavedProvider>
        </RegionProvider>
        </RacesProvider>
      </LocaleProvider>
      </ThemeModeProvider>
    </GestureHandlerRootView>
  );
}
