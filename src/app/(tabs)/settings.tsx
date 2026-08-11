// Settings tab — the app's only settings-adjacent surface (no accounts, no
// backend, nothing else to configure). Owns the privacy notice: the two data
// flows disclosed here are src/lib/location.ts's IP-geolocation fallback and
// src/lib/db.ts / db.web.ts's local-only saved-races store. Also the natural
// home for build/support metadata, since there's no other about screen.
import Constants from 'expo-constants';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { useThemeMode, type ThemeMode } from '@/lib/theme-mode';

const IPAPI_PRIVACY_URL = 'https://ipapi.co/privacy/';
// Source of truth: docs/Settings.md. Change it there first, then mirror the
// value here — there's no build step that reads the doc directly.
const SUPPORT_EMAIL = 'support@racesmx.com';
const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

function Section({
  title,
  body,
  c,
}: {
  title: string;
  body: string[];
  c: Record<ThemeColor, string>;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
      {body.map((line) => (
        <Text key={line} style={[styles.paragraph, { color: c.textSecondary }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function Row({
  label,
  value,
  onPress,
  c,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  c: Record<ThemeColor, string>;
}) {
  const content = (
    <View style={[styles.row, { borderTopColor: c.backgroundSelected }]}>
      <Text style={[styles.rowLabel, { color: c.textSecondary }]}>{label}</Text>
      <View style={styles.rowValueWrap}>
        <Text style={[styles.rowValue, { color: c.text }]}>{value}</Text>
        {onPress && <Icon ios="arrow.up.right" android="open_in_new" size={12} color={c.textSecondary} />}
      </View>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

function themeModeLabel(mode: ThemeMode, t: (key: string) => string): string {
  if (mode === 'light') return t('settings.themeLight');
  if (mode === 'dark') return t('settings.themeDark');
  return t('settings.themeSystem');
}

export default function SettingsScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { mode, setMode } = useThemeMode();

  // expoConfig.version stays in sync with app.json/package.json, so this
  // reads the shipped build number instead of a value that can drift.
  const version = Constants.expoConfig?.version ?? '—';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]} edges={['top']}>
      <Text style={[styles.title, { color: c.text }]}>{t('settings.title')}</Text>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.themeRow}>
          <Text style={[styles.rowLabel, { color: c.textSecondary }]}>{t('settings.theme')}</Text>
          <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.segmentTrack}>
            {THEME_MODES.map((m) => (
              <Pressable
                key={m}
                onPress={() => setMode(m)}
                accessibilityRole="radio"
                accessibilityState={{ selected: mode === m }}
                // Segment renders ~24pt tall — hitSlop brings the tappable
                // area close to Apple HIG's 44pt default control size
                // without inflating the compact segmented control.
                hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
                style={[styles.segment, mode === m && { backgroundColor: c.text }]}>
                <Text
                  maxFontSizeMultiplier={1.3}
                  style={[styles.segmentText, { color: mode === m ? c.background : c.textSecondary }]}>
                  {themeModeLabel(m, t)}
                </Text>
              </Pressable>
            ))}
          </GlassSurface>
        </View>

        <View style={styles.rowGroup}>
          <Row label={t('settings.version')} value={version} c={c} />
          <Row
            label={t('settings.support')}
            value={SUPPORT_EMAIL}
            onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => {})}
            c={c}
          />
        </View>

        <Text style={[styles.privacyTitle, { color: c.text }]}>{t('privacy.title')}</Text>

        <Section
          title={t('privacy.collectedTitle')}
          body={[t('privacy.collectedLocation'), t('privacy.collectedIp'), t('privacy.collectedSaved')]}
          c={c}
        />
        <Section
          title={t('privacy.notTitle')}
          body={[t('privacy.notAccounts'), t('privacy.notTracking'), t('privacy.notSharing'), t('privacy.notServer')]}
          c={c}
        />
        <Section title={t('privacy.deleteTitle')} body={[t('privacy.deleteBody')]} c={c} />

        <Pressable
          onPress={() => Linking.openURL(IPAPI_PRIVACY_URL).catch(() => {})}
          accessibilityRole="link"
          hitSlop={12}
          style={styles.sourceRow}>
          <Text style={[styles.source, { color: c.textSecondary }]}>{t('privacy.ipapiLink')}</Text>
          <Icon ios="arrow.up.right" android="open_in_new" size={12} color={c.textSecondary} />
        </Pressable>
      </ScrollView>
    </SafeAreaView>
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
  themeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.five,
  },
  segmentTrack: { flexDirection: 'row', padding: 3, gap: 2 },
  segment: {
    borderRadius: GlassRadii.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: 5,
    alignItems: 'center',
  },
  segmentText: { fontSize: 12, fontWeight: '700' },
  rowGroup: { marginBottom: Spacing.five },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: 15 },
  rowValueWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  rowValue: { fontSize: 15, fontWeight: '600' },
  privacyTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: Spacing.three,
  },
  section: { marginBottom: Spacing.four },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: Spacing.two,
  },
  paragraph: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: Spacing.two,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  source: { fontSize: 13 },
});
