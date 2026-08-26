// Turning a race's local start time into a real instant, for calendar events.
//
// The calendar event used to be built with `new Date(y, m - 1, d, hh, mm)`,
// which is the PHONE's local time. Mexico is not one time zone, so a runner in
// Tijuana adding a Cancún race got an event two hours off — and since the
// event carried no `timeZone` either, travelling before the race shifted it
// again.
//
// Deliberately no `Intl.DateTimeFormat(..., { timeZone })` to resolve offsets:
// Intl support varies across Hermes builds and platforms, which is the same
// portability trap `isSafeUrl` and `foldForSearch` already avoid. Mexico's
// zones are few and, since the 2022 reform, almost all fixed — so an explicit
// offset table is both smaller and more predictable than depending on the
// engine's zone database.

/** IANA zone name — what the calendar stores so the event survives travel. */
export type MexicanTimeZone =
  | 'America/Mexico_City'
  | 'America/Cancun'
  | 'America/Chihuahua'
  | 'America/Tijuana';

// Only states that differ from the UTC-6 bloc need an entry. Post-2022:
// Quintana Roo is UTC-5 year-round; Baja California is the one state that
// still observes DST (it follows US Pacific rules); Chihuahua settled on
// UTC-6. Everything else — CDMX, Nuevo León, Jalisco, Yucatán, Puebla,
// Querétaro, Guanajuato, San Luis Potosí, Coahuila, Estado de México — is
// UTC-6 with no DST.
const STATE_TIME_ZONES: Record<string, MexicanTimeZone> = {
  'Baja California': 'America/Tijuana',
  'Quintana Roo': 'America/Cancun',
  Chihuahua: 'America/Chihuahua',
};

const DEFAULT_TIME_ZONE: MexicanTimeZone = 'America/Mexico_City';

/** IANA time zone for a race's state — the zone its start time is quoted in. */
export function timeZoneForState(state: string): MexicanTimeZone {
  return STATE_TIME_ZONES[state] ?? DEFAULT_TIME_ZONE;
}

/** Day-of-month of the `n`th Sunday of a month (1-indexed month). */
function nthSunday(year: number, month: number, n: number): number {
  // Date.UTC avoids the local-zone shift that `new Date(y, m, d)` would apply
  // — this is pure calendar arithmetic, not an instant.
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return firstSunday + (n - 1) * 7;
}

/**
 * US daylight-saving rule (second Sunday of March → first Sunday of November),
 * which Baja California follows. Evaluated at day granularity: the transition
 * happens at 02:00 local and no race starts then, so the hour is irrelevant.
 */
function isUsDst(year: number, month: number, day: number): boolean {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  if (month === 3) return day >= nthSunday(year, 3, 2);
  return day < nthSunday(year, 11, 1);
}

/** Hours WEST of UTC for a zone on a given calendar date (6 => UTC-6). */
function utcOffsetHours(zone: MexicanTimeZone, y: number, m: number, d: number): number {
  switch (zone) {
    case 'America/Cancun':
      return 5;
    case 'America/Tijuana':
      return isUsDst(y, m, d) ? 7 : 8;
    case 'America/Chihuahua':
    case 'America/Mexico_City':
      return 6;
  }
}

/**
 * The absolute instant of `HH:MM` on `YYYY-MM-DD` **in the race's own zone**,
 * regardless of where the phone is.
 *
 * @param dateStr `YYYY-MM-DD`
 * @param timeStr `HH:MM`
 */
export function instantInZone(dateStr: string, timeStr: string, zone: MexicanTimeZone): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const offset = utcOffsetHours(zone, y, m, d);
  // Local wall-clock time converted to UTC by ADDING the westward offset:
  // 07:00 at UTC-6 is 13:00 UTC.
  return new Date(Date.UTC(y, m - 1, d, hh + offset, mm));
}
