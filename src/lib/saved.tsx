// App-wide saved-races state, backed by SQLite. Loads once on mount and keeps
// an in-memory Set for fast isSaved() checks in the feed and detail screens.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

  useEffect(() => {
    try {
      initDb();
      setSavedIds(new Set(getSavedIds()));
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
  // write, with no thrown error). Reading `savedIds` from the closure instead
  // of the updater's `prev` argument means `toggle` depends on `savedIds`.
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(savedIds);
      try {
        if (next.has(id)) {
          next.delete(id);
          removeRace(id);
        } else {
          next.add(id);
          saveRace(id);
        }
      } catch (e) {
        console.warn('toggle save failed', e);
      }
      setSavedIds(next);
    },
    [savedIds],
  );

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
