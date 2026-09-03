// Anonymous -> permanent account linking, via email OTP. Territory Mode has
// shipped since Phase 1 on a purely anonymous, device-local identity (see
// supabase.ts's ensureSession) — settings.tsx used to say plainly "no
// sign-in yet" and warn that clearing the device loses the account. That
// tradeoff bit for real on 2026-09-03: a desktop Chrome window held a THIRD
// anonymous identity that had never uploaded anything, while 6 real saved
// runs sat under two OTHER anonymous ids with no way back in — "same
// browser" is not one identity store; a new profile/window, or storage
// getting cleared, silently mints a fresh one. This file is the fix: an
// opt-in way to attach a real email to whichever identity the runner is
// currently signed in as, so it survives a lost/cleared session and can be
// picked back up on any other device by signing in with that same email.
//
// Two distinct flows share one entry point (startEmailAuth) because the
// runner shouldn't have to know in advance which one applies:
//   LINK    — this session is anonymous and the email is unclaimed.
//             Upgrades THIS identity in place (supabase.auth.updateUser) —
//             same user_id, so every run already saved under it stays
//             attached. No data migration needed or attempted.
//   SIGN IN — the email already belongs to a different (earlier-linked)
//             account, e.g. this is a second device/browser. Sends a
//             sign-in code for THAT account instead (supabase.auth.
//             signInWithOtp) — completing it REPLACES this session's local
//             identity with the existing permanent one. If this device's
//             local anonymous identity had any runs of its own, they are
//             simply left behind under the old id (same "not recoverable"
//             shape as any other abandoned anonymous session) — the UI is
//             responsible for warning about that before switching, this
//             module just reports which flow ran.
// Both branches use email OTP codes, never a magic-link click — the app has
// no deep-link/callback route to land on, and a 6-digit code works
// identically on web and native.
import { supabase, TERRITORY_ENABLED } from '@/lib/supabase';
import { withSession } from '@/lib/territory-sync';

export type AccountStatus = { linked: true; email: string } | { linked: false };

export type AccountStatusOutcome =
  | { ok: true; status: AccountStatus }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' };

/** Whether THIS session already has a permanent email attached. An
 *  anonymous Supabase session carries `user.email` as null/undefined; a
 *  linked or signed-in one carries the real address. */
export async function fetchAccountStatus(): Promise<AccountStatusOutcome> {
  return withSession<{ status: AccountStatus }>(async (session) => {
    const email = session.user.email;
    return { ok: true, status: email ? { linked: true, email } : { linked: false } };
  });
}

// Same pragmatic check the rest of the app uses for "good enough to submit,
// real validation happens server-side" — not a full RFC 5322 parser.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type StartEmailAuthOutcome =
  | { ok: true; mode: 'link' | 'signin' }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'invalid' };

/**
 * Step 1 of either flow — sends a 6-digit code to `email` and reports which
 * flow it actually is, so the caller (account-link.tsx) knows what to pass
 * back into verifyEmailAuth. Tries LINK first (claims the email for this
 * session); Supabase's updateUser only fails that way when the email is
 * already registered to someone else, which is exactly the signal to fall
 * back to SIGN IN instead.
 */
export async function startEmailAuth(email: string): Promise<StartEmailAuthOutcome> {
  if (!EMAIL_PATTERN.test(email)) {
    // No network round trip (and no OTP-send rate-limit spent) for an
    // obviously bad address — same reasoning as validating client-side
    // before a paid/rate-limited call anywhere else in this codebase.
    if (!TERRITORY_ENABLED) return { ok: false, reason: 'disabled' };
    return { ok: false, reason: 'invalid' };
  }

  return withSession<{ mode: 'link' | 'signin' }>(async () => {
    const { error: linkError } = await supabase.auth.updateUser({ email });
    if (!linkError) return { ok: true, mode: 'link' };

    // GoTrue's wording for "this email belongs to another account" has
    // shifted across versions ("already registered", "already exists",
    // "already been taken") — matched loosely rather than pinned to one
    // exact string, which would silently stop catching this the moment the
    // message text changes again. Any OTHER updateUser failure (rate limit,
    // rejected address, network) is a real failure, not a signal to switch
    // flows, and must surface as one rather than being swallowed here.
    const inUse = /already|registered|exists|taken/i.test(linkError.message);
    if (!inUse) return { ok: false, reason: 'network' };

    const { error: signInError } = await supabase.auth.signInWithOtp({ email });
    if (signInError) return { ok: false, reason: 'network' };
    return { ok: true, mode: 'signin' };
  });
}

export type VerifyEmailAuthOutcome =
  | { ok: true; email: string }
  | { ok: false; reason: 'disabled' | 'auth' | 'network' | 'invalid' };

/**
 * Step 2 — confirms the code from startEmailAuth. `mode` must be whatever
 * startEmailAuth returned for this email; the two flows are confirmed
 * against different GoTrue OTP types (`email_change` for an in-place link,
 * `email` for a sign-in) — confirming with the wrong one fails even for an
 * otherwise-correct code.
 */
export async function verifyEmailAuth(
  email: string,
  token: string,
  mode: 'link' | 'signin',
): Promise<VerifyEmailAuthOutcome> {
  return withSession<{ email: string }, 'invalid'>(async () => {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: mode === 'link' ? 'email_change' : 'email',
    });
    // A wrong/expired code reports as 'invalid' (form stays up, retry makes
    // sense) rather than 'network' (which the UI would read as "try
    // again blindly") — same "tell the runner what actually happened"
    // reasoning as territory-sync.ts's deleteRun 'denied' reason.
    if (error) return { ok: false, reason: 'invalid' };
    // verifyOtp's response carries the confirmed session for a 'signin'
    // (this replaces the client's stored session outright); for 'link' the
    // session is the same identity with its email now attached. Either way
    // read the email back from whatever the call actually returned rather
    // than echoing the input — data.session is the primary source, data.user
    // is the fallback GoTrue uses for some email_change responses.
    const confirmedEmail = data.session?.user.email ?? data.user?.email ?? null;
    if (!confirmedEmail) return { ok: false, reason: 'network' };
    return { ok: true, email: confirmedEmail };
  });
}
