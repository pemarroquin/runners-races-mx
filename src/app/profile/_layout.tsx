// Profile — a stack, pushed at the ROOT (see src/app/_layout.tsx), not
// nested inside (tabs) anymore.
//
// Moved out of `(tabs)/settings/` 2026-09-17 (Pedro's nav restructure): the
// bottom tab bar dropped to three items (Run/Leaderboard/Races) with no room
// for a Profile tab, so Profile is now reached from the floating avatar pill
// (`profile-pill.tsx`) on those three screens instead — a root push, exactly
// like `race/[id]`, which is why the collision this file used to warn about
// (a root-level `settings/` clashing with the tab's own `/settings` route)
// no longer applies: there is no tab route named `profile` to collide with.
//
// That also retires the hidden-tab-bar hack this file used to require:
// FloatingTabBar no longer needs to detect "a sub-page is pushed on top of
// the Settings tab" and hide itself, because this whole stack sits outside
// the tab navigator now — `index` below can show a real header + back
// button like every other pushed sub-page, instead of needing the tab's own
// big-title treatment to fake one.
//
// Header titles reuse the section keys the old screen already shipped
// (`settings.sectionProfile` → now the Account sub-page, `privacy.title`,
// …), so no page title here is new, untranslated copy.
import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';

export default function ProfileLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  return (
    <Stack
      // react-navigation's own DefaultTheme/DarkTheme (applied in the root
      // layout) paint the header #fff / #121212 against this app's #ffffff /
      // #000000 page background, which reads as a seam in dark mode. Pin the
      // header to the app's own tokens instead.
      screenOptions={{
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: c.background },
      }}>
      {/* headerShown: false — this screen draws its own back control plus
          the big "Ajustes"/"Settings" title (see index.tsx) rather than the
          native header, since as the STACK'S OWN first screen it would get
          no automatic back button from react-navigation anyway (that only
          appears for a screen with a predecessor in the SAME navigator). */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="account" options={{ title: t('settings.sectionProfile') }} />
      <Stack.Screen name="history" options={{ title: t('settings.historyTitle') }} />
      <Stack.Screen name="progress" options={{ title: t('settings.sectionProgress') }} />
      <Stack.Screen name="preferences" options={{ title: t('settings.sectionPreferences') }} />
      <Stack.Screen name="location" options={{ title: t('settings.sectionLocation') }} />
      <Stack.Screen name="privacy" options={{ title: t('privacy.title') }} />
      <Stack.Screen name="about" options={{ title: t('settings.sectionAbout') }} />
    </Stack>
  );
}
