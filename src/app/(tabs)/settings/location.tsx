// Settings › Location & privacy — the privacy zone and the OS location
// permission. The privacy NOTICE (what is collected, what isn't, deletion)
// is its own page: ./privacy.tsx.
//
// Relocated from the old single-file settings screen with no behavioural
// change. `expo-location` is used for one-shot calls only here — never to
// WATCH position; see src/lib/geolocation.ts for why that distinction is
// load-bearing on web.
import * as Location from 'expo-location';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Hint, SettingRow, SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { Spacing } from '@/constants/theme';
import { clearHomeZone, getHomeZone, setHomeZone } from '@/lib/home-point';
import { useI18n } from '@/lib/i18n';
import type { PrivacyZone } from '@/lib/privacy-zone';

export default function LocationSettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();

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

  return (
    <SettingsPage>
      {/* Privacy zone. Set from wherever the runner is standing rather
          than a map picker: "here" is the common case (you set it at
          home), and it needs no new screen. The point NEVER leaves the
          device — see privacy-zone.ts. */}
      <View style={settingsStyles.block}>
        <SettingRow label={t('settings.privacyZone')} c={c}>
          <Pressable
            onPress={zone ? clearZone : setZoneHere}
            disabled={zoneBusy}
            accessibilityRole="button"
            hitSlop={10}>
            <Text style={[settingsStyles.action, { color: c.accent, opacity: zoneBusy ? 0.5 : 1 }]}>
              {zoneBusy
                ? t('settings.zoneSetting')
                : zone
                  ? t('settings.zoneRemove')
                  : t('settings.zoneSetHere')}
            </Text>
          </Pressable>
        </SettingRow>
        <Hint c={c}>
          {zoneError
            ? t('settings.zoneFailed')
            : zone
              ? t('settings.zoneOnHint', { m: zone.radiusM })
              : t('settings.zoneOffHint')}
        </Hint>
      </View>

      <View style={settingsStyles.block}>
        <SettingRow label={t('settings.location')} c={c}>
          <View style={styles.locStatusWrap}>
            <View
              style={[styles.locDot, { backgroundColor: locPerm?.granted ? '#2FBF71' : c.accent }]}
            />
            <Text style={[styles.locValue, { color: c.text }]}>
              {locPerm === null
                ? t('settings.locationUnknown')
                : locPerm.granted
                  ? t('settings.locationOn')
                  : locPerm.canAskAgain
                    ? t('settings.locationNotSet')
                    : t('settings.locationOff')}
            </Text>
          </View>
        </SettingRow>
        <Hint c={c}>
          {locPerm?.granted ? t('settings.locationOnHint') : t('settings.locationOffHint')}
        </Hint>
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
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  locStatusWrap: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  locDot: { width: 8, height: 8, borderRadius: 4 },
  locValue: { fontSize: 15, fontWeight: '600' },
  locAction: { fontSize: 14, fontWeight: '700' },
});
