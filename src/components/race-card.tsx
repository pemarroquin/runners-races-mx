import { Pressable, StyleSheet, Text, View, useColorScheme, type ImageSourcePropType } from 'react-native';

import { ShimmerImage } from '@/components/ui/shimmer-image';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useCountdown, useI18n } from '@/lib/i18n';
import { daysUntil, distanceTagLabelKey, formatDate, type Race } from '@/lib/races';

// Matches what the region-art generation actually produces (2048x1536).
const HERO_IMAGE_RATIO = 4 / 3;
// A shorter crop of the same image, so a 2-column grid card doesn't get too tall.
const COMPACT_IMAGE_RATIO = 3 / 2;

interface RaceCardProps {
  race: Race;
  onPress: () => void;
  /** Bundled region-art asset for this race's region, or undefined to stay text-only (the real-world default for regions with no art yet, e.g. chih). */
  imageSource?: ImageSourcePropType;
  variant?: 'hero' | 'compact';
}

export function RaceCard({ race, onPress, imageSource, variant = 'compact' }: RaceCardProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t, locale } = useI18n();
  const countdown = useCountdown();
  const days = daysUntil(race.date);
  const dateLabel = formatDate(race.date, locale);
  const displayDate = dateLabel ?? countdown(null);
  const statusText =
    race.status === 'canceled'
      ? t('common.canceled')
      : race.status === 'changed'
        ? t('common.changed')
        : countdown(days);
  const cityLabel = `${race.city}, ${race.state}`;
  const accessibilityLabel = [race.name, displayDate, cityLabel, statusText]
    .filter(Boolean)
    .join(', ');
  const isHero = variant === 'hero';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessible={true}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.backgroundElement },
        // High-frequency interaction: instant tactile scale, no animation lib
        // (Emil — frequent interactions get feedback, not choreography).
        pressed && styles.pressed,
      ]}>
      {imageSource && (
        <ShimmerImage
          source={imageSource}
          accent={c.accent}
          tint={c.backgroundSelected}
          style={{ aspectRatio: isHero ? HERO_IMAGE_RATIO : COMPACT_IMAGE_RATIO }}
        />
      )}
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[styles.date, { color: c.textSecondary }]}>{displayDate}</Text>
          {race.status === 'changed' || race.status === 'canceled' ? (
            <View style={[styles.statusPill, { backgroundColor: c.accent }]}>
              <Text style={styles.statusPillText}>{statusText}</Text>
            </View>
          ) : (
            <Text
              style={[
                styles.countdown,
                { color: days !== null && days < 0 ? c.textSecondary : c.text },
              ]}>
              {statusText}
            </Text>
          )}
        </View>

        <Text
          style={[isHero ? styles.nameHero : styles.name, { color: c.text }]}
          numberOfLines={2}>
          {race.name}
        </Text>
        <Text style={[isHero ? styles.city : styles.cityCompact, { color: c.textSecondary }]}>
          {cityLabel}
        </Text>

        <View style={styles.tagRow}>
          {race.distanceTags.map((tag) => (
            <View key={tag} style={[styles.tag, { backgroundColor: c.backgroundSelected }]}>
              <Text style={[styles.tagText, { color: c.text }]}>
                {t(distanceTagLabelKey(tag))}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    // Needed so an edge-to-edge image (rendered as the first child, ahead of
    // `content`) gets clipped to the card's own rounded corners instead of
    // squaring off the top. No-op for the text-only path — it never paints
    // anything outside the rounded rect anyway.
    overflow: 'hidden',
  },
  content: {
    padding: Spacing.three,
    gap: Spacing.one,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  date: { fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  countdown: { fontSize: 13, fontWeight: '600' },
  statusPill: { paddingHorizontal: Spacing.two, paddingVertical: 2, borderRadius: GlassRadii.pill },
  statusPillText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  name: { fontSize: 17, fontWeight: '600', marginTop: Spacing.half },
  nameHero: { fontSize: 21, fontWeight: '700', marginTop: Spacing.half },
  city: { fontSize: 14 },
  cityCompact: { fontSize: 13 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, marginTop: Spacing.one },
  tag: { paddingHorizontal: Spacing.two, paddingVertical: 3, borderRadius: GlassRadii.pill },
  tagText: { fontSize: 12, fontWeight: '600' },
});
