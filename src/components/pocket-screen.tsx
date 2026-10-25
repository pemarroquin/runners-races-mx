// Native no-op. The pocket screen exists for the web build, where the wake
// lock keeps the screen on for the whole run and the Mapbox map keeps
// drawing under it — see use-pocket-screen.ts for the reasoning, and
// pocket-screen.web.tsx for the real implementation (Metro resolves that
// file on web).
export interface PocketScreenProps {
  time: string;
  distance: string;
  hint: string;
  /** A GPS problem worth seeing on a glance, or null. */
  warning: string | null;
  /** Seconds into the run; drifts the readout so no pixel stays lit for
   *  hours (OLED burn-in). */
  elapsedS: number;
  onWake: () => void;
}

export function PocketScreen(_props: PocketScreenProps) {
  return null;
}
