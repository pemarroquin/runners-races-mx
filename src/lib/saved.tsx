// App-wide saved-races state, backed by SQLite on native and localStorage on
// web. Reads the store once during the first render and keeps an in-memory Set
// for fast isSaved() checks in the feed and detail screens.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { getSavedIds, getStorageError, initDb, removeRace, saveRace } from '@/lib/db';

interface SavedValue {
  savedIds: Set<string>;
  isSaved: (id: string) => boolean;
  /** Returns false when the write failed and the race was NOT saved. */
  toggle: (id: string) => boolean;
  /** Drop every saved id that isn't in `keepIds` (races the catalog no longer lists). */
  dropMissing: (keepIds: Set<string>) => void;
  /** Non-null when local storage is unavailable, so saves cannot persist. */
  storageError: string | null;
}

const SavedContext = createContext<SavedValue | null>(null);

/**
 * Opens the store and reads the saved ids. Runs once, from a `useState` lazy
 * initializer — NOT from an effect.
 *
 * The effect version tripped `react-hooks/set-state-in-effect`: it rendered
 * once with an empty Set, then set state again on mount, so My Races painted
 * empty before it painted the real list. Reading a synchronous external store
 * during the initial render removes that second pass entirely, and removes any
 * dependence on an effect-scheduled `setState` landing — which this workspace
 * has been bitten by before under React Compiler.
 */
function loadInitial(): { ids: Set<string>; error: string | null } {
  try {
    initDb();
    return { ids: new Set(getSavedIds()), error: getStorageError() };
  } catch (e) {
    console.warn('SavedProvider init failed', e);
    return { ids: new Set(), error: e instanceof Error ? e.message : String(e) };
  }
}

export function SavedProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadInitial);
  const [savedIds, setSavedIds] = useState<Set<string>>(initial.ids);
  // Mirrors `savedIds` synchronously so `toggle` always decides add-vs-remove
  // from the latest committed value, even when two toggles fire in the same
  // tick (state updates from the second call wouldn't be visible yet through
  // the render closure). Updated in lockstep with every setSavedIds call.
  const savedIdsRef = useRef<Set<string>>(initial.ids);
  const [storageError, setStorageError] = useState<string | null>(initial.error);

  // Side effects (saveRace/removeRace) run here, in the event handler itself —
  // NOT inside the setSavedIds updater. Updater functions must be pure (React
  // can invoke them outside a normal single-commit render), and calling a
  // persistence side effect from inside one silently broke writes in the
  // production web build (verified on the Porkbun deploy: the UI toggled to
  // "Saved" — proving the updater ran — but localStorage never received the
  // write, with no thrown error). Reading from `savedIdsRef` (instead of the
  // `savedIds` render closure, which can be stale if two toggles dispatch in
  // the same tick) means `toggle` has no state dependency at all.
  //
  // The write happens FIRST, and the in-memory Set (and its ref mirror) is
  // only updated if the write actually succeeded. saveRace/removeRace now
  // return a boolean rather than void; a `false` means the persistence layer
  // (localStorage on web, SQLite on native) failed to write, and in that case
  // we must NOT flip the in-memory state — doing so would show "Saved" for a
  // race that isn't actually persisted, and it would vanish on next launch.
  const toggle = useCallback((id: string): boolean => {
    const current = savedIdsRef.current;
    const willAdd = !current.has(id);
    try {
      const ok = willAdd ? saveRace(id) : removeRace(id);
      if (!ok) {
        // Write failed — leave in-memory state untouched, and surface why.
        // Returning false lets the caller tell the user, instead of the tap
        // appearing to do nothing at all.
        setStorageError(getStorageError() ?? 'the save could not be written');
        return false;
      }
    } catch (e) {
      console.warn('toggle save failed', e);
      setStorageError(e instanceof Error ? e.message : String(e));
      return false;
    }
    const next = new Set(current);
    if (willAdd) next.add(id);
    else next.delete(id);
    savedIdsRef.current = next;
    setSavedIds(next);
    setStorageError(null);
    return true;
  }, []);

  // A saved race whose id has left the catalog (organizer pulled it, the
  // race-watch routine renamed the record) used to just vanish from My Races
  // with no explanation, while its row sat in SQLite forever. My Races now
  // says so and offers this; same write-first-then-update-memory discipline
  // as `toggle`, so a failed delete can't leave the UI claiming otherwise.
  const dropMissing = useCallback((keepIds: Set<string>) => {
    const current = savedIdsRef.current;
    const doomed = Array.from(current).filter((id) => !keepIds.has(id));
    if (doomed.length === 0) return;
    const removed: string[] = [];
    try {
      for (const id of doomed) {
        if (removeRace(id)) removed.push(id);
      }
    } catch (e) {
      console.warn('dropMissing failed', e);
      setStorageError(e instanceof Error ? e.message : String(e));
    }
    if (removed.length === 0) return;
    const next = new Set(current);
    for (const id of removed) next.delete(id);
    savedIdsRef.current = next;
    setSavedIds(next);
  }, []);

  const value = useMemo<SavedValue>(
    () => ({ savedIds, isSaved: (id) => savedIds.has(id), toggle, dropMissing, storageError }),
    [savedIds, toggle, dropMissing, storageError],
  );

  return <SavedContext.Provider value={value}>{children}</SavedContext.Provider>;
}

export function useSaved(): SavedValue {
  const ctx = useContext(SavedContext);
  if (!ctx) throw new Error('useSaved must be used within a SavedProvider');
  return ctx;
}
