// Owns race data as React state (not module-level mutable state) so a
// refresh's new array identity is visible to React Compiler's auto-memoized
// dataflow — no hand-written cache-buster needed. Seeds from the bundled
// data, then the last-cached remote payload (if any) for a fast cold start,
// then refreshes over the network — on mount and whenever the app returns to
// the foreground after being backgrounded for a while.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  fetchRemoteRaces,
  loadCachedRaces,
  saveCachedRaces,
  SEED_RACES,
  sortRaces,
  type Race,
} from '@/lib/races';

type RefreshStatus = 'idle' | 'loading' | 'ok' | 'error';

interface RacesStatus {
  status: RefreshStatus;
  lastFetchedAt: number | null;
  refresh: () => void;
}

// Don't hammer the network just because the user flicked between apps —
// only refresh on foreground if it's been at least this long since the last
// successful (or attempted) fetch.
const MIN_FOREGROUND_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

const RacesDataContext = createContext<Race[]>(sortRaces(SEED_RACES));
const RacesStatusContext = createContext<RacesStatus>({
  status: 'idle',
  lastFetchedAt: null,
  refresh: () => {},
});

export function RacesProvider({ children }: { children: ReactNode }) {
  const [races, setRaces] = useState<Race[]>(() => sortRaces(SEED_RACES));
  const [status, setStatus] = useState<RefreshStatus>('idle');
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const refreshingRef = useRef(false);
  const lastFetchedAtRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(() => {
    if (refreshingRef.current) return; // already in flight — no-op
    refreshingRef.current = true;
    setStatus('loading');
    fetchRemoteRaces()
      .then((result) => {
        if (!aliveRef.current) return;
        if (result) {
          const sorted = sortRaces(result);
          setRaces(sorted);
          // Deferred, not inline: saveCachedRaces serializes ~200 KB of JSON
          // and does a synchronous SQLite write, both on the JS thread. Run
          // straight after a successful launch fetch, that lands right where
          // the feed is trying to paint its first frame. The in-memory state
          // above is already correct for this session; the cache only matters
          // to the NEXT cold start, so it can wait for an idle moment.
          setTimeout(() => saveCachedRaces(result), 0);
          setStatus('ok');
          const now = Date.now();
          lastFetchedAtRef.current = now;
          setLastFetchedAt(now);
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (aliveRef.current) setStatus('error');
      })
      .finally(() => {
        refreshingRef.current = false;
      });
  }, []);

  useEffect(() => {
    aliveRef.current = true;

    const cached = loadCachedRaces();
    if (cached) setRaces(sortRaces(cached));

    refresh();

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') return;
      const last = lastFetchedAtRef.current;
      if (last !== null && Date.now() - last < MIN_FOREGROUND_REFRESH_INTERVAL_MS) return;
      refresh();
    });

    return () => {
      aliveRef.current = false;
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; refresh is stable
  }, []);

  return (
    <RacesDataContext.Provider value={races}>
      <RacesStatusContext.Provider value={{ status, lastFetchedAt, refresh }}>
        {children}
      </RacesStatusContext.Provider>
    </RacesDataContext.Provider>
  );
}

/** All races, sorted by date ascending; undated races sink to the bottom. */
export function useRaces(): Race[] {
  return useContext(RacesDataContext);
}

/** Refresh lifecycle — status, when it last completed, and a manual trigger. */
export function useRacesStatus(): RacesStatus {
  return useContext(RacesStatusContext);
}
