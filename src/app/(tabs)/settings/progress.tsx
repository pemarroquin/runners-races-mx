// Settings › park-path progress per municipio.
//
// Moved here from the Saved tab's third segment (2026-09-16, Pedro's ask,
// alongside collapsing Saved to two segments — Races and Conquested Areas).
// Same reasoning as History living in Settings rather than on the live
// Track map: this is a personal record ("how much of San Pedro's park
// paths have I run"), not something scored or contested, so it belongs
// beside History rather than fighting the Saved tab's map for space.
//
// MunicipioProgressList itself is unchanged — it still reads
// `myraces.progress*` i18n keys. That namespace is inherited from where the
// copy was first written, not from where it's read now, same convention as
// this screen's own SYNC_FAILURE_KEYS/DELETE_FAILURE_KEYS reusing `track.*`.
import { SettingsPage, useSettingsColors } from '@/components/settings-ui';
import { MunicipioProgressList } from '@/components/municipio-progress';

export default function ProgressScreen() {
  const { c } = useSettingsColors();
  return (
    <SettingsPage>
      <MunicipioProgressList c={c} />
    </SettingsPage>
  );
}
