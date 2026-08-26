// Stub for expo-location under Node.
//
// Same reasoning as the expo-notifications stub: the real package needs the
// Expo native module registry, so importing src/lib/tracking.ts in a test
// process fails at import time without this.
//
// Only the surface tracking.ts touches is provided, and the tests
// deliberately cover the pure exports of that module — the distance maths
// and the formatters — not the subscription plumbing. Asserting that we
// called a stub we wrote proves nothing; a wrong metre or a mis-padded
// clock is where a real bug hides.

export enum Accuracy {
  Lowest = 1,
  Low = 2,
  Balanced = 3,
  High = 4,
  Highest = 5,
  BestForNavigation = 6,
}

export interface LocationObject {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
  };
  timestamp: number;
}

export interface LocationSubscription {
  remove: () => void;
}

export async function requestForegroundPermissionsAsync() {
  return { status: 'granted' as const };
}

export async function watchPositionAsync(): Promise<LocationSubscription> {
  return { remove: () => {} };
}
