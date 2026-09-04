// Settings — the list screen. Every row pushes a sub-page in this tab's
// stack (see ./_layout.tsx); nothing is configured from here.
//
// The Account group is hidden wholesale when Territory Mode has no server
// configured. That preserves exactly what the old single-file screen did:
// it hid the Profile section when `fetchMyProfile()` came back
// `reason: 'disabled'`, which `withSession` returns if and only if
// TERRITORY_ENABLED is false — so the synchronous constant is the same
// condition without a round trip, and without a row that leads to a page
// with nothing on it.
import { Link } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { TERRITORY_ENABLED } from '@/lib/supabase';

export default function SettingsIndexScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('settings.title')}</Text>
      <ScrollView contentContainerStyle={styles.container}>
        {TERRITORY_ENABLED && (
          <>
            <GroupLabel c={c}>{t('settings.groupAccount')}</GroupLabel>
            <View style={[styles.group, { backgroundColor: c.backgroundElement }]}>
              <NavRow
                href="/settings/profile"
                ios="person.crop.circle"
                android="account_circle"
                label={t('settings.sectionProfile')}
                hint={t('settings.navProfileHint')}
                first
                c={c}
              />
              <NavRow
                href="/settings/account"
                ios="envelope"
                android="mail"
                label={t('settings.accountTitle')}
                hint={t('settings.navAccountHint')}
                c={c}
              />
            </View>
          </>
        )}

        <GroupLabel c={c}>{t('settings.groupApp')}</GroupLabel>
        <View style={[styles.group, { backgroundColor: c.backgroundElement }]}>
          <NavRow
            href="/settings/preferences"
            ios="slider.horizontal.3"
            android="tune"
            label={t('settings.sectionPreferences')}
            hint={t('settings.navPreferencesHint')}
            first
            c={c}
          />
          <NavRow
            href="/settings/location"
            ios="location"
            android="location_on"
            label={t('settings.sectionLocation')}
            hint={t('settings.navLocationHint')}
            c={c}
          />
          {/* The privacy NOTICE, distinct from the location/privacy controls
              above it — the two hints are what tell them apart, which is
              exactly what the hints are for. */}
          <NavRow
            href="/settings/privacy"
            ios="lock"
            android="lock"
            label={t('privacy.title')}
            hint={t('settings.navPrivacyHint')}
            c={c}
          />
          <NavRow
            href="/settings/about"
            ios="info.circle"
            android="info"
            label={t('settings.sectionAbout')}
            hint={t('settings.navAboutHint')}
            c={c}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function GroupLabel({ children, c }: { children: string; c: Record<ThemeColor, string> }) {
  return <Text style={[styles.groupLabel, { color: c.textSecondary }]}>{children}</Text>;
}

function NavRow({
  href,
  ios,
  android,
  label,
  hint,
  first,
  c,
}: {
  // `Link` rather than `router.push`: it renders a real anchor on web, so the
  // rows are keyboard-focusable and open-in-new-tab works, and it keeps the
  // href visible at the call site for the typed-routes check.
  href: string;
  ios: SFSymbol;
  android: AndroidSymbol;
  label: string;
  hint: string;
  /** Suppresses the divider on the first row of a group. */
  first?: boolean;
  c: Record<ThemeColor, string>;
}) {
  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="link"
        // The hint is part of the row's meaning, not decoration — read it
        // out with the label rather than leaving a screen reader to announce
        // two unrelated strings.
        accessibilityLabel={`${label}. ${hint}`}
        style={({ pressed }) => [
          styles.row,
          !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.backgroundSelected },
          pressed && { backgroundColor: c.backgroundSelected },
        ]}>
        <View style={[styles.rowIcon, { backgroundColor: c.backgroundSelected }]}>
          <Icon ios={ios} android={android} size={17} color={c.text} />
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowLabel, { color: c.text }]}>{label}</Text>
          <Text style={[styles.rowHint, { color: c.textSecondary }]}>{hint}</Text>
        </View>
        <Icon ios="chevron.right" android="chevron_right" size={13} color={c.textSecondary} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  container: { padding: Spacing.three, paddingBottom: BottomTabInset },
  groupLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: Spacing.two,
    marginLeft: Spacing.two,
  },
  group: {
    borderRadius: Spacing.three,
    overflow: 'hidden',
    marginBottom: Spacing.four,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, fontWeight: '600' },
  rowHint: { fontSize: 13, lineHeight: 17 },
});
