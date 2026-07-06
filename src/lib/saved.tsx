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

  const toggle = useCallback((id: string) => {
    setSavedIds((prev) => {
      const next = new Set(prev);
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
      return next;
    });
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
