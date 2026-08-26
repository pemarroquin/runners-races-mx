// Stub for expo-notifications under Node.
//
// The real package pulls in the Expo runtime (which expects __DEV__ and the
// native module registry), so importing it in a test process fails before any
// test runs. Only the surface src/lib/reminders.ts touches is provided.
//
// Note that the tests deliberately cover `planRemindersFor` — the pure
// function that decides WHEN each reminder fires and what it says — and not
// the scheduling calls themselves. Asserting that we called a stub we wrote
// proves nothing; the date maths is where a real bug can hide.

export enum SchedulableTriggerInputTypes {
  DATE = 'date',
  TIME_INTERVAL = 'timeInterval',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
  CALENDAR = 'calendar',
}

export const AndroidImportance = {
  DEFAULT: 3,
  HIGH: 4,
} as const;

export function setNotificationHandler(_handler: unknown): void {}

export async function setNotificationChannelAsync(
  _id: string,
  _channel: unknown,
): Promise<null> {
  return null;
}

export async function getPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: false };
}

export async function requestPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: false };
}

export async function getAllScheduledNotificationsAsync(): Promise<unknown[]> {
  return [];
}

export async function scheduleNotificationAsync(_request: unknown): Promise<string> {
  return 'stub-notification-id';
}

export async function cancelScheduledNotificationAsync(_id: string): Promise<void> {}

export async function cancelAllScheduledNotificationsAsync(): Promise<void> {}
