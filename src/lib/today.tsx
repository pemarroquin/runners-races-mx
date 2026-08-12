// The current calendar day, as React state.
//
// Everything date-shaped in this app — `daysUntil`, the countdown on every
// card, the feed's "past races are hidden" rule, the "this week" carousel —
// derives from `new Date()` read at render time. Nothing re-rendered when the
// date itself changed, so an app left open overnight kept yesterday's answers:
// on race morning the detail screen could still read "falta 1 día", and a race
// that had just finished stayed in the feed.
//
// Exposing today as context state gives those memos something to depend on
// that actually changes at midnight.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/** `YYYY-MM-DD` for a Date in local time (not toISOString, which is UTC). */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const TodayContext = createContext<string>(localDayKey(new Date()));

export function TodayProvider({ children }: { children: ReactNode }) {
  const [today, setToday] = useState(() => localDayKey(new Date()));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Re-arms itself for the next local midnight rather than polling. A
    // single long timer is enough — but it is NOT trusted on its own: on
    // native, timers are unreliable across a suspended app, which is exactly
    // the "left open overnight" case this exists for. The AppState listener
    // below is the belt to this suspenders.
    function scheduleNextMidnight() {
      if (timerRef.current) clearTimeout(timerRef.current);
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        5, // a few seconds past, so a fast timer can't land on the wrong side
      );
      timerRef.current = setTimeout(() => {
        if (cancelled) return;
        setToday(localDayKey(new Date()));
        scheduleNextMidnight();
      }, nextMidnight.getTime() - now.getTime());
    }

    scheduleNextMidnight();

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') return;
      // Cheap and idempotent: setState with an unchanged string is a no-op,
      // so this only causes a render on a day that actually rolled over.
      setToday(localDayKey(new Date()));
      scheduleNextMidnight();
    });

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      sub.remove();
    };
  }, []);

  return <TodayContext.Provider value={today}>{children}</TodayContext.Provider>;
}

/**
 * Today's local date as `YYYY-MM-DD`, changing at midnight.
 *
 * Use it as a memo dependency anywhere a computation reads the current date,
 * so the result is recomputed when the day rolls over.
 */
export function useToday(): string {
  return useContext(TodayContext);
}
