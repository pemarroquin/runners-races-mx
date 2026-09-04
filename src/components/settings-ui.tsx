// Shared chrome for the Settings stack (src/app/(tabs)/settings/*).
//
// The Settings tab used to be one 697-line scroll with every control inline.
// It is now a list screen whose rows push their own sub-page, so the two
// things all six sub-pages have in common — the scroll container and the
// handful of label/hint/row type styles — live here rather than being copied
// six times and drifting.
//
// Deliberately small: anything used by exactly one page (the nav row, the
// version/support row, the privacy prose section) stays in that page's own
// file. This is only what is genuinely shared.
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';

import { Colors, Spacing, type ThemeColor } from '@/constants/theme';

/** The colour set for the current scheme, resolved the same way every screen
 *  in this app resolves it. Saves each sub-page repeating the two lines. */
export function useSettingsColors(): { c: Record<ThemeColor, string>; scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { c: Colors[scheme], scheme };
}

/**
 * A pushed settings sub-page: background + scroll + the app's standard
 * content padding.
 *
 * No SafeAreaView top edge, unlike the tab screens: these sit under the
 * stack's native header (see settings/_layout.tsx), which already clears the
 * status bar. Bottom padding is the app's normal content padding, not
 * BottomTabInset — the floating pill tab bar is now hidden on every pushed
 * settings page (see (tabs)/_layout.tsx's FloatingTabBar), so there is
 * nothing left to clear.
 */
export function SettingsPage({ children }: { children: ReactNode }) {
  const { c } = useSettingsColors();
  return (
    <View style={[styles.page, { backgroundColor: c.background }]}>
      <ScrollView contentContainerStyle={styles.container}>{children}</ScrollView>
    </View>
  );
}

/** A control row: a label on the left, its control on the right. */
export function SettingRow({ label, children, c }: { label: string; children: ReactNode; c: Record<ThemeColor, string> }) {
  return (
    <View style={settingsStyles.row}>
      <Text style={[settingsStyles.label, { color: c.textSecondary }]}>{label}</Text>
      {children}
    </View>
  );
}

/** The explanatory line under a control. Every one of these is real, revised
 *  copy — see the `settings.*Hint` keys in i18n.tsx. */
export function Hint({ children, c }: { children: ReactNode; c: Record<ThemeColor, string> }) {
  return <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>{children}</Text>;
}

// Shared type scale for the sub-pages. Carried over verbatim from the old
// single-file settings screen so the controls look exactly as they did.
export const settingsStyles = StyleSheet.create({
  block: { marginBottom: Spacing.five, gap: Spacing.two },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: { fontSize: 15 },
  hint: { fontSize: 13, lineHeight: 19 },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  action: { fontSize: 15, fontWeight: '700' },
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  container: { padding: Spacing.three, paddingBottom: Spacing.five },
});
