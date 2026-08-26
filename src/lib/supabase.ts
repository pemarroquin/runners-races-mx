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
 * Ensures an (anonymous) session exists and returns it. Territory Mode has no
 * accounts yet — every device gets one anonymous identity on first use, which
 * Supabase persists via AsyncStorage across restarts. Returns null if
 * TERRITORY_ENABLED is false or the sign-in fails (caller treats that as
 * "sync unavailable right now", not a crash — same offline-tolerant spirit
 * as the rest of the app).
 */
export async function ensureSession(): Promise<Session | null> {
  if (!TERRITORY_ENABLED) return null;
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session;
    const { data: signInData, error } = await supabase.auth.signInAnonymously();
    if (error) return null;
    return signInData.session;
  } catch {
    return null;
  }
}
