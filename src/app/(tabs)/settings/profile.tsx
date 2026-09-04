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
import { getCachedDisplayName } from '@/lib/profile-cache';
import { DISPLAY_NAME_MAX, fetchMyProfile, updateDisplayName } from '@/lib/territory-sync';

export default function ProfileSettingsScreen() {
  const { c } = useSettingsColors();
  const { t } = useI18n();
  const isFocused = useIsFocused();

  // Seeded from the local cache so the field shows the runner's real name on
  // the FIRST paint. Before this, both of these started empty/'loading' and
  // only filled in once fetchMyProfile() came back — which on a phone took
  // long enough (~30s, reported 2026-09-04) that the screen read as blank and
  // then changed under you. The refetch below still runs and still wins; the
  // cache only decides what is on screen while it is in flight. See
  // profile-cache.ts.
  //
  // A lazy useState initializer, not a plain call: this reads storage, and
  // it must run once on mount rather than on every render.
  const [cachedName] = useState(() => getCachedDisplayName());
  const [displayName, setDisplayName] = useState(cachedName ?? '');
  const [nameState, setNameState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'failed' | 'off'>(
    // 'loading' makes the input read-only. With a cached name there is
    // something real to edit immediately, and a save started before the
    // refetch lands is safe — updateDisplayName is an upsert of whatever the
    // field holds, and the refetch's own guard below refuses to overwrite a
    // field the runner has touched.
    cachedName === null ? 'loading' : 'ready',
  );
  // The last value this screen actually confirmed with the server — via a
  // fetch or a successful save. saveName() below diffs `displayName`
  // against this to become a no-op when nothing changed, and the
  // refetch-on-focus effect uses it to tell "the runner hasn't touched the
  // field since we last synced it" (safe to adopt the fetched value) apart
  // from "the runner is mid-edit" (must not clobber what they're typing). A
  // ref, not state: it's read inside a setState updater and inside an
  // async callback, and must never itself trigger a re-render.
  // Seeded from the cache too, and it has to be: the refetch adopts a
  // fetched value only when the field still equals this. Left at '' while
  // the field showed a cached name, every refetch would look like "the
  // runner is mid-edit" and never reconcile.
  const lastSyncedName = useRef(cachedName ?? '');

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
