#!/usr/bin/env node
// Fails loudly (non-zero exit) if any EXPO_PUBLIC_* var the web build reads
// is missing from the environment. Run this BEFORE `expo export -p web` in
// deploy.yml — without it, a missing var still builds a bundle that
// COMPILES fine and ships a feature silently dead at runtime.
//
// That is not hypothetical: on 2026-08-31, production shipped with
// EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY absent from
// deploy.yml's secrets. Nothing in the app was wrong — src/lib/supabase.ts
// detected the missing config exactly as designed (TERRITORY_ENABLED =
// false) and territory-sync.ts reported it honestly ({ok:false,
// reason:'disabled'}). Every save just silently failed in production while
// tsc/lint/test/export all stayed green, because none of those check what
// actually shipped.
//
// This list is a plain array, not auto-derived from src/ — these vars are
// read inline via `process.env.EXPO_PUBLIC_*` (see src/lib/supabase.ts,
// src/lib/mapbox.ts), which Expo's bundler inlines at build time; a plain
// Node script has no clean way to import that without a TS build step of
// its own. Keep this list in sync by hand — the source of truth to diff it
// against is:
//   grep -rhoE "process\.env\.EXPO_PUBLIC_[A-Z_]+" src/ | sort -u
const REQUIRED = [
  'EXPO_PUBLIC_MAPBOX_TOKEN',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
];

const missing = REQUIRED.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error('[check-web-env] Missing required environment variable(s) for the web build:');
  for (const name of missing) console.error(`  - ${name}`);
  console.error(
    '\nThe export will still compile without these — the app degrades silently instead of ' +
      'crashing (that degrade-instead-of-crash behaviour is correct and deliberate; shipping ' +
      "without the var in the first place is the bug). Set them before building, in the repo's " +
      'Actions secrets for CI or .env.local for a local build, never after.',
  );
  process.exit(1);
}

console.log(`[check-web-env] All ${REQUIRED.length} required env vars are set.`);
