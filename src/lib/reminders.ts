// Race reminders — local notifications only.
//
// No server, no push tokens, no accounts: everything here is scheduled by the
// OS on this device, which keeps reminders inside the same local-first,
// nothing-leaves-your-phone contract the rest of the app (and the privacy
// notice in Settings) already makes. It also means they work offline and need
// no Expo push credentials. Local scheduling is supported in Expo Go on both
// platforms, so this is testable on device today without a dev build.
//
// THE ONE PRIMITIVE IS `syncReminders`.
// Rather than incrementally add/remove a notification per save, every change
// re-derives the whole schedule from current state (saved ids x races x
// locale) and replaces it. That is what makes the hard cases fall out for
// free, instead of each needing its own code path:
//   - the race-watch routine moves a race's date -> reminders move with it
//   - a race is canceled or dropped from the catalog -> its reminders go away
//   - the user unsaves, or switches language -> rebuilt correctly
//   - reminders fire and lapse -> recomputed from scratch next launch
// It is idempotent, so calling it too often is only wasted work, never wrong.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getPref, initDb, setPref } from '@/lib/db';
import { daysUntil, formatDate, type Race } from '@/lib/races';
import { instantInZone, timeZoneForState } from '@/lib/time';

const PREF_ENABLED = 'remindersEnabled';

// Android delivers notifications through a channel; without one registered,
// a scheduled notification is accepted and then never shown. Registered once
// at module load rather than at schedule time so it is guaranteed to exist
// before the first scheduleNotificationAsync call.
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('race-reminders', {
    name: 'Race reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch((e) => console.warn('[reminders] channel setup failed', e));
}

// Without a handler, a notification that arrives while the app is in the
// FOREGROUND is silently dropped on both platforms — which reads as "the
// reminder never fired" in exactly the case a developer is most likely to be
// testing it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Tags our own notifications inside the OS's schedule, so a sync only ever
// cancels things this feature created.
const MARKER = 'racesmx.reminder';

/**
 * iOS keeps only the **64 soonest** pending local notifications per app and
 * silently discards the rest — so a user who saves 40 races would lose the
 * tail with no error anywhere. Staying well under that, and re-syncing on
 * every launch, means the nearest races are always scheduled and later ones
 * roll into the window as time passes.
 */
const MAX_SCHEDULED = 48;

/** Days before the race for the first reminder, and the hour it fires. */
const EARLY_DAYS_BEFORE = 3;
const EARLY_HOUR = '09:00';
/** The evening-before reminder — logistics, bag, alarm. */
const EVE_HOUR = '18:00';

/** Reminders are off until the user turns them on in Settings. */
export function remindersEnabled(): boolean {
  try {
    initDb();
    return getPref(PREF_ENABLED) === '1';
  } catch {
    return false;
  }
}

export function setRemindersEnabledPref(enabled: boolean): void {
  try {
    initDb();
    setPref(PREF_ENABLED, enabled ? '1' : '0');
  } catch {
    // Non-fatal: the toggle still applies for this session, it just won't
    // survive a cold start. Surfaced to the user by the caller, not here.
  }
}

/** True when the OS will actually deliver notifications for this app. */
export async function hasPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const { granted } = await Notifications.getPermissionsAsync();
    return granted;
  } catch {
    return false;
  }
}

/**
 * Ask for notification permission. Returns whether it was granted.
 *
 * Called only from the Settings toggle — i.e. the user has just asked for
 * reminders — so the OS prompt arrives with obvious context rather than
 * ambushing them at launch.
 */
export async function requestPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const { granted } = await Notifications.requestPermissionsAsync();
    return granted;
  } catch {
    return false;
  }
}

interface PlannedReminder {
  /** When it fires, as a real instant. */
  at: Date;
  title: string;
  body: string;
  raceId: string;
}

/**
 * The reminders a single race deserves, given "now".
 *
 * Times are resolved in the RACE's time zone, not the phone's — a runner in
 * Tijuana with a Cancún race saved should be reminded at 9am Cancún time,
 * which is the same reasoning (and the same helper) as the calendar fix.
 *
 * Exported for tests: this is pure, and it's where the off-by-one risks live.
 */
export function planRemindersFor(
  race: Race,
  today: string,
  now: Date,
  locale: string,
): PlannedReminder[] {
  // Nothing to remind about without a date, and nothing to say about a race
  // that is off.
  if (!race.date || race.status === 'canceled') return [];
  const days = daysUntil(race.date, today);
  if (days === null || days < 0) return [];

  const zone = timeZoneForState(race.state);
  const dateLabel = formatDate(race.date, locale) ?? race.date;
  const where = [race.venue, race.city].filter(Boolean).join(' · ');
  const es = locale === 'es';

  const planned: PlannedReminder[] = [];

  // Far enough out to still act on it — pick up a packet, book a bus, back
  // out. Fires in the morning rather than at the moment of scheduling.
  const [ey, em, ed] = race.date.split('-').map(Number);
  const early = new Date(Date.UTC(ey, em - 1, ed - EARLY_DAYS_BEFORE));
  const earlyDate = `${early.getUTCFullYear()}-${String(early.getUTCMonth() + 1).padStart(2, '0')}-${String(early.getUTCDate()).padStart(2, '0')}`;
  planned.push({
    at: instantInZone(earlyDate, EARLY_HOUR, zone),
    title: es
      ? `Faltan ${EARLY_DAYS_BEFORE} días: ${race.name}`
      : `${EARLY_DAYS_BEFORE} days to go: ${race.name}`,
    body: [dateLabel, where].filter(Boolean).join(' · '),
    raceId: race.id,
  });

  // The evening before — the one that actually gets someone to the start line.
  const [vy, vm, vd] = race.date.split('-').map(Number);
  const eve = new Date(Date.UTC(vy, vm - 1, vd - 1));
  const eveDate = `${eve.getUTCFullYear()}-${String(eve.getUTCMonth() + 1).padStart(2, '0')}-${String(eve.getUTCDate()).padStart(2, '0')}`;
  planned.push({
    at: instantInZone(eveDate, EVE_HOUR, zone),
    title: es ? `Mañana: ${race.name}` : `Tomorrow: ${race.name}`,
    // The start time is the thing you need the night before — but only 88 of
    // 195 races have one, so it's included when known and skipped when not
    // rather than invented (same rule as the calendar's all-day events).
    body: [race.time ? (es ? `Salida ${race.time}` : `Start ${race.time}`) : null, where]
      .filter(Boolean)
      .join(' · '),
    raceId: race.id,
  });

  // Drop any whose moment has already passed — saving a race two days out
  // must not try to schedule its 3-days-before reminder into the past.
  return planned.filter((p) => p.at.getTime() > now.getTime());
}

/**
 * Rebuild the entire notification schedule from current state.
 *
 * Safe to call whenever anything relevant changes; see the header for why
 * this is the only primitive. A no-op (after clearing) when reminders are
 * off, permission is missing, or we're on web.
 */
export async function syncReminders(
  races: Race[],
  savedIds: Set<string>,
  today: string,
  locale: string,
): Promise<number> {
  if (Platform.OS === 'web') return 0;

  try {
    // Clear only what this feature scheduled. There is nothing else
    // scheduling notifications in this app today, but cancelling everything
    // would be a booby trap for whatever is added next.
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      pending
        .filter((n) => n.content.data?.[MARKER] === true)
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
    );

    if (!remindersEnabled() || !(await hasPermission())) return 0;

    const now = new Date();
    const planned = races
      .filter((r) => savedIds.has(r.id))
      .flatMap((r) => planRemindersFor(r, today, now, locale))
      // Soonest first, so the MAX_SCHEDULED cap keeps the reminders that
      // matter next rather than an arbitrary subset.
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, MAX_SCHEDULED);

    for (const p of planned) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: p.title,
          body: p.body,
          data: { [MARKER]: true, raceId: p.raceId },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: p.at,
        },
      });
    }
    return planned.length;
  } catch (e) {
    // Never let a scheduling failure break a save or a refresh — but say so,
    // rather than swallowing it into a feature that looks identical whether
    // it works or not.
    console.warn('[reminders] sync failed', e);
    return 0;
  }
}

/** Cancel every reminder this feature scheduled. Used when switching off. */
export async function clearAllReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      pending
        .filter((n) => n.content.data?.[MARKER] === true)
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
    );
  } catch (e) {
    console.warn('[reminders] clear failed', e);
  }
}
