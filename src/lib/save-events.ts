// Tiny pub/sub for "a run just landed on the server" — exists to close a
// confirmed race, not as general-purpose infrastructure. See
// myraces.tsx's Territories fetch effect for the consumer, and index.tsx's
// save() / the queue-drain effect for the two producers.
//
// THE RACE THIS CLOSES. myraces.tsx already refetches on tab focus AND on
// view change, which is more than leaderboard.tsx does — but a runner can
// reach the Territories tab before the autosave that index.tsx kicks off
// the instant a run finishes (before the summary screen's checkmark is even
// tapped) has finished its network round trip. Focus/view haven't changed
// again by the time the upload actually lands, so nothing re-triggers a
// fetch and the runner is left on a stale empty map with no signal anything
// is wrong. Same mechanism a second way: a run that failed and got queued
// (upload-queue.ts) can be promoted to saved by a later background flush
// while the runner is already sitting on the Territories screen, and that
// flush's own component may by then be stale (the runner left the Track
// tab) — the upload still genuinely happened, so it still has to notify.
//
// A module-level counter + listener list, not useSyncExternalStore or an
// event-emitter dependency: this codebase favours small pure modules over
// abstraction (see pilot-instrumentation.ts, upload-queue.ts), and every
// subscriber here needs is "something changed, refetch" — not the payload.
type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Call the moment a run is durably saved server-side — a fresh autosave
 * success, a queued run promoted by a background flush, or a manual retry.
 * Fire-and-forget and never throws: a bug in one subscriber must not corrupt
 * or interrupt the save path reporting on it.
 */
export function notifyRunSaved(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Swallowed deliberately — see the file header. One broken subscriber
      // must not stop the others from hearing about a real save, and must
      // never propagate back into the save/upload call site.
    }
  }
}

/**
 * Subscribes to "a run was saved somewhere". Returns an unsubscribe
 * function so a screen can register in a mount effect and clean up on
 * unmount without this module holding a stale reference.
 */
export function onRunSaved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
