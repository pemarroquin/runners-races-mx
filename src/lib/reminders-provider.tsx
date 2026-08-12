// Keeps the OS notification schedule in step with app state.
//
// Everything routes through `syncReminders`, which rebuilds the whole
// schedule from scratch (see reminders.ts for why). This provider's only job
// is to notice when the inputs to that computation change and re-run it:
//
//   - saved races changed        (user saved/unsaved)
//   - race data changed          (race-watch moved a date, canceled a race)
//   - the day rolled over        (a reminder lapsed; later races move into range)
//   - locale changed             (content is localized at SCHEDULE time — the
//                                 OS fires a fixed string, so switching to
//                                 English has to rewrite the pending ones)
//   - the toggle changed         (turned on/off in Settings)
//
// Deliberately effect-driven off those values rather than called by hand at
// each site: a save happens in three places now (feed card, detail screen,
// My Races), and one forgotten call is a reminder that silently never fires.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useI18n } from '@/lib/i18n';
import { useRaces } from '@/lib/races-provider';
import {
  clearAllReminders,
  remindersEnabled as readEnabledPref,
  requestPermission,
  setRemindersEnabledPref,
  syncReminders,
} from '@/lib/reminders';
import { useSaved } from '@/lib/saved';
import { useToday } from '@/lib/today';

interface RemindersValue {
  enabled: boolean;
  /**
   * Turn reminders on or off. Turning on prompts for OS permission and
   * resolves false if the user declines, so the caller can explain rather
   * than leave a switch that flips back with no reason given.
   */
  setEnabled: (next: boolean) => Promise<boolean>;
}

const RemindersContext = createContext<RemindersValue | null>(null);

export function RemindersProvider({ children }: { children: ReactNode }) {
  // Read synchronously, like every other persisted pref in this app — an
  // effect would render the Settings switch in the wrong position first.
  const [enabled, setEnabledState] = useState(readEnabledPref);
  const races = useRaces();
  const { savedIds } = useSaved();
  const today = useToday();
  const { locale } = useI18n();

  // Guards against overlapping syncs: each one cancels then re-schedules, so
  // two in flight can interleave into a half-built schedule. A trailing flag
  // means the newest inputs always get a final pass.
  const runningRef = useRef(false);
  const pendingRef = useRef(false);

  const runSync = useCallback(async () => {
    if (runningRef.current) {
      pendingRef.current = true;
      return;
    }
    runningRef.current = true;
    try {
      await syncReminders(races, savedIds, today, locale);
    } finally {
      runningRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void runSync();
      }
    }
  }, [races, savedIds, today, locale]);

  useEffect(() => {
    if (!enabled) return;
    void runSync();
  }, [enabled, runSync]);

  const setEnabled = useCallback(async (next: boolean): Promise<boolean> => {
    if (!next) {
      setRemindersEnabledPref(false);
      setEnabledState(false);
      await clearAllReminders();
      return true;
    }
    // Ask first: writing the pref before knowing the answer would leave the
    // switch on with the OS silently dropping every notification.
    const granted = await requestPermission();
    if (!granted) return false;
    setRemindersEnabledPref(true);
    setEnabledState(true);
    // The effect above picks up `enabled` and schedules.
    return true;
  }, []);

  return (
    <RemindersContext.Provider value={{ enabled, setEnabled }}>
      {children}
    </RemindersContext.Provider>
  );
}

export function useReminders(): RemindersValue {
  const ctx = useContext(RemindersContext);
  if (!ctx) throw new Error('useReminders must be used within a RemindersProvider');
  return ctx;
}
