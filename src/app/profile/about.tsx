// Settings › About — build/support metadata, and the developer diagnostic
// hidden behind a long-press on the version row.
//
// Relocated from the old single-file settings screen unchanged.
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useCallback } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { SettingsPage, useSettingsColors } from '@/components/settings-ui';
import { Icon } from '@/components/ui/icon';
import { Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { loadLastRunDebug } from '@/lib/last-run-debug';
import { getPilotCounters } from '@/lib/pilot-instrumentation';

// Source of truth: docs/Settings.md. Change it there first, then mirror the
// value here — there's no build step that reads the doc directly.
const SUPPORT_EMAIL = 'support@racesmx.com';

function Row({
  label,
  value,
  onPress,
  onLongPress,
  c,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  /** A long-press affordance with no visual hint of its own (no icon, no
   *  styling change) — see the version row below. `onPress`'s arrow icon
   *  means "this opens something"; a silent long-press is deliberately not
   *  advertised the same way. */
  onLongPress?: () => void;
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
  return onPress || onLongPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} onLongPress={onLongPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

export default function AboutSettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();

  // expoConfig.version stays in sync with app.json/package.json, so this
  // reads the shipped build number instead of a value that can drift.
  const version = Constants.expoConfig?.version ?? '—';

  // Diagnostic escape hatch — see last-run-debug.ts and
  // pilot-instrumentation.ts. Long-press the version row (below) to copy the
  // last finished run's raw path + reported area (so a suspicious
  // measurement can be replayed through buildFence() as a test fixture
  // rather than argued about from a screenshot) ALONGSIDE the pilot
  // instrumentation counters — the only way to get those four numbers off
  // the device without a debug build or console access. Pilot counters are
  // included even when there's no finished run to report: a lost run is
  // exactly the case where last-run-debug has nothing (it's only saved on a
  // successful finish), so gating the counters behind a finished run would
  // hide the runsLost signal specifically.
  const copyLastRunDebug = useCallback(async () => {
    const debug = loadLastRunDebug();
    const pilotCounters = getPilotCounters();
    await Clipboard.setStringAsync(
      JSON.stringify({ pilotCounters, lastRun: debug }, null, 2),
    );
    Alert.alert(
      debug
        ? t('settings.debugCopied', { count: debug.points.length })
        : t('settings.debugCopiedCountersOnly'),
    );
  }, [t]);

  return (
    <SettingsPage>
      <View style={styles.rowGroup}>
        <Row
          label={t('settings.version')}
          value={version}
          onLongPress={() => void copyLastRunDebug()}
          c={c}
        />
        <Row
          label={t('settings.support')}
          value={SUPPORT_EMAIL}
          onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => {})}
          c={c}
        />
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
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
});
