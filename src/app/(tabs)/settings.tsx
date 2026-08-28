// Settings tab — the app's only settings-adjacent surface (no accounts, no
// backend, nothing else to configure). Owns the privacy notice: the two data
// flows disclosed here are src/lib/location.ts's IP-geolocation fallback and
// src/lib/db.ts / db.web.ts's local-only saved-races store. Also the natural
// home for build/support metadata, since there's no other about screen.
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { BottomTabInset, Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { clearHomeZone, getHomeZone, setHomeZone } from '@/lib/home-point';
import { useI18n } from '@/lib/i18n';
import type { PrivacyZone } from '@/lib/privacy-zone';
import { useReminders } from '@/lib/reminders-provider';
import {
  DISPLAY_NAME_MAX,
  fetchMyProfile,
  updateDisplayName,
} from '@/lib/territory-sync';
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
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useThemeMode();
  const { enabled: remindersOn, setEnabled: setRemindersEnabled } = useReminders();
  // Set when the OS permission prompt comes back denied, so the switch
  // flipping back explains itself instead of just looking broken.
  const [reminderDenied, setReminderDenied] = useState(false);

  // Location permission, stated plainly. Without this the app gives no
  // answer anywhere to "is tracking even allowed?" — and a denied
  // permission looks identical to weak GPS once a session is running,
  // which is exactly how a whole recording session can be lost.
  const isFocused = useIsFocused();
  const [locPerm, setLocPerm] = useState<Location.PermissionResponse | null>(null);
  const [locBusy, setLocBusy] = useState(false);

  // Re-read on every focus, not once on mount: the fix for a denied
  // permission is to change it in the OS settings app and come back, and a
  // mount-only check would still show the stale "denied" after that.
  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    const id = setTimeout(() => {
      Location.getForegroundPermissionsAsync()
        .then((res) => {
          if (!stale) setLocPerm(res);
        })
        .catch(() => {
          // Provider missing entirely (some web browsers) — leave it null
          // and render the unknown state rather than claiming "denied".
        });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused]);

  const onFixLocation = useCallback(async () => {
    // Once the OS has permanently denied, asking again silently no-ops —
    // the only real fix is the system settings app, so send them there
    // instead of showing a button that appears to do nothing.
    // react-native-web's Linking shim has NO openSettings — calling it
    // throws a TypeError inside an async handler with nobody to catch it,
    // and tsc can't see that because the react-native types declare it.
    // On web the runner unblocks the site in the browser's own UI, so the
    // honest move is to say that rather than to fake a button.
    if (locPerm && !locPerm.canAskAgain && Platform.OS !== 'web') {
      Linking.openSettings().catch(() => {});
      return;
    }
    setLocBusy(true);
    try {
      const res = await Location.requestForegroundPermissionsAsync();
      setLocPerm(res);
    } catch {
      // Leave the previous state; the row still reads honestly.
    } finally {
      setLocBusy(false);
    }
  }, [locPerm]);

  const onToggleReminders = useCallback(
    async (next: boolean) => {
      setReminderDenied(false);
      const ok = await setRemindersEnabled(next);
      if (!ok) setReminderDenied(true);
    },
    [setRemindersEnabled],
  );

  // Privacy zone state. Read synchronously from local prefs (same store as
  // theme/locale), so there is no loading flash.
  const [zone, setZone] = useState<PrivacyZone | null>(() => getHomeZone());
  const [zoneBusy, setZoneBusy] = useState(false);
  const [zoneError, setZoneError] = useState(false);

  const setZoneHere = useCallback(async () => {
    setZoneBusy(true);
    setZoneError(false);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setZoneError(true);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const ok = setHomeZone({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      // setPref returning false means blocked storage — reporting success
      // there would leave the runner believing they are masked when they
      // are not, which is the worst possible failure for this feature.
      if (!ok) {
        setZoneError(true);
        return;
      }
      setZone(getHomeZone());
    } catch {
      setZoneError(true);
    } finally {
      setZoneBusy(false);
    }
  }, []);

  const clearZone = useCallback(() => {
    clearHomeZone();
    setZone(getHomeZone());
    setZoneError(false);
  }, []);

  // The name shown on the territory leaderboard. Lives here rather than in
  // a new Profile surface: there's one settings screen and this is a
  // setting. Null until the runner picks one — the board falls back to
  // "Anónimo" rather than exposing anything from the anonymous identity.
  const [displayName, setDisplayName] = useState('');
  const [nameState, setNameState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed' | 'off'>(
    'loading',
  );

  useEffect(() => {
    let stale = false;
    // Deferred so no setState runs synchronously in the effect body.
    const id = setTimeout(() => {
      fetchMyProfile().then((outcome) => {
        if (stale) return;
        if (outcome.ok) {
          setDisplayName(outcome.displayName ?? '');
          setNameState('ready');
        } else {
          // 'disabled' is a build configuration, not a failure — hide the
          // field entirely rather than showing one that can't save.
          setNameState(outcome.reason === 'disabled' ? 'off' : 'failed');
        }
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, []);

  // Saved on blur rather than per keystroke: one write when the runner is
  // done, instead of a request per character.
  const saveName = useCallback(async () => {
    if (nameState === 'off' || nameState === 'loading') return;
    setNameState('saving');
    const outcome = await updateDisplayName(displayName);
    setNameState(outcome.ok ? 'saved' : 'failed');
  }, [displayName, nameState]);

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
        </View>

        <View style={styles.themeRow}>
          <Text style={[styles.rowLabel, { color: c.textSecondary }]}>{t('settings.language')}</Text>
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
        </View>

        {/* Privacy zone. Set from wherever the runner is standing rather
            than a map picker: "here" is the common case (you set it at
            home), and it needs no new screen. The point NEVER leaves the
            device — see privacy-zone.ts. */}
        <View style={styles.nameBlock}>
          <View style={styles.themeRow}>
            <Text style={[styles.rowLabel, { color: c.textSecondary }]}>
              {t('settings.privacyZone')}
            </Text>
            <Pressable
              onPress={zone ? clearZone : setZoneHere}
              disabled={zoneBusy}
              accessibilityRole="button"
              hitSlop={10}>
              <Text style={[styles.zoneAction, { color: c.accent, opacity: zoneBusy ? 0.5 : 1 }]}>
                {zoneBusy
                  ? t('settings.zoneSetting')
                  : zone
                    ? t('settings.zoneRemove')
                    : t('settings.zoneSetHere')}
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.reminderHint, { color: c.textSecondary }, styles.nameHint]}>
            {zoneError
              ? t('settings.zoneFailed')
              : zone
                ? t('settings.zoneOnHint', { m: zone.radiusM })
                : t('settings.zoneOffHint')}
          </Text>
        </View>

        {nameState !== 'off' && (
          <View style={styles.nameBlock}>
            <Text style={[styles.rowLabel, { color: c.textSecondary }]}>
              {t('settings.displayName')}
            </Text>
            <TextInput
              value={displayName}
              onChangeText={(next) => {
                setDisplayName(next);
                if (nameState === 'saved' || nameState === 'failed') setNameState('ready');
              }}
              onBlur={saveName}
              onSubmitEditing={saveName}
              editable={nameState !== 'loading' && nameState !== 'saving'}
              maxLength={DISPLAY_NAME_MAX}
              placeholder={t('settings.displayNamePlaceholder')}
              placeholderTextColor={c.textSecondary}
              returnKeyType="done"
              autoCapitalize="words"
              accessibilityLabel={t('settings.displayName')}
              style={[
                styles.nameInput,
                { backgroundColor: c.backgroundElement, color: c.text },
              ]}
            />
            <Text style={[styles.reminderHint, { color: c.textSecondary }, styles.nameHint]}>
              {nameState === 'failed'
                ? t('settings.displayNameFailed')
                : nameState === 'saved'
                  ? t('settings.displayNameSaved')
                  : t('settings.displayNameHint')}
            </Text>
          </View>
        )}

        <View style={styles.reminderBlock}>
          <View style={styles.themeRow}>
            <Text style={[styles.rowLabel, { color: c.textSecondary }]}>
              {t('settings.location')}
            </Text>
            <View style={styles.locStatusWrap}>
              <View
                style={[
                  styles.locDot,
                  { backgroundColor: locPerm?.granted ? '#2FBF71' : c.accent },
                ]}
              />
              <Text style={[styles.rowValue, { color: c.text }]}>
                {locPerm === null
                  ? t('settings.locationUnknown')
                  : locPerm.granted
                    ? t('settings.locationOn')
                    : locPerm.canAskAgain
                      ? t('settings.locationNotSet')
                      : t('settings.locationOff')}
              </Text>
            </View>
          </View>
          <Text style={[styles.reminderHint, { color: c.textSecondary }]}>
            {locPerm?.granted ? t('settings.locationOnHint') : t('settings.locationOffHint')}
          </Text>
          {locPerm !== null && !locPerm.granted && (
            <Pressable onPress={onFixLocation} disabled={locBusy} accessibilityRole="button" hitSlop={10}>
              <Text style={[styles.locAction, { color: c.accent, opacity: locBusy ? 0.5 : 1 }]}>
                {locPerm.canAskAgain
                  ? t('settings.locationEnable')
                  : Platform.OS === 'web'
                    ? t('settings.locationBrowserBlocked')
                    : t('settings.locationOpenSettings')}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Off by default and opt-in from here, rather than prompting on
            first save: the OS permission dialog only makes sense once the
            user has actually asked for reminders. */}
        <View style={styles.reminderBlock}>
          <View style={styles.themeRow}>
            <Text style={[styles.rowLabel, { color: c.textSecondary }]}>
              {t('settings.reminders')}
            </Text>
            <Switch
              value={remindersOn}
              onValueChange={onToggleReminders}
              accessibilityLabel={t('settings.reminders')}
            />
          </View>
          <Text style={[styles.reminderHint, { color: c.textSecondary }]}>
            {remindersOn ? t('settings.remindersOnHint') : t('settings.remindersHint')}
          </Text>
          {reminderDenied && (
            <Text style={[styles.reminderDenied, { color: c.accent }]}>
              {t('settings.remindersDenied')}
            </Text>
          )}
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
  reminderBlock: { marginBottom: Spacing.five, gap: Spacing.one },
  reminderHint: { fontSize: 13, lineHeight: 19, marginTop: -Spacing.four },
  nameBlock: { marginBottom: Spacing.five, gap: Spacing.two },
  nameInput: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  nameHint: { marginTop: 0 },
  zoneAction: { fontSize: 15, fontWeight: '700' },
  reminderDenied: { fontSize: 13, lineHeight: 19, fontWeight: '600' },
  locStatusWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  locDot: { width: 8, height: 8, borderRadius: 4 },
  locAction: { fontSize: 14, fontWeight: '700' },
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
