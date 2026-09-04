// Confirms an email-link sign-in/link that just completed via a redirect —
// the piece account.ts's own header always assumed would exist ("no
// deep-link/callback route to land on") and that this app never actually
// had, back when the plan was "OTP codes only, never a magic-link click."
// That plan broke against a real constraint: Supabase's hosted email
// templates cannot be edited to show a code without paid custom SMTP, so
// the email a runner actually receives is a link regardless of what this
// app's UI was built to expect. supabase.ts's `detectSessionInUrl: true`
// now lets the client finish what that link starts; this component is what
// tells the runner it happened, since nothing else on screen would.
//
// Mounted once, at the root layout, ABOVE the Stack — not inside Settings,
// because the redirect can land the runner on ANY route (GoTrue's default
// is Site URL, i.e. the app's root) and the confirmation has to be visible
// regardless of which screen that resolves to.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { emailLinkType, ensureSession } from '@/lib/supabase';

export function EmailLinkBanner() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();
  const [email, setEmail] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Nothing to show on a normal load — the overwhelmingly common case,
    // checked first so this never awaits a session round trip for no
    // reason.
    if (emailLinkType === null) return;
    let cancelled = false;
    // ensureSession() resolves only once the client's own async
    // detectSessionInUrl work has finished (getSession() awaits the
    // client's initialize() internally) — so by the time this returns,
    // the session really does reflect what the link just did, not
    // whatever existed on the page before it loaded.
    ensureSession().then((session) => {
      if (!cancelled && session?.user.email) setEmail(session.user.email);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (email === null || dismissed) return null;

  // 'magiclink' is the ONLY type that replaces the device's prior local
  // session (account.ts's SIGN IN path) — every other type GoTrue issues
  // for this app's two flows ('signup', 'email_change') is the LINK path,
  // upgrading the same identity in place. See supabase.ts's emailLinkType
  // for the full reasoning.
  const swapped = emailLinkType === 'magiclink';
  const message = t(swapped ? 'settings.accountLinkedSwapped' : 'settings.accountLinked', { email });

  return (
    <SafeAreaView style={styles.safe} edges={['top']} pointerEvents="box-none">
      <Animated.View
        entering={FadeInDown.duration(320)}
        exiting={FadeOutUp.duration(220)}
        style={[styles.card, { backgroundColor: c.backgroundElement, borderColor: c.accent }]}>
        <Text style={[styles.text, { color: c.text }]}>{message}</Text>
        <Pressable
          onPress={() => setDismissed(true)}
          accessibilityRole="button"
          hitSlop={10}
          style={styles.dismiss}>
          <Text style={[styles.dismissText, { color: c.textSecondary }]}>×</Text>
        </Pressable>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Overlays the app the same way CinematicSplash does (root layout,
  // rendered after the Stack) — pointerEvents box-none so it never blocks
  // touches on whatever's underneath outside the card itself.
  safe: { position: 'absolute', top: 0, left: 0, right: 0 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    marginHorizontal: Spacing.three,
    marginTop: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
    borderWidth: 1,
  },
  text: { flex: 1, fontSize: 14, lineHeight: 20 },
  dismiss: { padding: Spacing.half },
  dismissText: { fontSize: 20, lineHeight: 20 },
});
