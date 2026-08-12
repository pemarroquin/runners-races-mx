import * as Calendar from 'expo-calendar';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { lazy, Suspense, useMemo, useState } from 'react';
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

import { RouteMap } from '@/components/route-map';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { ShimmerImage } from '@/components/ui/shimmer-image';
import { GlassRadii } from '@/constants/glass';
import { raceWebUrl } from '@/constants/links';
import { Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useCountdown, useI18n } from '@/lib/i18n';
import { daysUntil, distanceTagLabelKey, formatDate, isSafeUrl } from '@/lib/races';
import { useRaces } from '@/lib/races-provider';
import { HERO_IMAGE_RATIO, pickRegionArt } from '@/lib/region-art';
import { REGIONS, raceInRegion } from '@/lib/regions';
import { useSaved } from '@/lib/saved';
import { instantInZone, timeZoneForState } from '@/lib/time';
import { useToday } from '@/lib/today';

// BuySheet pulls in react-native-webview, react-native-gesture-handler drag
// handling, and its own Reanimated motion — real weight that every other
// screen (feed, my races, settings) paid for anyway under the single shared
// web entry bundle, even though only the race-detail purchase flow needs it.
// Same pattern PR #16 already proved for mapbox-gl: a dynamic import here is
// a real Metro chunk boundary, splitting it out of the bundle every route
// downloads on first load.
const BuySheet = lazy(() =>
  import('@/components/buy-sheet').then((m) => ({ default: m.BuySheet })),
);

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
  // Subscribed to purely so this screen re-renders when the day rolls over.
  // A Provider whose value changes only re-renders its CONSUMERS (the
  // children element identity is unchanged, so React bails out on the rest of
  // the subtree) — without this call, an open detail screen would still read
  // "falta 1 día" on race morning, which is exactly the bug being fixed.
  useToday();
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
  // Same region + same deterministic per-race pick the feed card already
  // used, so tapping a card lands on the same picture rather than a
  // different random one — that continuity is the whole point of "cascading"
  // the art through to detail.
  const region = REGIONS.find((r) => raceInRegion(race, r));
  const heroImage = region ? pickRegionArt(region.id, race.id, 'hero') : undefined;
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

      const zone = timeZoneForState(race.state);
      // 107 of 195 races have no confirmed start time. The old code quietly
      // substituted 07:00 and said nothing, putting a made-up time in the
      // user's real calendar. An all-day event is the honest representation
      // of "this race is on this date, time not announced yet".
      const allDay = !race.time;
      // Both branches build the instant in the RACE's zone, not the phone's.
      const start = instantInZone(race.date, race.time ?? '00:00', zone);
      const end = allDay
        ? instantInZone(race.date, '23:59', zone)
        : new Date(start.getTime() + 2 * 60 * 60 * 1000);

      // Tapping twice used to create a second identical event, with no way to
      // undo it from the app. Look for one we already wrote before adding.
      const existing = await Calendar.getEventsAsync(
        [calId],
        instantInZone(race.date, '00:00', zone),
        instantInZone(race.date, '23:59', zone),
      );
      if (existing.some((e) => e.title === race.name)) {
        Alert.alert(t('detail.calendarAlready'));
        return;
      }

      await Calendar.createEventAsync(calId, {
        title: race.name,
        startDate: start,
        endDate: end,
        allDay,
        location: [race.venue, race.city, race.state].filter(Boolean).join(', '),
        notes: race.signupUrl ?? race.sourceUrl,
        timeZone: zone,
      });
      Alert.alert(allDay ? t('detail.calendarAddedNoTime') : t('detail.calendarAdded'));
    } catch (e) {
      console.warn('calendar error', e);
      Alert.alert(t('detail.calendarFailed'));
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
    // The app's own link, not race.sourceUrl — sharing used to send people to
    // a third-party race calendar with no route back here.
    const message = `${headline}\n${raceWebUrl(race.id)}`;
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

      {/* Full-bleed, edge-to-edge — the same picture the feed card showed
          for this race, now the first thing on the page instead of stopping
          at the card. Sits outside the padded `body` below on purpose. */}
      {heroImage && (
        <Animated.View entering={FadeIn.duration(400)} style={styles.heroWrap}>
          <ShimmerImage
            source={heroImage}
            accent={c.accent}
            tint={c.backgroundSelected}
            style={{ aspectRatio: HERO_IMAGE_RATIO }}
            priority="high"
          />
          {/* Soft handoff into the body background instead of a hard cut. */}
          <LinearGradient
            colors={['transparent', c.background]}
            style={styles.heroScrim}
            pointerEvents="none"
          />
          {/* At-a-glance status on the image itself; the full banner with
              the actual statusNote text still renders below, unchanged —
              this is additive, not a replacement for it. */}
          {(race.status === 'changed' || race.status === 'canceled') && (
            <View style={[styles.heroStatusPill, { backgroundColor: c.accent }]}>
              {/* Capped: fixed pill absolutely positioned over the hero
                  image — uncapped Dynamic Type has nowhere to reflow to
                  without overrunning the image edge. */}
              <Text style={styles.statusPillText} maxFontSizeMultiplier={1.3}>
                {race.status === 'canceled' ? t('common.canceled') : t('common.changed')}
              </Text>
            </View>
          )}
        </Animated.View>
      )}

      <View style={styles.body}>
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
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={12}
                    onPress={() => setNoteExpanded((v) => !v)}>
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
          accessibilityRole="button"
          accessibilityState={{ disabled: ctaDisabled }}
          style={[styles.primaryBtn, { backgroundColor: c.text }, ctaDisabled && styles.disabled]}>
          <Text style={[styles.primaryText, { color: c.background }]}>{ctaLabel}</Text>
        </Pressable>

        <View style={styles.secondaryRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              // A failed save used to be indistinguishable from a successful
              // one: toggle() returned early and the tap did nothing visible.
              if (!toggle(race.id)) Alert.alert(t('detail.saveFailed'));
            }}
            style={styles.secondaryFlex}>
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
          <Pressable onPress={addToCalendar} accessibilityRole="button" style={styles.secondaryFlex}>
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

        {/* isSafeUrl is already enforced at the data boundary (isValidRace
            drops any race whose sourceUrl isn't http(s)); repeated here so the
            sink is safe on its own terms rather than by assumption. */}
        <Pressable
          onPress={() => {
            if (isSafeUrl(race.sourceUrl)) Linking.openURL(race.sourceUrl).catch(() => {});
          }}
          accessibilityRole="link"
          hitSlop={12}
          style={styles.sourceRow}>
          <Text style={[styles.source, { color: c.textSecondary }]}>{t('detail.viewSource')}</Text>
          <Icon ios="arrow.up.right" android="open_in_new" size={12} color={c.textSecondary} />
        </Pressable>
      </Animated.View>
      </View>

      <Suspense fallback={null}>
        <BuySheet
          visible={buyOpen}
          url={race.signupUrl}
          title={race.name}
          onClose={() => setBuyOpen(false)}
        />
      </Suspense>
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
  // No padding here — the hero image needs to run full-bleed to the
  // ScrollView's own edges. `body` (below) carries the padding every other
  // screen gets from `container` in other files.
  container: { paddingBottom: Spacing.six },
  body: { paddingHorizontal: Spacing.four, paddingTop: Spacing.three, gap: Spacing.two },
  heroWrap: { position: 'relative' },
  heroScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 64 },
  heroStatusPill: {
    position: 'absolute',
    top: Spacing.three,
    right: Spacing.three,
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    borderRadius: GlassRadii.pill,
  },
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
  statusPillText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
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
