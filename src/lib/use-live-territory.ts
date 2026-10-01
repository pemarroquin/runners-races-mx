// Refetch a board when someone claims ground in its arena — see
// live-territory.ts. Subscribed ONLY while `active` (the screen is on top):
// tabs never unmount, and a socket plus refetches behind a hidden tab is the
// background work the heat audit removed.
import { useEffect, useRef } from 'react';

import { refetchDelay, subscribeClaims, touchesArena } from '@/lib/live-territory';

export function useLiveTerritory({
  active,
  districts,
  onChange,
}: {
  active: boolean;
  districts: string[] | null;
  onChange: () => void;
}) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!active || !districts || districts.length === 0) return;
    let last: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeClaims((payload) => {
      if (timer !== null || !touchesArena(payload, districts)) return;
      // Coalesces a burst into one refetch, spaced from the last.
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        onChangeRef.current();
      }, refetchDelay(last, Date.now()));
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [active, districts]);
}
