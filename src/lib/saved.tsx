// App-wide saved-races state, backed by SQLite. Loads once on mount and keeps
// an in-memory Set for fast isSaved() checks in the feed and detail screens.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { getSavedIds, initDb, removeRace, saveRace } from '@/lib/db';

interface SavedValue {
  savedIds: Set<string>;
  isSaved: (id: string) => boolean;
  toggle: (id: string) => void;
}

const SavedContext = createContext<SavedValue | null>(null);

export function SavedProvider({ children }: { children: ReactNode }) {
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // Mirrors `savedIds` synchronously so `toggle` always decides add-vs-remove
  // from the latest committed value, even when two toggles fire in the same
  // tick (state updates from the second call wouldn't be visible yet through
  // the render closure). Updated in lockstep with every setSavedIds call.
  const savedIdsRef = useRef<Set<string>>(savedIds);

  useEffect(() => {
    try {
      initDb();
      const loaded = new Set(getSavedIds());
      savedIdsRef.current = loaded;
      setSavedIds(loaded);
    } catch (e) {
      console.warn('SavedProvider init failed', e);
    }
  }, []);

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
  const toggle = useCallback((id: string) => {
    const current = savedIdsRef.current;
    const willAdd = !current.has(id);
    try {
      const ok = willAdd ? saveRace(id) : removeRace(id);
      if (!ok) return; // write failed — leave in-memory state untouched
    } catch (e) {
      console.warn('toggle save failed', e);
      return;
    }
    const next = new Set(current);
    if (willAdd) next.add(id);
    else next.delete(id);
    savedIdsRef.current = next;
    setSavedIds(next);
  }, []);

  const value = useMemo<SavedValue>(
    () => ({ savedIds, isSaved: (id) => savedIds.has(id), toggle }),
    [savedIds, toggle],
  );

  return <SavedContext.Provider value={value}>{children}</SavedContext.Provider>;
}

export function useSaved(): SavedValue {
  const ctx = useContext(SavedContext);
  if (!ctx) throw new Error('useSaved must be used within a SavedProvider');
  return ctx;
}
