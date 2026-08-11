// In-app "Buy ticket" bottom sheet — keeps the user inside the app instead of
// bouncing them to a browser tab. Native renders the sponsor checkout in a
// WebView; web renders an iframe (with an open-in-browser escape hatch, since
// some sponsor sites refuse to be framed).
//
// Motion (Jakub-weighted, production polish):
// - Enter: spring slide-up (dampingRatio 1 → no overshoot) + 250ms backdrop fade.
// - Exit: subtler and faster than enter — 220ms ease-in slide + 200ms fade.
// - Drag-to-dismiss on the header only (so it never fights checkout scrolling),
//   momentum-based (velocity OR distance), damped when over-dragged upward.
// - Loading: slim accent progress bar (functional feedback — external checkouts
//   can be slow and it should read as THEIR loading, not our app hanging).
//   Native drives it from real WebView progress; web has no iframe progress
//   events, so it trickles to 85% and completes on iframe load. Checkout
//   content fades in when loaded. Bar animates scaleX only (transform-safe).
// - Only transform/opacity are animated; reduced motion → instant.
import { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { WebView } from 'react-native-webview';

import { GlassButton } from '@/components/ui/glass-button';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Icon } from '@/components/ui/icon';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { isSafeUrl } from '@/lib/races';

const SHEET_RATIO = 0.9;
const DISMISS_DISTANCE_RATIO = 0.3;
const DISMISS_VELOCITY = 800; // px/s — fast short flicks should dismiss too

interface BuySheetProps {
  visible: boolean;
  url: string | null;
  title: string;
  onClose: () => void;
}

export function BuySheet({ visible, url, title, onClose }: BuySheetProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const { height: windowH } = useWindowDimensions();
  const sheetH = windowH * SHEET_RATIO;
  const reduced = useReducedMotion();

  // Keep the Modal mounted while the exit animation plays.
  const [mounted, setMounted] = useState(false);
  const translateY = useSharedValue(sheetH);
  const backdrop = useSharedValue(0);
  // Loading feedback: progress 0..1 (scaleX), bar fades out on completion,
  // checkout content fades in.
  const progress = useSharedValue(0);
  const barOpacity = useSharedValue(1);
  const contentOpacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translateY.value = sheetH;
      backdrop.value = 0;
      // Reset loading state for this open. A touch of initial progress reads
      // as "already working" instead of a dead bar.
      progress.value = 0;
      barOpacity.value = 1;
      contentOpacity.value = 0;
      progress.value = withTiming(0.12, { duration: reduced ? 0 : 200 });
      if (Platform.OS === 'web') {
        // No iframe progress events — trickle toward 85%, finish on onLoad.
        progress.value = withTiming(0.85, {
          duration: reduced ? 0 : 4000,
          easing: Easing.out(Easing.cubic),
        });
      }
      translateY.value = reduced
        ? withTiming(0, { duration: 0 })
        : withSpring(0, { duration: 500, dampingRatio: 1 });
      backdrop.value = withTiming(1, {
        duration: reduced ? 0 : 250,
        easing: Easing.out(Easing.quad),
      });
    } else if (mounted) {
      backdrop.value = withTiming(0, {
        duration: reduced ? 0 : 200,
        easing: Easing.out(Easing.quad),
      });
      translateY.value = withTiming(
        sheetH,
        { duration: reduced ? 0 : 220, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sheetH, reduced]);

  const close = useCallback(() => onClose(), [onClose]);

  // Drag lives on the header only, and the sheet is always settled (y = 0)
  // when a drag can begin, so translationY maps 1:1 to sheet offset.
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      // Over-drag upward is damped — real things resist past their boundary.
      translateY.value = e.translationY >= 0 ? e.translationY : e.translationY / 12;
    })
    .onEnd((e) => {
      const shouldDismiss =
        e.velocityY > DISMISS_VELOCITY || translateY.value > sheetH * DISMISS_DISTANCE_RATIO;
      if (shouldDismiss) {
        runOnJS(close)(); // parent flips `visible` → exit anim continues from here
      } else {
        translateY.value = withSpring(0, { duration: 350, dampingRatio: 1 });
      }
    });

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  const barStyle = useAnimatedStyle(() => ({
    opacity: barOpacity.value,
    transform: [{ scaleX: progress.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({ opacity: contentOpacity.value }));

  // Load finished (either platform): complete the bar, fade it out, reveal content.
  const onLoaded = useCallback(() => {
    progress.value = withTiming(1, { duration: reduced ? 0 : 180 });
    barOpacity.value = withDelay(
      reduced ? 0 : 350,
      withTiming(0, { duration: reduced ? 0 : 250 }),
    );
    contentOpacity.value = withTiming(1, {
      duration: reduced ? 0 : 300,
      easing: Easing.out(Easing.quad),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  if (!mounted || !url) return null;

  return (
    <Modal transparent statusBarTranslucent visible onRequestClose={close} animationType="none">
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            { height: sheetH, backgroundColor: c.background },
            sheetStyle,
          ]}>
          <GestureDetector gesture={pan}>
            <GlassSurface
              scheme={scheme}
              radius={0}
              noShadow
              style={[styles.header, { borderBottomColor: c.backgroundSelected }]}
              contentStyle={styles.headerContent}>
              <View style={[styles.grabber, { backgroundColor: c.backgroundSelected }]} />
              <View style={styles.headerRow}>
                <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
                  {title}
                </Text>
                <View style={styles.headerActions}>
                  {Platform.OS === 'web' && (
                    <GlassButton
                      scheme={scheme}
                      onPress={() => {
                        if (isSafeUrl(url)) Linking.openURL(url).catch(() => {});
                      }}
                      size={32}
                      radius={16}
                      accessibilityLabel={t('detail.openBrowser')}>
                      <Icon ios="arrow.up.right" android="open_in_new" size={14} color={c.text} />
                    </GlassButton>
                  )}
                  <GlassButton
                    scheme={scheme}
                    onPress={close}
                    size={32}
                    radius={16}
                    accessibilityLabel={t('detail.close')}>
                    <Icon ios="xmark" android="close" size={14} color={c.text} />
                  </GlassButton>
                </View>
              </View>
            </GlassSurface>
          </GestureDetector>

          {/* Slim loading bar pinned under the header. transformOrigin left so
              scaleX grows from the leading edge. */}
          <Animated.View
            style={[styles.progressBar, { backgroundColor: c.accent }, barStyle]}
          />

          <Animated.View style={[styles.contentWrap, contentStyle]}>
            {Platform.OS === 'web' ? (
              <iframe
                src={url}
                title={title}
                onLoad={onLoaded}
                // The framed page is a third-party sponsor checkout we don't
                // control. Without `sandbox` it can run `window.top.location =
                // ...` and replace the whole app with a page of its choosing —
                // a one-line hijack of every user who taps Buy. The grants
                // below are what a real checkout needs and nothing more;
                // crucially `allow-top-navigation` is NOT among them.
                //
                // `allow-scripts` + `allow-same-origin` is only the classic
                // sandbox-escape when the frame is same-origin with US (it
                // could then reach in and drop its own sandbox). These
                // checkouts are always cross-origin, and they need their own
                // origin for cookies/session, so the pair is correct here.
                sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer-when-downgrade"
                style={{ flex: 1, width: '100%', height: '100%', border: 0 }}
              />
            ) : (
              <WebView
                source={{ uri: url }}
                style={styles.web}
                // Native counterpart to the iframe sandbox. The checkout page
                // is third-party, so left alone it can navigate this WebView
                // anywhere — including `intent:` or a custom scheme, which on
                // Android hands control to another installed app. Confine it
                // to http(s); anything else is refused rather than followed.
                onShouldStartLoadWithRequest={(req) => isSafeUrl(req.url)}
                // Don't let a checkout page open arbitrary extra windows.
                setSupportMultipleWindows={false}
                onLoadProgress={(e) => {
                  // Real progress from the WebView — never move backwards.
                  const p = e.nativeEvent.progress;
                  if (p > progress.value) {
                    progress.value = withTiming(p, { duration: reduced ? 0 : 120 });
                  }
                }}
                onLoadEnd={onLoaded}
              />
            )}
          </Animated.View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    borderTopLeftRadius: GlassRadii.sheet,
    borderTopRightRadius: GlassRadii.sheet,
    overflow: 'hidden',
  },
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerContent: {
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: { flex: 1, fontSize: 15, fontWeight: '600' },
  headerActions: { flexDirection: 'row', gap: Spacing.one },
  progressBar: {
    height: 3,
    width: '100%',
    transformOrigin: 'left',
  },
  contentWrap: { flex: 1 },
  web: { flex: 1 },
});
