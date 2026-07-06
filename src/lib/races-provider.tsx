// Refreshes race data from the agent-maintained remote copy on app launch and
// re-renders consumers when fresh data lands (bundled seed until then).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { refreshRaces } from '@/lib/races';

const RacesContext = createContext<number>(0);

export function RacesProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    refreshRaces().then((updated) => {
      if (alive && updated) setVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  return <RacesContext.Provider value={version}>{children}</RacesContext.Provider>;
}

/** Bumps when remote data replaces the bundled seed — use as a memo dep. */
export function useRacesVersion(): number {
  return useContext(RacesContext);
}
