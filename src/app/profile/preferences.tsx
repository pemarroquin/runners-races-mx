// Settings › Preferences — appearance, language, race reminders.
//
// Relocated from the old single-file settings screen with no behavioural
// change: the same two GlassSurface segmented controls (including the
// explicit `aria-checked`, which react-native-web does NOT derive from
// accessibilityState) and the same reminders switch with its denied-state
// message.
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Hint, SettingRow, SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { useReminders } from '@/lib/reminders-provider';
import { useThemeMode, type ThemeMode } from '@/lib/theme-mode';

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

function themeModeLabel(mode: ThemeMode, t: (key: string) => string): string {
  if (mode === 'light') return t('settings.themeLight');
  if (mode === 'dark') return t('settings.themeDark');
  return t('settings.themeSystem');
}

export default function PreferencesSettingsScreen() {
  const { c, scheme } = useSettingsColors();
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useThemeMode();
  const { enabled: remindersOn, setEnabled: setRemindersEnabled } = useReminders();
  // Set when the OS permission prompt comes back denied, so the switch
  // flipping back explains itself instead of just looking broken.
  const [reminderDenied, setReminderDenied] = useState(false);

  const onToggleReminders = useCallback(
    async (next: boolean) => {
      setReminderDenied(false);
      const ok = await setRemindersEnabled(next);
      if (!ok) setReminderDenied(true);
    },
    [setRemindersEnabled],
  );

  return (
    <SettingsPage>
      <View style={styles.controlBlock}>
        <SettingRow label={t('settings.theme')} c={c}>
          <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.segmentTrack}>
            {THEME_MODES.map((m) => (
              <Pressable
                key={m}
                onPress={() => setMode(m)}
                accessibilityRole="radio"
                accessibilityState={{ selected: mode === m }}
                // react-native-web (0.21) doesn't translate accessibilityState
                // into ARIA attributes for View-based components — only flat
                // aria-* props are forwarded — so role="radio" was shipping
                // with no aria-checked at all (PageSpeed Insights, 2026-08-11).
                aria-checked={mode === m}
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
        </SettingRow>
      </View>

      <View style={styles.controlBlock}>
        <SettingRow label={t('settings.language')} c={c}>
          <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.segmentTrack}>
            {(['es', 'en'] as const).map((l) => (
              <Pressable
                key={l}
                onPress={() => setLocale(l)}
                accessibilityRole="radio"
                accessibilityState={{ selected: locale === l }}
                // Same react-native-web ARIA gap as the theme segment above —
                // role="radio" alone doesn't reach the DOM as aria-checked.
                aria-checked={locale === l}
                hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
                style={[styles.segment, locale === l && { backgroundColor: c.text }]}>
                <Text
                  maxFontSizeMultiplier={1.3}
                  style={[styles.segmentText, { color: locale === l ? c.background : c.textSecondary }]}>
                  {l.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </GlassSurface>
        </SettingRow>
      </View>

      {/* Off by default and opt-in from here, rather than prompting on
          first save: the OS permission dialog only makes sense once the
          user has actually asked for reminders. */}
      <View style={settingsStyles.block}>
        <SettingRow label={t('settings.reminders')} c={c}>
          <Switch
            value={remindersOn}
            onValueChange={onToggleReminders}
            accessibilityLabel={t('settings.reminders')}
          />
        </SettingRow>
        <Hint c={c}>{remindersOn ? t('settings.remindersOnHint') : t('settings.remindersHint')}</Hint>
        {reminderDenied && (
          <Text style={[styles.reminderDenied, { color: c.accent }]}>
            {t('settings.remindersDenied')}
          </Text>
        )}
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  controlBlock: { marginBottom: Spacing.five },
  segmentTrack: { flexDirection: 'row', padding: 3, gap: 2 },
  segment: {
    borderRadius: GlassRadii.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: 5,
    alignItems: 'center',
  },
  segmentText: { fontSize: 12, fontWeight: '700' },
  reminderDenied: { fontSize: 13, lineHeight: 19, fontWeight: '600' },
});
