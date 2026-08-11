import { Pressable, StyleSheet, Text, View, useColorScheme, type ImageSourcePropType } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { ShimmerImage } from '@/components/ui/shimmer-image';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useCountdown, useI18n } from '@/lib/i18n';
import {
  abbreviateState,
  daysUntil,
  distanceTagIcon,
  distanceTagLabelKey,
  formatDate,
  type Race,
} from '@/lib/races';
import { COMPACT_IMAGE_RATIO, HERO_IMAGE_RATIO } from '@/lib/region-art';

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
  const cityLabel = `${race.city}, ${abbreviateState(race.state)}`;
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
          // Hero is at most one on screen and the single most visually
          // prominent element in the feed — worth prioritizing over the
          // dozen-odd unprioritized compact grid images around it.
          priority={isHero ? 'high' : undefined}
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
        <Text
          style={[isHero ? styles.city : styles.cityCompact, { color: c.textSecondary }]}
          // Compact sits in a 2-up grid row where a sibling card's height
          // depends on this text — an unbounded city/state string (which
          // varies a lot, e.g. "Ocoyoacac (La Marquesa), Estado de México"
          // vs "Ciudad de México, Ciudad de México") was the main source of
          // ragged, mismatched card heights across a row. Hero is alone in
          // its row with no sibling to match, so it stays unbounded.
          numberOfLines={isHero ? undefined : 1}>
          {cityLabel}
        </Text>

        <View style={styles.tagRow}>
          {race.distanceTags.map((tag) => {
            const icon = distanceTagIcon(tag);
            return (
              <View key={tag} style={[styles.tag, { backgroundColor: c.backgroundSelected }]}>
                {icon && <Icon ios={icon.ios} android={icon.android} size={12} color={c.text} />}
                <Text style={[styles.tagText, { color: c.text }]}>
                  {t(distanceTagLabelKey(tag))}
                </Text>
              </View>
            );
          })}
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
    // A row's two flex:1 gridItem wrappers already stretch to match each
    // other's height (row containers cross-stretch by default) — but that
    // stretch only reaches the gridItem View itself, not this Pressable
    // inside it, unless this also claims the full height. Without this, a
    // card whose sibling has more text just left dead transparent space in
    // its own (taller) gridItem, while the two visible card backgrounds
    // ended at different heights. flex:1 here is a no-op in every other
    // usage (hero row, myraces.tsx's single-column list) since those have
    // no height-mismatched sibling to stretch against.
    flex: 1,
  },
  content: {
    padding: Spacing.three,
    gap: Spacing.one,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  // Stacked, not a row: at compact width, "20 SEP 2026" and "faltan 41 días"
  // side by side either wrapped mid-word or squeezed the date down to
  // nothing. One line each reads cleanly at any card width, so this isn't
  // variant-specific — hero has the room for a row too, but there's no
  // reason for it to look different from every other card.
  headerRow: {
    gap: 2,
    alignItems: 'flex-start',
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
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.two,
    paddingVertical: 3,
    borderRadius: GlassRadii.pill,
  },
  tagText: { fontSize: 12, fontWeight: '600' },
});
