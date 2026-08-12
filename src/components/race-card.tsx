import { Alert, Pressable, StyleSheet, Text, View, useColorScheme, type ImageSourcePropType } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { ShimmerImage } from '@/components/ui/shimmer-image';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useCountdown, useI18n } from '@/lib/i18n';
import {
  abbreviateState,
  daysUntil,
  distanceTagLabelKey,
  formatDate,
  type Race,
} from '@/lib/races';
import { COMPACT_IMAGE_RATIO, HERO_IMAGE_RATIO } from '@/lib/region-art';
import { useSaved } from '@/lib/saved';

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
  const { isSaved, toggle } = useSaved();
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
  // Whether registration is actually reachable. 80 of 195 races have no
  // signup link, and that was only discoverable by opening the race and
  // reading a greyed-out button — a wasted tap on 40% of the catalog.
  const registrationOpen = Boolean(race.signupUrl) && race.status !== 'canceled';
  const registrationLabel = registrationOpen ? t('feed.regOpen') : t('detail.noLink');
  const accessibilityLabel = [race.name, displayDate, cityLabel, statusText, registrationLabel]
    .filter(Boolean)
    .join(', ');
  const isHero = variant === 'hero';
  const saved = isSaved(race.id);

  return (
    // The save button is a SIBLING of the card, not a child: the card sets
    // `accessible` so VoiceOver reads it as one race rather than five
    // fragments, and on iOS that collapses any nested touchable into the
    // group — a heart inside the card would be unreachable to a screen
    // reader. Overlaying it as a sibling keeps both independently focusable.
    <View style={styles.wrap}>
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
              {/* Capped: fixed pill sitting opposite the date in a tight
                  header row — uncapped Dynamic Type would crowd or wrap
                  against the date text rather than reflow the row. */}
              <Text style={styles.statusPillText} maxFontSizeMultiplier={1.3}>
                {statusText}
              </Text>
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
        <View style={isHero ? styles.cityRow : styles.cityRowCompact}>
          <Icon
            ios="mappin"
            android="location_on"
            size={isHero ? 13 : 12}
            color={c.textSecondary}
          />
          <Text
            style={[
              isHero ? styles.city : styles.cityCompact,
              { color: c.textSecondary },
              styles.cityText,
            ]}
            // Compact sits in a 2-up grid row where a sibling card's height
            // depends on this text — an unbounded city/state string (which
            // varies a lot, e.g. "Ocoyoacac (La Marquesa), Estado de México"
            // vs "Ciudad de México, Ciudad de México") was the main source of
            // ragged, mismatched card heights across a row. Hero is alone in
            // its row with no sibling to match, so it stays unbounded.
            // flexShrink (styles.cityText) keeps the Text from forcing the
            // row wider than its parent instead of truncating in place.
            numberOfLines={isHero ? undefined : 1}>
            {cityLabel}
          </Text>
        </View>

        <View style={styles.tagRow}>
          {race.distanceTags.map((tag) => (
            <View key={tag} style={[styles.tag, { backgroundColor: c.backgroundSelected }]}>
              <Text style={[styles.tagText, { color: c.text }]}>
                {t(distanceTagLabelKey(tag))}
              </Text>
            </View>
          ))}
        </View>

        {/* Registration state, on the card instead of one tap deeper. Only
            the "not open" case is called out: an open registration is the
            expectation, so badging it too would put a label on every card
            and say nothing. Canceled races already carry the status pill
            above, so they're excluded here rather than double-labeled. */}
        {!registrationOpen && race.status !== 'canceled' && (
          <Text style={[styles.regClosed, { color: c.textSecondary }]} numberOfLines={1}>
            {t('detail.noLink')}
          </Text>
        )}
      </View>
    </Pressable>

    <Pressable
      onPress={() => {
        // Same failure surfacing as the detail screen's save button: a write
        // that didn't persist must not read as a save that did.
        if (!toggle(race.id)) Alert.alert(t('detail.saveFailed'));
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: saved }}
      accessibilityLabel={`${saved ? t('detail.saved') : t('detail.save')}: ${race.name}`}
      hitSlop={10}
      style={({ pressed }) => [styles.saveBtn, pressed && styles.pressed]}>
      <Icon
        ios={saved ? 'heart.fill' : 'heart'}
        android={saved ? 'favorite' : 'favorite_border'}
        size={17}
        color="#ffffff"
      />
    </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Positioning context for the save button, and the flex:1 that the card
  // itself used to claim directly — a 2-up grid row stretches its two
  // children to equal height, and that child is now this wrapper.
  wrap: { flex: 1, position: 'relative' },
  // Pinned to the card's top-right, over the image when there is one. The
  // dark scrim keeps a white heart legible against arbitrary artwork, and
  // gives the button a visible target on the text-only cards (chih) where
  // there is no image behind it.
  saveBtn: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  regClosed: { fontSize: 12, fontWeight: '600', marginTop: Spacing.half },
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
  // Icon + label row. alignItems: 'center' keeps the row's own height
  // pinned to its tallest child (the text line) — no extra height beyond
  // what the bare Text used to take up, which matters for cityRowCompact
  // sitting in the 2-up grid's height-matched row (see the numberOfLines
  // comment below).
  cityRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.half },
  cityRowCompact: { flexDirection: 'row', alignItems: 'center', gap: Spacing.half },
  // flexShrink lets the Text truncate to numberOfLines={1} width-wise
  // instead of pushing the row wider than its container (RN Text defaults
  // to flexShrink: 0, unlike web flex items).
  cityText: { flexShrink: 1 },
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
