import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { CinematicSplash } from '@/components/splash';
import { LocaleProvider } from '@/lib/i18n';
import { RacesProvider } from '@/lib/races-provider';
import { RegionProvider } from '@/lib/region-context';
import { SavedProvider } from '@/lib/saved';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
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
    </GestureHandlerRootView>
  );
}
