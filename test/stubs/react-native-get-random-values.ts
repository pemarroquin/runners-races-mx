// Stub for react-native-get-random-values under Node.
//
// The real package's index.js does `require('react-native')` at module load
// to reach `NativeModules`, which pulls in the actual (Flow-typed) RN source
// even with the `react-native` alias in place — vitest.config.ts's other
// native-module aliases (expo-sqlite, expo-notifications, ...) exist for the
// identical reason. It's imported purely for its global.crypto.getRandomValues
// side effect (supabase.ts), which Node already provides natively, so an
// empty module satisfies every caller.
export {};
