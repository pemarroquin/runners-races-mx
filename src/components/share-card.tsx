// A shareable "route sticker" + "stats card", copyable straight to the
// system clipboard so a runner can paste them into an Instagram Story with
// no extra app hop. Two SEPARATE transparent PNGs, matching how Strava's own
// share sheet splits a route shape from its stat block — a runner drops one
// or both onto whatever photo they're already posting, rather than being
// handed one fixed composited image they can't rearrange.
//
// Deliberately clipboard-copy, not the native "Share to Instagram Story"
// button (Instagram's own Content Sharing API, iOS-only, needs a registered
// Meta developer app + LSApplicationQueriesSchemes). That native flow needs
// a custom dev client the same way locked-screen GPS recording and native
// map parity do (see the Expo Go Ceiling memory) — this app runs on Expo Go
// only, so clipboard-copy is the one path that ships without leaving it.
//
// No react-native-view-shot either: react-native-svg's own <Svg> exposes
// toDataURL(callback, { width, height }) on its ref, which rasterizes at
// WHATEVER size is asked for, independent of the component's on-screen
// layout size (see the Android/iOS native modules — both re-render the SVG
// into a bitmap of the requested bounds). That's what lets one <Svg> serve
// as both the small on-screen preview and the high-res export with no
// hidden duplicate view and no native module Expo Go doesn't already bundle
// (react-native-svg is in Expo's bundledNativeModules.json at this exact
// pinned version).
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import { Colors, Spacing, type ThemeColor } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { routeToSvgPath } from '@/lib/route-shape';
import type { LatLng } from '@/lib/territory';
import { formatDistance, formatDuration, formatPace } from '@/lib/tracking';

export interface ShareSessionData {
  route: LatLng[];
  distanceM: number;
  durationS: number;
  tiles: number;
}

// A vibrant, ANIMATED gradient — deliberately NOT this run's own
// fenceColorForRun colour. That per-run colour is chosen from a 6-hue set
// (constants/map.ts) specifically to stay distinguishable at low saturation
// on a map next to five OTHER runners' fences; a gradient sharing an anchor
// with the run's colour risks a same-colour degenerate gradient for
// whichever hue happens to match, and reads flat instead of vibrant either
// way. This is the sticker's own signature look, same in every session.
//
// The three stops keep a fixed 40°/40° hue spacing and cycle together
// through the colour wheel while the sheet is open — see the baseHue/
// frozenHue state below. Tapping Copy freezes it at whatever instant the
// runner tapped, which is the point: closing the sheet and reopening it
// (Pedro's own "discard and retry") restarts the cycle from 0°, so a retry
// lands on a genuinely different frozen colour, not a fixed palette.
const ROUTE_GRADIENT_ID = 'shareRouteGradient';
const STOP_POSITIONS = ['0%', '55%', '100%'];
const STOP_HUE_OFFSETS = [0, 40, 80];
const GRADIENT_SATURATION = 90;
const GRADIENT_LIGHTNESS = 60;
const HUE_STEP_DEG = 3;
const HUE_TICK_MS = 50; // 360° / 3° every 50ms ≈ a 6s full cycle.

/** HSL → '#rrggbb'. h in degrees (any range, wrapped), s/l in 0-100. */
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Virtual units the shapes are drawn in — <Svg>'s own viewBox scaling means
// these never have to match the on-screen OR the exported pixel size; only
// their ratio to each other matters. Keeping the drawing code in one small
// coordinate space is what makes the same markup serve a 96px preview and a
// ~1000px export with zero duplication.
const ROUTE_VB = 300;
const ROUTE_PADDING = 34;
const STATS_VB_W = 300;
const STATS_VB_H = 108;

// Export resolution, independent of anything on screen (see toDataURL's
// options above). Big enough to read cleanly once dropped into a 1080-wide
// Instagram Story and resized.
const EXPORT_W = 1080;
const ROUTE_EXPORT_H = EXPORT_W;
const STATS_EXPORT_H = Math.round((EXPORT_W * STATS_VB_H) / STATS_VB_W);

const PREVIEW_SIZE = 180;
const STATS_PREVIEW_W = 260;
const STATS_PREVIEW_H = Math.round((STATS_PREVIEW_W * STATS_VB_H) / STATS_VB_W);

type CardKind = 'route' | 'stats';

export function ShareSheet({
  visible,
  onClose,
  data,
}: {
  visible: boolean;
  onClose: () => void;
  data: ShareSessionData | null;
}) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  const routeRef = useRef<Svg>(null);
  const statsRef = useRef<Svg>(null);
  // Which card was most recently copied, for the label-swap confirmation
  // (same pattern as identity-diagnostic.tsx's Copy button) — null clears
  // whenever the sheet is closed/reopened rather than lingering on a stale
  // session's confirmation.
  const [copied, setCopied] = useState<CardKind | null>(null);
  // Copy is NOT fire-and-forget: setImageAsync is awaited and only flips
  // `copied` on an actual resolve. A clipboard write can fail (unsupported
  // platform, permission), and showing "Copied" regardless would be exactly
  // the unverified-success this codebase's own rule exists to catch — the
  // runner pastes into Instagram and gets nothing, with no clue why.
  const [failed, setFailed] = useState<CardKind | null>(null);

  // The route gradient's live hue, advancing on a timer — see the constant
  // block above. `frozenHue` is null while animating; the route Copy button
  // sets it to whatever `baseHue` currently is, which both stops the tick
  // (the effect below is gated on `frozenHue === null`) and fixes the
  // colour the export captures.
  const [baseHue, setBaseHue] = useState(0);
  const [frozenHue, setFrozenHue] = useState<number | null>(null);

  // Opening the sheet always starts a fresh cycle from 0° — this is what
  // makes closing and reopening ("discard and retry") land on a different
  // frozen colour next time, rather than resuming wherever it left off.
  // Deferred a tick, not called straight from the effect body — same React
  // Compiler rule (and same fix) as index.tsx's checkpoint-load effect.
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => {
      setBaseHue(0);
      setFrozenHue(null);
    }, 0);
    return () => clearTimeout(id);
  }, [visible]);

  useEffect(() => {
    if (!visible || frozenHue !== null) return;
    const id = setInterval(() => setBaseHue((h) => (h + HUE_STEP_DEG) % 360), HUE_TICK_MS);
    return () => clearInterval(id);
  }, [visible, frozenHue]);

  const routeStopColors = useMemo(() => {
    const hue = frozenHue ?? baseHue;
    return STOP_HUE_OFFSETS.map((offset) => hslToHex(hue + offset, GRADIENT_SATURATION, GRADIENT_LIGHTNESS));
  }, [frozenHue, baseHue]);

  const routeShape = useMemo(
    () => routeToSvgPath(data?.route ?? [], ROUTE_VB, ROUTE_VB, ROUTE_PADDING),
    [data],
  );

  const distance = data ? formatDistance(data.distanceM) : '';
  const pace = data ? (formatPace(data.distanceM, data.durationS) ?? '—') : '';
  const time = data && data.durationS > 0 ? formatDuration(data.durationS) : '—';
  const tiles = data ? String(data.tiles) : '';

  const copy = useCallback((kind: CardKind) => {
    const ref = kind === 'route' ? routeRef : statsRef;
    const size = kind === 'route' ? ROUTE_EXPORT_H : STATS_EXPORT_H;
    setFailed((prev) => (prev === kind ? null : prev));
    // Freeze the gradient at THIS instant before rasterizing, so the
    // exported bitmap matches exactly what was on screen when the runner
    // tapped — see baseHue/frozenHue above.
    if (kind === 'route') setFrozenHue((prev) => prev ?? baseHue);
    ref.current?.toDataURL(
      (base64) => {
        Clipboard.setImageAsync(base64)
          .then(() => setCopied(kind))
          .catch(() => setFailed(kind));
      },
      { width: EXPORT_W, height: size },
    );
  }, [baseHue]);

  const close = useCallback(() => {
    setCopied(null);
    setFailed(null);
    onClose();
  }, [onClose]);

  if (!data) return null;

  return (
    <Modal transparent visible={visible} onRequestClose={close} animationType="fade">
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" />
        <View style={[styles.sheet, { backgroundColor: c.background }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: c.text }]}>{t('share.title')}</Text>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={10}>
              <Icon ios="xmark" android="close" size={18} color={c.textSecondary} />
            </Pressable>
          </View>

          {routeShape.empty ? (
            <Text style={[styles.emptyNotice, { color: c.textSecondary }]}>{t('share.emptyRoute')}</Text>
          ) : (
            <Card label={t('share.routeLabel')} c={c}>
              <View style={styles.checker}>
                <Svg ref={routeRef} width={PREVIEW_SIZE} height={PREVIEW_SIZE} viewBox={`0 0 ${ROUTE_VB} ${ROUTE_VB}`}>
                  <Defs>
                    {/* objectBoundingBox (the default) so the diagonal runs
                        corner-to-corner of the PATH's own drawn bounds,
                        whatever shape the route happens to be — not the
                        square canvas, which would leave a straight-line
                        route (spanning only one axis) with a gradient that
                        never reaches its second or third stop. */}
                    <LinearGradient id={ROUTE_GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
                      {STOP_POSITIONS.map((offset, i) => (
                        <Stop key={offset} offset={offset} stopColor={routeStopColors[i]} />
                      ))}
                    </LinearGradient>
                  </Defs>
                  {/* Outline only — no start/end markers. This PNG is meant
                      to drop onto an arbitrary Instagram photo as a sticker;
                      a pin fixed at the route's own start/end would usually
                      land somewhere meaningless on whatever photo it's
                      dropped onto, unlike on the app's own maps where the
                      pin sits on real ground. */}
                  <Path
                    d={routeShape.d}
                    stroke={`url(#${ROUTE_GRADIENT_ID})`}
                    strokeWidth={8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </Svg>
              </View>
              <CopyButton
                copied={copied === 'route'}
                failed={failed === 'route'}
                onPress={() => copy('route')}
                c={c}
                t={t}
              />
            </Card>
          )}

          <Card label={t('share.statsLabel')} c={c}>
            <View style={styles.checker}>
              <Svg
                ref={statsRef}
                width={STATS_PREVIEW_W}
                height={STATS_PREVIEW_H}
                viewBox={`0 0 ${STATS_VB_W} ${STATS_VB_H}`}>
                <Rect x={0} y={0} width={STATS_VB_W} height={STATS_VB_H} rx={14} fill="rgba(20,20,20,0.65)" />
                <SvgText
                  x={STATS_VB_W / 2}
                  y={20}
                  fontSize={12}
                  fontWeight="700"
                  fill="#FFFFFF"
                  textAnchor="middle">
                  Runners&apos; Races MX
                </SvgText>
                <StatColumn x={37.5} label={t('track.distance')} value={distance} />
                <StatColumn x={112.5} label={t('track.pace')} value={pace} />
                <StatColumn x={187.5} label={t('track.time')} value={time} />
                <StatColumn x={262.5} label={t('track.tiles')} value={tiles} />
              </Svg>
            </View>
            <CopyButton
              copied={copied === 'stats'}
              failed={failed === 'stats'}
              onPress={() => copy('stats')}
              c={c}
              t={t}
            />
          </Card>

          <Text style={[styles.hint, { color: c.textSecondary }]}>{t('share.hint')}</Text>
        </View>
      </View>
    </Modal>
  );
}

function StatColumn({ x, label, value }: { x: number; label: string; value: string }) {
  return (
    <>
      <SvgText x={x} y={50} fontSize={9} fill="rgba(255,255,255,0.75)" textAnchor="middle">
        {label}
      </SvgText>
      <SvgText x={x} y={78} fontSize={15} fontWeight="700" fill="#FFFFFF" textAnchor="middle">
        {value}
      </SvgText>
    </>
  );
}

function Card({
  label,
  c,
  children,
}: {
  label: string;
  c: Record<ThemeColor, string>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Text style={[styles.cardLabel, { color: c.textSecondary }]}>{label}</Text>
      {children}
    </View>
  );
}

function CopyButton({
  copied,
  failed,
  onPress,
  c,
  t,
}: {
  copied: boolean;
  failed: boolean;
  onPress: () => void;
  c: Record<ThemeColor, string>;
  t: (key: string) => string;
}) {
  return (
    <View style={styles.copyWrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={[styles.copyButton, { backgroundColor: c.accent }]}>
        <Icon ios="doc.on.doc" android="content_copy" size={15} color="#FFFFFF" />
        <Text style={styles.copyLabel}>{copied ? t('share.copied') : t('share.copy')}</Text>
      </Pressable>
      {failed && <Text style={[styles.copyFailed, { color: c.accent }]}>{t('share.copyFailed')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: '700' },
  card: { alignItems: 'center', gap: Spacing.two },
  cardLabel: { fontSize: 13, fontWeight: '600', alignSelf: 'flex-start' },
  // A checkerboard-free transparent preview would be invisible against the
  // sheet's own background — a mid-grey backdrop here (display only, never
  // exported) is what lets a transparent PNG's edges actually read as
  // transparent, same reason Strava's own share sheet shows one.
  checker: {
    backgroundColor: '#8A8A8A',
    borderRadius: Spacing.two,
    overflow: 'hidden',
  },
  copyWrap: { alignItems: 'center', gap: Spacing.one },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: 999,
  },
  copyLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  copyFailed: { fontSize: 12 },
  emptyNotice: { fontSize: 14, textAlign: 'center', paddingVertical: Spacing.three },
  hint: { fontSize: 12, textAlign: 'center' },
});
