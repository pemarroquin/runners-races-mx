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
// Records that a first-launch AUTOMATIC detection was attempted, regardless
// of outcome, so a denied permission or an offline device doesn't re-prompt
// (and re-hit ipapi.co) on every cold start. Only gates the silent
// first-launch attempt below — the picker's "use my location" button always
// calls detect() directly and bypasses this.
const PREF_DETECT_ATTEMPTED = 'regionDetectAttempted';

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
    let attempted: string | null = null;
    try {
      initDb(); // idempotent — removes any provider-ordering dependency
      stored = getPref(PREF_KEY);
      storedMethod = getPref(PREF_METHOD);
      attempted = getPref(PREF_DETECT_ATTEMPTED);
    } catch (e) {
      console.warn('read region pref failed', e);
    }
    if (stored) {
      setRegionIdState(stored);
      if (storedMethod === 'gps' || storedMethod === 'ip' || storedMethod === 'manual') {
        setMethodState(storedMethod);
      }
    } else if (attempted !== '1') {
      // First launch, never attempted before: detect (GPS prompt → IP),
      // keep default if both fail. Record the attempt regardless of outcome
      // so a denial/offline result doesn't re-prompt on every cold start —
      // the picker's "use my location" button can still always retry.
      detect().finally(() => {
        try {
          setPref(PREF_DETECT_ATTEMPTED, '1');
        } catch (e) {
          console.warn('persist region-detect-attempted failed', e);
        }
      });
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
