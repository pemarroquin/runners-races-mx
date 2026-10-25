// The black "pocket" screen shown while a run records untouched — see
// use-pocket-screen.ts for why it exists (a run that drained the phone).
//
// Portalled to <body> with position: fixed, not rendered inside the Track
// screen: the floating tab bar is drawn by the Tabs navigator OUTSIDE the
// screen, so an in-screen overlay would leave it lit and tappable.
//
// Plain DOM, like track-map.web.tsx's markers: it is a few lines of text on
// black, and every lit pixel costs power on an OLED panel, so the text is
// dim grey and small apart from the clock. Tapping anywhere wakes the map —
// on click (finger up), never pointerdown; see use-pocket-screen.ts.
import { createPortal } from 'react-dom';

import type { PocketScreenProps } from './pocket-screen';

export type { PocketScreenProps } from './pocket-screen';

// Dim on purpose: readable in a glance outdoors, but far from white.
const DIM = '#8a8a8a';
const DIMMER = '#5c5c5c';
const WARN = '#b8913a';
// How far the readout wanders (px), one step per minute, so the same pixels
// are never lit for the whole of a long run.
const DRIFT_PX = 8;
const DRIFT_STEPS = 6;

export function PocketScreen({ time, distance, hint, warning, elapsedS, onWake }: PocketScreenProps) {
  if (typeof document === 'undefined') return null;
  const step = Math.floor(elapsedS / 60) % DRIFT_STEPS;
  const dx = ((step % 3) - 1) * DRIFT_PX;
  const dy = (Math.floor(step / 3) * 2 - 1) * DRIFT_PX;
  return createPortal(
    <div
      role="button"
      aria-label={hint}
      onClick={onWake}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        touchAction: 'manipulation',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        cursor: 'pointer',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
      <div style={{ transform: `translate(${dx}px, ${dy}px)`, textAlign: 'center' }}>
        <div style={{ color: DIM, fontSize: 56, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {time}
        </div>
        <div style={{ color: DIM, fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {distance}
        </div>
        {warning && (
          <div style={{ color: WARN, fontSize: 14, fontWeight: 600, marginTop: 12, maxWidth: 280 }}>
            {warning}
          </div>
        )}
        <div style={{ color: DIMMER, fontSize: 13, marginTop: 28, maxWidth: 260 }}>{hint}</div>
      </div>
    </div>,
    document.body,
  );
}
