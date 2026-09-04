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
// Web only in practice — detectSessionInUrl is a no-op without a `window`
// (checked internally by supabase-js), so this has zero effect on native.
// Was `false` because nothing consumed a redirect: account.ts's email
// link/sign-in flow only ever confirmed via a typed 6-digit code, never a
// clicked link. That's no longer true — Supabase's own hosted email
// templates cannot be edited to show a code without paid custom SMTP (a
// dashboard-enforced limit, not something this app controls), so the
// email a runner actually receives is a link. `true` lets the client
// itself finish what that link starts: parse the session out of the
// redirect's URL fragment on load. See emailLinkType below for how the UI
// knows this just happened.
export const supabase = createClient(URL || 'https://placeholder.invalid', ANON_KEY || 'placeholder', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

/**
 * Which Supabase auth flow (if any) this page load's URL fragment carries —
 * `#access_token=...&type=magiclink` etc. Read ONCE, synchronously, at
 * module load — before the client's own async detectSessionInUrl work has
 * a chance to parse and strip the fragment (supabase-js does that inside
 * an awaited _initialize(), not synchronously at construction), so there
 * is no race between "did the client already consume this" and "did we
 * still see it." `null` on native (no `window`) and on any normal load
 * that isn't a redirect landing.
 *
 * `type` distinguishes two real UX cases the caller (email-link-banner.tsx)
 * needs to tell apart:
 *   'signup' | 'email_change' — the LINK path (account.ts's startEmailAuth
 *     tried updateUser first): this device's own identity just got an
 *     email attached in place. Nothing lost.
 *   'magiclink' — the SIGN-IN path (the email already belonged to another
 *     account): completing it REPLACES this device's local session
 *     outright. Unlike the in-app code-entry flow, which can warn BEFORE
 *     committing (account-link.tsx's accountSwitchWarning), a link click
 *     already finished the swap by the time this code runs — there is no
 *     "before" to warn at. The banner can only disclose it after the fact.
 */
export const emailLinkType: string | null = (() => {
  if (typeof window === 'undefined' || !window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.get('access_token')) return null;
  return params.get('type');
})();

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
