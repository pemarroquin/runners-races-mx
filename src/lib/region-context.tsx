// Current-region state. First launch (no stored pref): auto-detect via GPS
// (permission prompt) → IP fallback → default (Monterrey). Manual choice from
// the city picker always wins and is persisted.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { getPref, initDb, setPref } from '@/lib/db';
import { detectRegion, type DetectMethod } from '@/lib/location';
import { DEFAULT_REGION_ID, getRegion, type Region } from '@/lib/regions';

const PREF_KEY = 'regionId';
const PREF_METHOD = 'regionMethod';

/** How the current region was set — drives the "location in use" signifier. */
export type RegionMethod = 'gps' | 'ip' | 'manual';

interface RegionValue {
  region: Region;
  method: RegionMethod | null;
  setRegionId: (id: string, method?: RegionMethod) => void;
  /** Re-run GPS→IP detection (used by the picker's "use my location" row). */
  detect: () => Promise<DetectMethod>;
  detecting: boolean;
}

const RegionContext = createContext<RegionValue | null>(null);

export function RegionProvider({ children }: { children: ReactNode }) {
  const [regionId, setRegionIdState] = useState<string>(DEFAULT_REGION_ID);
  const [method, setMethodState] = useState<RegionMethod | null>(null);
  const [detecting, setDetecting] = useState(false);

  const setRegionId = useCallback((id: string, m: RegionMethod = 'manual') => {
    setRegionIdState(id);
    setMethodState(m);
    try {
      setPref(PREF_KEY, id);
      setPref(PREF_METHOD, m);
    } catch (e) {
      console.warn('persist region failed', e);
    }
  }, []);

  const detect = useCallback(async (): Promise<DetectMethod> => {
    setDetecting(true);
    try {
      const { region, method: m } = await detectRegion();
      if (region && (m === 'gps' || m === 'ip')) setRegionId(region.id, m);
      return m;
    } finally {
      setDetecting(false);
    }
  }, [setRegionId]);

  useEffect(() => {
    let stored: string | null = null;
    let storedMethod: string | null = null;
    try {
      initDb(); // idempotent — removes any provider-ordering dependency
      stored = getPref(PREF_KEY);
      storedMethod = getPref(PREF_METHOD);
    } catch (e) {
      console.warn('read region pref failed', e);
    }
    if (stored) {
      setRegionIdState(stored);
      if (storedMethod === 'gps' || storedMethod === 'ip' || storedMethod === 'manual') {
        setMethodState(storedMethod);
      }
    } else {
      // First launch: detect (GPS prompt → IP), keep default if both fail.
      detect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<RegionValue>(
    () => ({ region: getRegion(regionId), method, setRegionId, detect, detecting }),
    [regionId, method, setRegionId, detect, detecting],
  );

  return <RegionContext.Provider value={value}>{children}</RegionContext.Provider>;
}

export function useRegion(): RegionValue {
  const ctx = useContext(RegionContext);
  if (!ctx) throw new Error('useRegion must be used within a RegionProvider');
  return ctx;
}
