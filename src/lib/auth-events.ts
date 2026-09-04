// Tiny pub/sub for "the signed-in identity itself changed" — the auth-side
// twin of save-events.ts, and it exists for the same kind of confirmed
// race, one layer down.
//
// THE GAP THIS CLOSES. Every screen that shows server data (Territories,
// Leaderboard, Settings' account status) fetches with whatever
// ensureSession() hands it AT FETCH TIME, then refetches on tab focus, on
// a view toggle, or when save-events.ts says a run landed. None of those
// fire when the IDENTITY swaps underneath an already-mounted screen —
// which is exactly what account.ts's SIGN IN path does: verifyEmailAuth()
// replaces this device's local session with the account that already owns
// the email, and from that instant every previous fetch on screen is
// answering for the wrong user. Nothing about `view`, `isFocused` or
// `saveSignal` changes, so a runner who signs in from Settings and walks
// back to Territories can be shown the OLD identity's (empty) result until
// something unrelated happens to re-trigger a fetch.
//
// Deliberately narrow: subscribers get "who you are changed, refetch",
// never the session itself. A screen that needs the session already has
// ensureSession(); handing one out here would give two sources of truth
// for the same fact.
import type { Session } from '@supabase/supabase-js';

import { supabase, TERRITORY_ENABLED } from '@/lib/supabase';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * User id AND email, because both halves are a real identity change with
 * different causes and the same consequence for a mounted screen:
 *   id changes    — the SIGN IN path swapped this device onto another
 *                   account (a magic-link landing, or verifyEmailAuth).
 *   email changes — the LINK path upgraded THIS identity in place; the id
 *                   is untouched and the runs stay attached, but Settings'
 *                   account status is now wrong on screen.
 * A signed-out/absent session is '' rather than null so it compares like
 * any other value below.
 */
function identityKey(session: Session | null): string {
  if (!session) return '';
  return `${session.user.id}|${session.user.email ?? ''}`;
}

let lastKey: string | null = null;
let started = false;

/**
 * Attaches the one `onAuthStateChange` subscription this module needs.
 * Idempotent and lazy — called by onIdentityChanged rather than run at
 * import time, so a build with no Supabase configured never registers
 * anything at all.
 */
function startIdentityWatch(): void {
  if (started || !TERRITORY_ENABLED) return;
  started = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    const key = identityKey(session);
    // The FIRST event is the baseline, not a change. supabase-js emits
    // INITIAL_SESSION to every new subscriber (and, on a magic-link
    // landing, SIGNED_IN for the session it just parsed out of the URL) —
    // recording it silently is what keeps a plain page load from making
    // every subscribed screen refetch once for nothing.
    if (lastKey === null) {
      lastKey = key;
      return;
    }
    // TOKEN_REFRESHED fires on a timer and on tab visibility with the SAME
    // user; only a genuinely different identity is worth a refetch.
    if (key === lastKey) return;
    lastKey = key;
    // Deferred a tick: supabase-js documents that re-entering the client
    // from inside this callback can deadlock, and every subscriber's
    // reaction here is a fetch that routes back through ensureSession().
    setTimeout(notifyIdentityChanged, 0);
  });
}

function notifyIdentityChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Swallowed for the same reason save-events.ts swallows: one broken
      // subscriber must not stop the others from hearing about a real
      // identity swap, and must never propagate back into gotrue's own
      // event dispatch.
    }
  }
}

/**
 * Subscribes to "the identity changed". Returns an unsubscribe function so
 * a screen can register in a mount effect and clean up on unmount without
 * this module holding a stale reference — same contract as onRunSaved.
 */
export function onIdentityChanged(listener: Listener): () => void {
  startIdentityWatch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
