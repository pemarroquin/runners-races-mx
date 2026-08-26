// Current-region state. First launch (no stored pref): auto-detect via GPS
// (permission prompt) → IP fallback → default (Monterrey). Manual choice from
// the city picker always wins and is persisted.
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
  /** Allow detection to override an earlier manual pick — call before `detect`. */
  clearManualPick: () => void;
  detecting: boolean;
}

const RegionContext = createContext<RegionValue | null>(null);

/**
 * The persisted region, read synchronously from a `useState` lazy
 * initializer rather than an effect — same reason as SavedProvider and
 * LocaleProvider: the effect version painted the default region (Monterrey)
 * first and corrected it on mount, so anyone with a stored city saw a frame
 * of the wrong feed. It also tripped `react-hooks/set-state-in-effect`, which
 * matters with `reactCompiler` on.
 *
 * `attempted` records whether first-launch auto-detection has already run, so
 * a denial or an offline device doesn't re-prompt (and re-hit ipapi.co) on
 * every cold start.
 */
function loadInitialRegion(): {
  regionId: string;
  method: RegionMethod | null;
  attempted: boolean;
} {
  try {
    initDb(); // idempotent — removes any provider-ordering dependency
    const stored = getPref(PREF_KEY);
    const storedMethod = getPref(PREF_METHOD);
    const attempted = getPref(PREF_DETECT_ATTEMPTED) === '1';
    const method =
      storedMethod === 'gps' || storedMethod === 'ip' || storedMethod === 'manual'
        ? storedMethod
        : null;
    return { regionId: stored ?? DEFAULT_REGION_ID, method: stored ? method : null, attempted };
  } catch (e) {
    console.warn('read region pref failed', e);
    return { regionId: DEFAULT_REGION_ID, method: null, attempted: false };
  }
}

export function RegionProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadInitialRegion);
  const [regionId, setRegionIdState] = useState<string>(initial.regionId);
  const [method, setMethodState] = useState<RegionMethod | null>(initial.method);
  const [detecting, setDetecting] = useState(false);

  // Set once the user picks a city by hand. First-launch detection runs GPS
  // (up to 10s) then IP (up to 8s), so there is an ~18-second window in which
  // someone can open the picker, choose a city, and then have the detection
  // result land on top of their choice. A manual pick always wins.
  const manualPickRef = useRef(false);

  const setRegionId = useCallback((id: string, m: RegionMethod = 'manual') => {
    if (m === 'manual') manualPickRef.current = true;
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
      // The guard is checked AFTER the await, not before: the whole point is
      // a choice made while this was in flight. (The picker's own "use my
      // location" button clears the flag first — see useMyLocation there —
      // since that IS the user asking for detection.)
      if (manualPickRef.current) return m;
      if (region && (m === 'gps' || m === 'ip')) setRegionId(region.id, m);
      return m;
    } finally {
      setDetecting(false);
    }
  }, [setRegionId]);

  /** Lets the picker's explicit "use my location" override a prior manual pick. */
  const clearManualPick = useCallback(() => {
    manualPickRef.current = false;
  }, []);

  // The stored region is already in state (see loadInitialRegion). All this
  // effect does is the first-launch detection — which is a genuine external
  // side effect, correctly placed in an effect and carrying no synchronous
  // setState of its own.
  useEffect(() => {
    const hasStoredRegion = initial.method !== null || initial.regionId !== DEFAULT_REGION_ID;
    if (hasStoredRegion || initial.attempted) return;
    // First launch, never attempted before: detect (GPS prompt → IP), keep
    // the default if both fail. Record the attempt regardless of outcome so a
    // denial/offline result doesn't re-prompt on every cold start — the
    // picker's "use my location" button can still always retry.
    // Deferred a tick rather than called inline: detect() flips `detecting`
    // synchronously, which inside an effect body is a cascading render (and
    // the rule that catches it is live — `reactCompiler` is on). Deferring
    // also keeps the OS location prompt from firing in the same frame the app
    // is painting its first screen, which is better anyway.
    const timer = setTimeout(() => {
      detect().finally(() => {
        try {
          setPref(PREF_DETECT_ATTEMPTED, '1');
        } catch (e) {
          console.warn('persist region-detect-attempted failed', e);
        }
      });
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<RegionValue>(
    () => ({ region: getRegion(regionId), method, setRegionId, detect, clearManualPick, detecting }),
    [regionId, method, setRegionId, detect, clearManualPick, detecting],
  );

  return <RegionContext.Provider value={value}>{children}</RegionContext.Provider>;
}

export function useRegion(): RegionValue {
  const ctx = useContext(RegionContext);
  if (!ctx) throw new Error('useRegion must be used within a RegionProvider');
  return ctx;
}
