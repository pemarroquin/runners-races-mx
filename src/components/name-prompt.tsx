// Self-contained "pick a leaderboard name" prompt, shown once — at the
// moment a run's first save succeeds, never on first app open (a first-time
// runner who just wants to look around should never be gated by this).
//
// Fully self-contained: mount it (no props) wherever a successful save is
// rendered and it decides everything else for itself — whether a name is
// already set, whether it has already been asked-and-skipped, whether
// Territory Mode is even configured in this build. The host only decides
// WHEN to mount it; it never blocks or delays the save it rides on top of.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';

import { GlassSurface } from '@/components/ui/glass-surface';
import { GlassRadii } from '@/constants/glass';
import { Colors, Spacing } from '@/constants/theme';
import { getPref, initDb, setPref } from '@/lib/db';
import { useI18n } from '@/lib/i18n';
import { DISPLAY_NAME_MAX, fetchMyProfile, updateDisplayName } from '@/lib/territory-sync';

// Same prefs store as theme/locale/privacy-zone (db.ts / db.web.ts) — see
// home-point.ts for the pattern this follows. A browser that blocks storage
// degrades to "never marked asked", which reads as "ask again next save",
// not as a crash — acceptable since Skip/Save both stay one tap away and
// the prompt never blocks anything.
const PREF_NAME_PROMPT_ASKED = 'namePromptAsked';

type PromptState =
  | 'checking' // deciding whether to show anything at all
  | 'hidden' // decided: nothing to show (named already / already asked / disabled / fetch failed)
  | 'ask' // showing the form
  | 'saving'
  | 'failed' // the write failed — form stays up so the runner can retry or skip
  | 'done'; // name saved — dismissing

export function NamePrompt() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const c = Colors[scheme];
  const { t } = useI18n();

  const [state, setState] = useState<PromptState>('checking');
  const [name, setName] = useState('');

  // Runs once, on mount — the host only mounts this component right after a
  // run finishes saving, so "on mount" IS "at the moment of first save".
  useEffect(() => {
    let stale = false;
    // Deferred so no setState runs synchronously in the effect body (same
    // pattern as settings.tsx's own profile fetch).
    const id = setTimeout(() => {
      initDb();
      const alreadyAsked = getPref(PREF_NAME_PROMPT_ASKED) === '1';
      if (alreadyAsked) {
        if (!stale) setState('hidden');
        return;
      }
      fetchMyProfile().then((outcome) => {
        if (stale) return;
        // 'disabled' (no server configured), 'auth'/'network' (can't tell
        // right now), or a name already set — none of those are "ask".
        // Fetch failures fail CLOSED: stay quiet rather than nag on top of
        // a run the runner just finished.
        if (outcome.ok && outcome.displayName === null) {
          setState('ask');
        } else {
          setState('hidden');
        }
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, []);

  const markAsked = useCallback(() => {
    // Best-effort: a blocked store just means this device gets asked again
    // next save, which is a nag, not a data-loss bug.
    initDb();
    setPref(PREF_NAME_PROMPT_ASKED, '1');
  }, []);

  const skip = useCallback(() => {
    markAsked();
    setState('done');
  }, [markAsked]);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return; // Save is disabled in this case; belt and suspenders
    setState('saving');
    const outcome = await updateDisplayName(trimmed);
    if (outcome.ok) {
      markAsked();
      setState('done');
    } else {
      // Honest failure — never close as if it worked.
      setState('failed');
    }
  }, [name, markAsked]);

  if (state === 'checking' || state === 'hidden' || state === 'done') return null;

  const trimmedLen = name.trim().length;
  const canSave = trimmedLen > 0 && state !== 'saving';

  return (
    <Animated.View entering={FadeInDown.duration(320)} exiting={FadeOutUp.duration(200)}>
      <GlassSurface scheme={scheme} radius={GlassRadii.card} contentStyle={styles.card}>
        <Text style={[styles.title, { color: c.text }]}>{t('settings.namePromptTitle')}</Text>
        <Text style={[styles.body, { color: c.textSecondary }]}>{t('settings.namePromptBody')}</Text>

        <TextInput
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => {
            if (canSave) void save();
          }}
          editable={state !== 'saving'}
          maxLength={DISPLAY_NAME_MAX}
          placeholder={t('settings.displayNamePlaceholder')}
          placeholderTextColor={c.textSecondary}
          returnKeyType="done"
          autoCapitalize="words"
          autoFocus
          accessibilityLabel={t('settings.namePromptTitle')}
          style={[styles.input, { backgroundColor: c.backgroundElement, color: c.text }]}
        />
        {/* Makes the DISPLAY_NAME_MAX cap visible rather than letting a
            pasted long name get silently cut at the input's own maxLength
            with no explanation. */}
        <Text style={[styles.counter, { color: c.textSecondary }]}>
          {trimmedLen}/{DISPLAY_NAME_MAX}
        </Text>

        {state === 'failed' && (
          <Text style={[styles.error, { color: c.accent }]}>{t('settings.namePromptFailed')}</Text>
        )}

        <View style={styles.actions}>
          <Pressable
            onPress={skip}
            disabled={state === 'saving'}
            accessibilityRole="button"
            hitSlop={10}
            style={styles.skipButton}>
            <Text style={[styles.skipLabel, { color: c.textSecondary, opacity: state === 'saving' ? 0.5 : 1 }]}>
              {t('settings.namePromptSkip')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void save()}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSave }}
            style={[styles.saveButton, { backgroundColor: c.accent, opacity: canSave ? 1 : 0.4 }]}>
            {state === 'saving' && <ActivityIndicator color="#ffffff" style={styles.spinner} />}
            <Text style={styles.saveLabel}>
              {state === 'saving' ? t('settings.namePromptSaving') : t('settings.namePromptSave')}
            </Text>
          </Pressable>
        </View>
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { padding: Spacing.four, gap: Spacing.two },
  title: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 20 },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    marginTop: Spacing.one,
  },
  counter: { fontSize: 11, alignSelf: 'flex-end', marginTop: -Spacing.one },
  error: { fontSize: 13, lineHeight: 18 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.four,
    marginTop: Spacing.one,
  },
  skipButton: { paddingVertical: Spacing.two, paddingHorizontal: Spacing.one },
  skipLabel: { fontSize: 15, fontWeight: '600' },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderRadius: GlassRadii.pill,
    minWidth: 100,
  },
  saveLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  spinner: { marginRight: Spacing.one },
});
