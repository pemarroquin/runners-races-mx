// Supabase client for Territory Mode — the only feature in this app with
// shared/server state (everything else is local-first, see races.ts/db.ts).
// See: Source Data/Outputs/Running App/Territory Mode — Feature Plan.md
//
// `react-native-get-random-values` must be imported before `@supabase/supabase-js`
// — gotrue's session/UUID generation calls crypto.getRandomValues(), which
// Hermes doesn't provide natively; without this the client throws at first
// use, not at import time, which makes it look like an auth bug.
import 'react-native-get-random-values';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session } from '@supabase/supabase-js';

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const TERRITORY_ENABLED = !!URL && !!ANON_KEY;

// `createClient` requires non-empty strings even when unused; the app must
// still start (and every other feature must still work) if these env vars
// are missing, so fall back to obvious placeholders rather than throwing at
// import time. Callers must check TERRITORY_ENABLED before using this.
export const supabase = createClient(URL || 'https://placeholder.invalid', ANON_KEY || 'placeholder', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false, // no OAuth redirect flow — irrelevant on native, and web has no callback route for it
  },
});

/**
 * Ensures a session exists and returns it — anonymous on first use (Supabase
 * persists it via AsyncStorage across restarts), or the runner's own linked
 * identity once they've attached an email (account.ts). Returns null if
 * TERRITORY_ENABLED is false or the sign-in fails (caller treats that as
 * "sync unavailable right now", not a crash — same offline-tolerant spirit
 * as the rest of the app).
 *
 * SINGLE-FLIGHT, DELIBERATELY. Every screen with its own data (Territories,
 * Leaderboard, Settings' Profile and Account pages, the Track tab's queue
 * flush) calls something in territory-sync.ts that routes through here, and
 * on a cold load / full page reload they all mount and fire their fetch
 * effects within the same tick — before any of them has awaited the async
 * AsyncStorage/localStorage read inside `getSession()`. Without
 * deduplication, EVERY one of those concurrent callers independently sees
 * "no session yet" and calls `signInAnonymously()` — confirmed live via
 * Supabase's admin API: two distinct anonymous users created in the same
 * millisecond from one real reload. `signInAnonymously()` has no
 * server-side or client-side dedup of its own; each call is a genuine new
 * signup. Whichever response resolves last is what ends up persisted as
 * "the" session — silently discarding a real, already-LINKED identity
 * (with real saved runs attached) in favour of a brand-new empty anonymous
 * one, with no error anywhere. This is what actually caused "my saved
 * territories disappeared" to keep recurring even after successfully
 * linking an email — a plain reload was enough to lose it again.
 *
 * The fix: every caller awaits the SAME in-flight promise instead of each
 * racing its own getSession()/signInAnonymously() sequence. Cleared once
 * settled (not cached forever) so a LATER call — e.g. right after
 * verifyEmailAuth() swaps in a newly-linked session — still does a fresh,
 * cheap getSession() and picks up the change, rather than being frozen on
 * whatever session existed the first time this ever ran.
 */
let sessionInFlight: Promise<Session | null> | null = null;

export async function ensureSession(): Promise<Session | null> {
  if (!TERRITORY_ENABLED) return null;
  if (sessionInFlight) return sessionInFlight;
  sessionInFlight = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session) return data.session;
      const { data: signInData, error } = await supabase.auth.signInAnonymously();
      if (error) return null;
      return signInData.session;
    } catch {
      return null;
    }
  })();
  try {
    return await sessionInFlight;
  } finally {
    sessionInFlight = null;
  }
}
