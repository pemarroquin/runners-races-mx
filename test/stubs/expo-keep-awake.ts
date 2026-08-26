// Stub for expo-keep-awake under Node.
//
// Same reasoning as the other stubs here: the real package imports
// expo-modules-core, which expects __DEV__ and the Expo runtime, so
// importing src/lib/tracking.ts in a test process fails at import time.
//
// The tests cover that module's pure exports (distance maths, formatters),
// not the screen-wake calls — asserting that we invoked a stub we wrote
// proves nothing.

export async function activateKeepAwakeAsync(_tag?: string): Promise<void> {}
export function deactivateKeepAwake(_tag?: string): void {}
