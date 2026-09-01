// Unit tests for the pure logic in src/lib — the date maths, the search fold,
// the URL allowlist, the record validator, the region/timezone lookups.
//
// Scope is deliberately "functions with no React and no native modules". This
// project has no test runner for components: rendering React Native needs a
// preset (jest-expo) and a native module mock surface far larger than the
// value it would add here, and the real UI verification path for this app is
// Expo Go on a device. What these cover is exactly the code where a silent
// wrong answer is possible — a countdown off by one at a DST boundary, an
// accent that stops matching, a race dropped by the validator.
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      // Mirrors tsconfig.json's paths. The assets rule must come first —
      // "@/assets/..." also matches the "@/" prefix, and the first matching
      // alias wins.
      { find: /^@\/assets\/(.*)$/, replacement: path.resolve(__dirname, 'assets/$1') },
      // src/lib/races.ts imports the SQLite-backed prefs store for its cache
      // helpers. expo-sqlite is a native module with no Node build, so it is
      // swapped for an in-memory stand-in that satisfies the same contract.
      { find: /^expo-sqlite$/, replacement: path.resolve(__dirname, 'test/stubs/expo-sqlite.ts') },
      // Same reasoning for the reminder scheduler's dependencies: the real
      // packages boot the Expo runtime / react-native module registry, which
      // cannot run in a plain Node process.
      {
        find: /^expo-notifications$/,
        replacement: path.resolve(__dirname, 'test/stubs/expo-notifications.ts'),
      },
      // Territory Mode's run tracker (src/lib/tracking.ts) owns the
      // expo-location subscription and holds the screen awake; the pure
      // distance maths and formatters it also exports are what the tests
      // actually cover.
      {
        find: /^expo-location$/,
        replacement: path.resolve(__dirname, 'test/stubs/expo-location.ts'),
      },
      {
        find: /^expo-keep-awake$/,
        replacement: path.resolve(__dirname, 'test/stubs/expo-keep-awake.ts'),
      },
      // supabase.ts imports this before @supabase/supabase-js purely for its
      // global.crypto.getRandomValues side effect; its real index.js does
      // `require('react-native')` for NativeModules, which drags in the
      // actual Flow-typed RN source (the react-native alias below doesn't
      // reach a nested CJS require the same way) — same native-module
      // problem the other stubs above solve.
      {
        find: /^react-native-get-random-values$/,
        replacement: path.resolve(__dirname, 'test/stubs/react-native-get-random-values.ts'),
      },
      { find: /^react-native$/, replacement: path.resolve(__dirname, 'test/stubs/react-native.ts') },
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, 'src/$1') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // mapbox.ts reads EXPO_PUBLIC_MAPBOX_TOKEN at module load and returns
    // null from every URL builder when it's unset — a real token isn't
    // needed to test the URL shape, just a truthy one.
    env: { EXPO_PUBLIC_MAPBOX_TOKEN: 'pk.test-token' },
  },
});
