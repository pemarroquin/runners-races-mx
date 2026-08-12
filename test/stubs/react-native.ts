// Stub for react-native under Node.
//
// src/lib/reminders.ts imports `Platform` to skip web and to register the
// Android notification channel. Importing the real react-native in a Node
// process fails (Flow-typed source, native module registry), and the tested
// logic doesn't depend on it — so this provides just `Platform`.
//
// Reported as 'ios' because that is the branch the pure planning code runs
// under: not web (so nothing early-returns) and not android (so no channel
// registration is attempted at import time).

export const Platform = {
  OS: 'ios' as const,
  select: <T,>(spec: { ios?: T; android?: T; web?: T; default?: T }): T | undefined =>
    spec.ios ?? spec.default,
};
