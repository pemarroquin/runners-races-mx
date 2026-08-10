import * as Calendar from 'expo-calendar';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { BuySheet } from '@/components/buy-sheet';
import { RouteMap } from '@/components/route-map';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useCountdown, useI18n } from '@/lib/i18n';
import { daysUntil, distanceTagLabelKey, formatDate } from '@/lib/races';
import { useRaces } from '@/lib/races-provider';
import { useSaved } from '@/lib/saved';

async function getWritableCalendarId(): Promise<string | null> {
  if (Platform.OS === 'ios') {
    const cal = await Calendar.getDefaultCalendarAsync();
    return cal?.id ?? null;
  }
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const writable = calendars.find((c) => c.allowsModifications);
  return writable?.id ?? calendars[0]?.id ?? null;
}

export default function RaceDetailScreen() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale } = useI18n();
  const countdown = useCountdown();
  const { isSaved, toggle } = useSaved();
  const router = useRouter();
  const [buyOpen, setBuyOpen] = useState(false);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const races = useRaces();
  const race = useMemo(() => races.find((r) => r.id === id), [races, id]);
  if (!race) {
    return (
      <View style={[styles.container, styles.notFoundContainer, { backgroundColor: c.background }]}>
        <Text style={[styles.notFoundText, { color: c.text }]}>{t('common.notFound')}</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()}>
          <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.secondaryBtn}>
            <Text style={[styles.secondaryText, { color: c.text }]}>{t('common.back')}</Text>
          </GlassSurface>
        </Pressable>
      </View>
    );
  }

  const saved = isSaved(race.id);
  const days = daysUntil(race.date);
  const dateLabel = formatDate(race.date, locale);
  const esNote = locale === 'es' ? race.notesEs : null;
  const noteText = typeof esNote === 'string' && esNote !== '' ? esNote : race.notes;
  // Same locale fallback for the status banner. Sweeps write statusNote in
  // English, so without this a Spanish-default app shows an English banner.
  const esStatusNote = locale === 'es' ? race.statusNoteEs : null;
  const statusNoteText =
    typeof esStatusNote === 'string' && esStatusNote !== '' ? esStatusNote : race.statusNote;
  // RN's onTextLayout can't be used to detect truncation here: iOS reports
  // only the clamped lines when numberOfLines is set, and react-native-web
  // doesn't implement the prop at all. A length threshold is imprecise but
  // behaves the same on every platform.
  const noteIsLong = (statusNoteText?.length ?? 0) > 160;

  async function addToCalendar() {
    if (!race || !race.date) {
      Alert.alert(t('detail.calendarNoDate'));
      return;
    }
    try {
      const { status } = await Calendar.requestCalendarPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('detail.permission'));
        return;
      }
      const calId = await getWritableCalendarId();
      if (!calId) {
        Alert.alert(t('detail.permission'));
        return;
      }
      const [y, m, d] = race.date.split('-').map(Number);
      const [hh, mm] = (race.time ?? '07:00').split(':').map(Number);
      const start = new Date(y, m - 1, d, hh, mm);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      await Calendar.createEventAsync(calId, {
        title: race.name,
        startDate: start,
        endDate: end,
        location: [race.venue, race.city, race.state].filter(Boolean).join(', '),
        notes: race.signupUrl ?? race.sourceUrl,
        timeZone: undefined,
      });
      Alert.alert(t('detail.calendarAdded'));
    } catch (e) {
      console.warn('calendar error', e);
      Alert.alert(t('detail.permission'));
    }
  }

  function buyTicket() {
    if (!race?.signupUrl) return;
    setBuyOpen(true);
  }

  async function shareRace() {
    if (!race) return;
    const headline = t('detail.shareMessage', {
      name: race.name,
      date: dateLabel ? `${dateLabel}${race.time ? ` · ${race.time}` : ''}` : t('common.tbd'),
    });
    const message = `${headline}\n${race.sourceUrl}`;
    try {
      await Share.share({ message });
    } catch {
      // The user dismissing the share sheet (or any share failure) is a
      // no-op, not an error worth surfacing.
    }
  }

  // A canceled race must never let someone pay for it, and a changed
  // (postponed) race must not read as a confident "buy now" even though
  // its signup link may still be valid for the new date.
  const ctaDisabled = race.status === 'canceled' || !race.signupUrl;
  const ctaLabel =
    race.status === 'canceled'
      ? t('detail.canceled')
      : !race.signupUrl
        ? t('detail.noLink')
        : race.status === 'changed'
          ? t('detail.viewRegistration')
          : t('detail.buy');

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: '' }} />

      {/* Cinematic three-beat entrance: hero → details → actions. Rare
          navigation, so motion is welcome here (Emil's gate passed). */}
      <Animated.View entering={FadeInDown.duration(400)}>
        {(race.status === 'changed' || race.status === 'canceled') && (
          <View style={[styles.statusBanner, { backgroundColor: c.accent }]}>
            <Text style={styles.statusTitle}>
              {race.status === 'canceled' ? t('common.canceled') : t('common.changed')}
            </Text>
            {statusNoteText && (
              <>
                <Text style={styles.statusNote} numberOfLines={noteExpanded ? undefined : 3}>
                  {statusNoteText}
                </Text>
                {noteIsLong && (
                  <Pressable accessibilityRole="button" onPress={() => setNoteExpanded((v) => !v)}>
                    <Text style={styles.statusToggle}>
                      {noteExpanded ? t('common.less') : t('common.more')}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
            {race.lastVerified && (
              <Text style={styles.statusMeta}>
                {t('common.lastVerified')} {formatDate(race.lastVerified, locale) ?? race.lastVerified}
              </Text>
            )}
          </View>
        )}
        <Text style={[styles.name, { color: c.text }]}>{race.name}</Text>
        <Text style={[styles.countdown, { color: c.textSecondary }]}>{countdown(days)}</Text>

        <View style={styles.tagRow}>
          {race.distanceTags.map((tag) => (
            <View key={tag} style={[styles.tag, { backgroundColor: c.backgroundSelected }]}>
              <Text style={[styles.tagText, { color: c.text }]}>{t(distanceTagLabelKey(tag))}</Text>
            </View>
          ))}
        </View>
      </Animated.View>

      <Animated.View entering={FadeInDown.duration(400).delay(80)}>
        <Field label={t('common.when')} value={dateLabel ? `${dateLabel}${race.time ? ` · ${race.time}` : ''}` : t('common.tbd')} c={c} />
        {race.confidence === 'low' && (
          <Text style={[styles.unconfirmed, { color: c.textSecondary }]}>{t('common.unconfirmed')}</Text>
        )}
        <Field label={t('common.where')} value={[race.venue, `${race.city}, ${race.state}`].filter(Boolean).join('\n')} c={c} />
        <Field
          label={t('common.distances')}
          value={race.distances.length > 0 ? race.distances.join(' · ') : t(distanceTagLabelKey('TBD'))}
          c={c}
        />
        {race.organizer && <Field label={t('common.organizer')} value={race.organizer} c={c} />}
        <RouteMap race={race} />
        {noteText && <Field label={t('common.notes')} value={noteText} c={c} />}
      </Animated.View>

      <Animated.View entering={FadeInDown.duration(400).delay(160)} style={styles.actions}>
        <Pressable
          onPress={buyTicket}
          disabled={ctaDisabled}
          style={[styles.primaryBtn, { backgroundColor: c.text }, ctaDisabled && styles.disabled]}>
          <Text style={[styles.primaryText, { color: c.background }]}>{ctaLabel}</Text>
        </Pressable>

        <View style={styles.secondaryRow}>
          <Pressable onPress={() => toggle(race.id)} style={styles.secondaryFlex}>
            <GlassSurface
              scheme={scheme}
              radius={GlassRadii.pill}
              style={saved && { backgroundColor: c.backgroundSelected }}
              contentStyle={styles.secondaryBtn}>
              {/* Keyed cross-fade on toggle — meaningful state change, subtle
                  acknowledgment (Jakub: animate contextual swaps, never instant). */}
              <Animated.View key={saved ? 'saved' : 'save'} entering={FadeIn.duration(180)} style={styles.secondaryRowInner}>
                <Icon ios={saved ? 'heart.fill' : 'heart'} android={saved ? 'favorite' : 'favorite_border'} size={15} color={c.text} />
                <Text style={[styles.secondaryText, { color: c.text }]}>
                  {saved ? t('detail.saved') : t('detail.save')}
                </Text>
              </Animated.View>
            </GlassSurface>
          </Pressable>
          <Pressable onPress={addToCalendar} style={styles.secondaryFlex}>
            <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.secondaryBtn}>
              <Text style={[styles.secondaryText, { color: c.text }]}>{t('detail.addCalendar')}</Text>
            </GlassSurface>
          </Pressable>
        </View>

        <Pressable accessibilityRole="button" onPress={shareRace}>
          <GlassSurface scheme={scheme} radius={GlassRadii.pill} contentStyle={styles.secondaryBtn}>
            <Text style={[styles.secondaryText, { color: c.text }]}>{t('detail.share')}</Text>
          </GlassSurface>
        </Pressable>

        <Pressable onPress={() => Linking.openURL(race.sourceUrl).catch(() => {})} style={styles.sourceRow}>
          <Text style={[styles.source, { color: c.textSecondary }]}>{t('detail.viewSource')}</Text>
          <Icon ios="arrow.up.right" android="open_in_new" size={12} color={c.textSecondary} />
        </Pressable>
      </Animated.View>

      <BuySheet
        visible={buyOpen}
        url={race.signupUrl}
        title={race.name}
        onClose={() => setBuyOpen(false)}
      />
    </ScrollView>
  );
}

function Field({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: Record<ThemeColor, string>;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: c.textSecondary }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.fieldValue, { color: c.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: Spacing.four, gap: Spacing.two, paddingBottom: Spacing.six },
  notFoundContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.three },
  notFoundText: { fontSize: 16, fontWeight: '600' },
  unconfirmed: { fontSize: 12, marginTop: -2 },
  statusBanner: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.three,
    gap: 4,
  },
  statusTitle: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  statusNote: { color: '#ffffff', fontSize: 14, lineHeight: 20 },
  statusMeta: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  statusToggle: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700' },
  name: { fontSize: 24, fontWeight: '700' },
  countdown: { fontSize: 15, fontWeight: '600' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, marginVertical: Spacing.two },
  tag: { paddingHorizontal: Spacing.two, paddingVertical: 4, borderRadius: GlassRadii.pill },
  tagText: { fontSize: 13, fontWeight: '600' },
  field: { gap: 2, marginTop: Spacing.two },
  fieldLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  fieldValue: { fontSize: 16, lineHeight: 22 },
  actions: { marginTop: Spacing.four, gap: Spacing.two },
  primaryBtn: { borderRadius: GlassRadii.pill, paddingVertical: Spacing.three, alignItems: 'center' },
  primaryText: { fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  secondaryRow: { flexDirection: 'row', gap: Spacing.two },
  secondaryFlex: { flex: 1 },
  secondaryBtn: { paddingVertical: Spacing.three, alignItems: 'center' },
  secondaryRowInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: Spacing.two,
  },
  source: { fontSize: 14 },
});
