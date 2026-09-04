// Settings › Profile — the name shown on the territory leaderboard.
//
// Moved out of the old single-file settings screen unchanged: same
// refetch-on-focus effect, same lastSyncedName dirty check, same save-on-blur.
// `useIsFocused` now means "this sub-page is on top of the settings stack"
// rather than "the settings tab is selected", which is if anything a tighter
// fit for the reason the effect exists — NamePrompt (the run-summary flow)
// can write display_name from off-screen while this screen stays mounted.
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { SettingsPage, settingsStyles, useSettingsColors } from '@/components/settings-ui';
import { useI18n } from '@/lib/i18n';
import { DISPLAY_NAME_MAX, fetchMyProfile, updateDisplayName } from '@/lib/territory-sync';

export default function ProfileSettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();
  const isFocused = useIsFocused();

  // Null until the runner picks one — the board falls back to "Anónimo"
  // rather than exposing anything from the anonymous identity.
  const [displayName, setDisplayName] = useState('');
  const [nameState, setNameState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed' | 'off'>(
    'loading',
  );
  // The last value this screen actually confirmed with the server — via a
  // fetch or a successful save. saveName() below diffs `displayName`
  // against this to become a no-op when nothing changed, and the
  // refetch-on-focus effect uses it to tell "the runner hasn't touched the
  // field since we last synced it" (safe to adopt the fetched value) apart
  // from "the runner is mid-edit" (must not clobber what they're typing). A
  // ref, not state: it's read inside a setState updater and inside an
  // async callback, and must never itself trigger a re-render.
  const lastSyncedName = useRef('');

  // Re-fetch on every focus, not once on mount: NamePrompt can write
  // display_name from off-screen while this screen stays mounted (expo-router
  // keeps screens alive; there's no unmountOnBlur/freezeOnBlur anywhere in
  // this app), so a mount-only fetch would keep showing the stale value after
  // that. The functional setDisplayName below only adopts the fetched value
  // when the field still matches what was last synced — if the runner has
  // since typed something new, a refetch landing mid-edit must not overwrite
  // it.
  useEffect(() => {
    if (!isFocused) return;
    let stale = false;
    // Deferred so no setState runs synchronously in the effect body.
    const id = setTimeout(() => {
      fetchMyProfile().then((outcome) => {
        if (stale) return;
        if (outcome.ok) {
          const fetched = outcome.displayName ?? '';
          setDisplayName((prev) => (prev === lastSyncedName.current ? fetched : prev));
          lastSyncedName.current = fetched;
          // Don't stomp a save that's currently in flight.
          setNameState((prev) => (prev === 'saving' ? prev : 'ready'));
        } else {
          // 'disabled' is a build configuration, not a failure — hide the
          // field entirely rather than showing one that can't save.
          setNameState(outcome.reason === 'disabled' ? 'off' : 'failed');
        }
      });
    }, 0);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [isFocused]);

  // Saved on blur rather than per keystroke: one write when the runner is
  // done, instead of a request per character. Dirty-checked against
  // lastSyncedName so a blur/submit on a field the runner merely tapped
  // into and back out of is a no-op, not a write — onBlur/onSubmitEditing
  // fire unconditionally, and this screen can go stale while mounted (see
  // the refetch effect above), so without this check that no-op tap can
  // silently overwrite a name set from elsewhere with a stale local value.
  const saveName = useCallback(async () => {
    if (nameState === 'off' || nameState === 'loading') return;
    if (displayName === lastSyncedName.current) return;
    setNameState('saving');
    const outcome = await updateDisplayName(displayName);
    // Sync to the server-confirmed value (trimmed/nulled server-side), not
    // the raw input, so the next dirty-check compares against the truth.
    if (outcome.ok) lastSyncedName.current = outcome.displayName ?? '';
    setNameState(outcome.ok ? 'saved' : 'failed');
  }, [displayName, nameState]);

  // A build with no server configured has no name that can save. The row
  // leading here is already hidden in that case (see ./index.tsx); this is
  // the belt-and-braces for a direct /settings/profile URL on web.
  if (nameState === 'off') return <SettingsPage>{null}</SettingsPage>;

  return (
    <SettingsPage>
      <View style={settingsStyles.block}>
        <Text style={[settingsStyles.label, { color: c.textSecondary }]}>
          {t('settings.displayName')}
        </Text>
        <TextInput
          value={displayName}
          onChangeText={(next) => {
            setDisplayName(next);
            if (nameState === 'saved' || nameState === 'failed') setNameState('ready');
          }}
          onBlur={saveName}
          onSubmitEditing={saveName}
          editable={nameState !== 'loading' && nameState !== 'saving'}
          maxLength={DISPLAY_NAME_MAX}
          placeholder={t('settings.displayNamePlaceholder')}
          placeholderTextColor={c.textSecondary}
          returnKeyType="done"
          autoCapitalize="words"
          accessibilityLabel={t('settings.displayName')}
          style={[settingsStyles.input, { backgroundColor: c.backgroundElement, color: c.text }]}
        />
        <Text style={[settingsStyles.hint, { color: c.textSecondary }]}>
          {nameState === 'failed'
            ? t('settings.displayNameFailed')
            : nameState === 'saved'
              ? t('settings.displayNameSaved')
              : t('settings.displayNameHint')}
        </Text>
      </View>
    </SettingsPage>
  );
}
