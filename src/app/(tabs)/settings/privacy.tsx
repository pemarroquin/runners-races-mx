// Settings › Privacy — the disclosure notice.
//
// Every string here is relocated VERBATIM from the old single-file settings
// screen, in the same order, with the same comments explaining why each
// paragraph exists. This copy has been revised repeatedly (LFPDPPP — it
// ships to Mexican consumers, Spanish primary) and each paragraph was added
// in the same change as the data flow it discloses; none of it is reworded
// here. The only presentation change is that the page's own 20pt
// "Privacidad" heading is gone — the stack header now says it (see
// ./_layout.tsx, which titles this route with the same `privacy.title` key).
//
// The controls that used to sit under the "Ubicación y privacidad" heading
// (privacy zone, location permission) are on ./location.tsx.
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { SettingsPage, useSettingsColors } from '@/components/settings-ui';
import { Icon } from '@/components/ui/icon';
import { Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';

const IPAPI_PRIVACY_URL = 'https://ipapi.co/privacy/';

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

export default function PrivacySettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();

  return (
    <SettingsPage>
      <Section
        title={t('privacy.collectedTitle')}
        body={[
          t('privacy.collectedLocation'),
          t('privacy.collectedIp'),
          t('privacy.collectedSaved'),
          t('privacy.collectedReminders'),
          // Territory Mode is the first thing in this app that puts user
          // data on a server, so it gets its own paragraph rather than a
          // clause bolted onto the location one — and it sits next to the
          // identity note, since the anonymous account only exists because
          // of it.
          t('privacy.collectedTerritory'),
          t('privacy.collectedIdentity'),
          // A failed run is now held on the device until it uploads —
          // new at-rest location storage, so it is disclosed here in the
          // same change that introduced it.
          t('privacy.collectedQueue'),
          // Same reasoning, earlier in the run's life: an in-progress
          // session is now checkpointed to the device every few seconds
          // (run-checkpoint.ts), storing the RAW route before
          // privacy-zone trimming applies — worth calling out precisely
          // because it is more revealing at rest than the queue above,
          // which only ever holds the already-trimmed path.
          t('privacy.collectedCheckpoint'),
          // last-run-debug.ts: the last finished run's raw route, kept
          // for a developer diagnostic (long-press the version row on
          // ./about.tsx), same "disclose it in the change that adds it"
          // rule as the two above.
          t('privacy.collectedDebug'),
          // Phase 2 made territory visible to other runners; this is the
          // paragraph that says so. Added in the same change as the
          // leaderboard, not after it.
          t('privacy.collectedVisible'),
          // The mitigation belongs next to the disclosure of the risk, not
          // in a separate section a reader might never reach.
          t('privacy.collectedZone'),
        ]}
        c={c}
      />
      <Section
        title={t('privacy.notTitle')}
        body={[
          t('privacy.notAccounts'),
          t('privacy.notTracking'),
          t('privacy.notSharing'),
          t('privacy.notServer'),
        ]}
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
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
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
